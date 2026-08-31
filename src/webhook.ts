import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from './shared/config.js';
import { getCampaign, listCampaigns, updateBumps, updateCampaign, setReanalysing, clearReanalysing } from './tools/firestore/client.js';
import { getPRCIStatus, commentOnPR, getCIFailureLogs } from './tools/github/ci.js';
import { getInstallationOctokit } from './tools/github/client.js';
import { classifyBump, reanalyseWithCIErrors } from './agents/safety/index.js';
import type { Campaign, PlannedBump } from './shared/types.js';
import { applyFixFlow } from './agents/coder/apply-fix.js';

const MAX_FIX_ATTEMPTS = 5;
const FIXING_WAIT_INTERVAL = 10_000;
const FIXING_MAX_WAIT = 5 * 60_000;

async function getBranchCommitHistory(owner: string, repo: string, branch: string, limit = 10): Promise<string> {
  try {
    const octokit = await getInstallationOctokit();
    const { data } = await octokit.rest.repos.listCommits({ owner, repo, sha: branch, per_page: limit });
    return data.map((c) => `- ${c.sha.slice(0, 7)}: ${c.commit.message.split('\n')[0]}`).join('\n');
  } catch {
    return '';
  }
}

export async function webhookHandler(req: Request, res: Response): Promise<void> {
  const event = req.headers['x-github-event'] as string;
  console.log(`Webhook received: ${event} / ${req.body?.action ?? 'no action'}`);

  if (!verifySignature(req)) {
    res.status(401).send('Invalid signature');
    return;
  }

  if (event !== 'check_suite' && event !== 'check_run') {
    res.status(200).send('Ignored');
    return;
  }

  const payload = req.body;
  if (payload.action !== 'completed') {
    res.status(200).send('Ignored');
    return;
  }

  const repo = payload.repository;
  const owner = repo.owner.login as string;
  const repoName = repo.name as string;

  const suiteOrRun = event === 'check_suite' ? payload.check_suite : payload.check_run;
  const webhookSha = suiteOrRun.head_sha as string;
  const branches: string[] = (suiteOrRun.pull_requests ?? []).map((pr: any) => pr.head.ref as string);

  if (branches.length === 0) {
    res.status(200).send('No PR branches');
    return;
  }

  res.status(200).send('Processing');

  handleCICompletion(owner, repoName, branches, webhookSha).catch((err) =>
    console.error('Webhook handler error:', err),
  );
}

async function waitForFixCompletion(campaignId: string, packageName: string): Promise<PlannedBump | null> {
  const deadline = Date.now() + FIXING_MAX_WAIT;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, FIXING_WAIT_INTERVAL));
    const campaign = await getCampaign(campaignId);
    if (!campaign) return null;
    const bump = campaign.plan.find((b) => b.packageName === packageName);
    if (!bump) return null;
    if (!bump.findings?.some((f) => f.fixStatus === 'coding')) return bump;
  }

  const campaign = await getCampaign(campaignId);
  if (campaign) {
    const bump = campaign.plan.find((b) => b.packageName === packageName);
    if (bump?.findings?.some((f) => f.fixStatus === 'coding')) {
      const cleaned = bump.findings.map((f) =>
        f.fixStatus === 'coding' ? { ...f, fixStatus: undefined } : f,
      );
      await updateBumps(campaignId, [{ packageName, fields: { findings: cleaned as PlannedBump['findings'] } }]);
      console.log(`  Webhook: cleared stuck coding status for ${packageName}`);
    }
  }
  return null;
}

function getFixableIndices(findings: PlannedBump['findings']): number[] {
  if (!findings) return [];
  return findings
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f.isAffected && (f.suggestedFix || f.fixKind))
    .map(({ i }) => i);
}

async function tryAutoFix(
  campaignId: string,
  owner: string,
  repoName: string,
  bump: PlannedBump,
  findings: PlannedBump['findings'],
  ciErrors?: string,
): Promise<void> {
  const fixable = getFixableIndices(findings);
  if (fixable.length === 0) return;
  if ((bump.fixAttempts ?? 0) >= MAX_FIX_ATTEMPTS) return;
  if (!bump.prNumber) return;

  console.log(`  Webhook: Auto-fixing ${fixable.length} finding(s) for ${bump.packageName}...`);
  await updateBumps(campaignId, [{
    packageName: bump.packageName,
    fields: { verdict: 'fixing', fixingAt: new Date().toISOString() },
  }]);

  try {
    const result = await applyFixFlow({
      campaignId,
      packageName: bump.packageName,
      findingIndices: fixable,
      ciErrors,
    });
    console.log(`  Webhook: Auto-fix: ${result.applied}/${result.total} for ${bump.packageName}`);
    if (result.applied > 0) {
      await commentOnPR(owner, repoName, bump.prNumber,
        `🔧 Auto-applied ${result.applied} fix(es) (attempt ${(bump.fixAttempts ?? 0) + 1}/${MAX_FIX_ATTEMPTS}). CI will re-run.`);
    }
  } catch (err) {
    console.error(`  Webhook: Auto-fix error for ${bump.packageName}:`, err);
  }

  await updateBumps(campaignId, [{
    packageName: bump.packageName,
    fields: { verdict: undefined, fixingAt: undefined },
  }]);
}

async function handleCICompletion(owner: string, repoName: string, branches: string[], webhookSha: string): Promise<void> {
  const campaigns = await listCampaigns();
  const active = campaigns.find(
    (c) => c.repoOwner === owner && c.repoName === repoName && !['done', 'failed'].includes(c.status),
  );
  if (!active) return;

  const matchedBumps = active.plan.filter((b) => {
    const branchName = `depbot-triage/${b.packageName}-${b.targetVersion}`;
    return branches.includes(branchName) && b.prNumber && b.verdict !== 'reanalysing' && b.verdict !== 'fixing';
  });

  if (matchedBumps.length === 0) return;

  for (const matched of matchedBumps) {
    const fresh = await getCampaign(active.id);
    let bump = fresh?.plan.find((b) => b.packageName === matched.packageName);
    if (!bump || bump.verdict === 'reanalysing' || bump.verdict === 'fixing') continue;

    const fixing = bump.findings?.some((f) => f.fixStatus === 'coding');
    if (fixing) {
      console.log(`  Webhook: ${bump.packageName} has fix in progress, waiting...`);
      const refreshed = await waitForFixCompletion(active.id, bump.packageName);
      if (!refreshed) {
        console.log(`  Webhook: ${bump.packageName} fix wait timed out, skipping`);
        continue;
      }
      bump = refreshed;
    }

    console.log(`  Webhook: CI completed for ${bump.packageName}, checking status...`);
    const { status, details, headSha } = await getPRCIStatus(owner, repoName, bump.prNumber!);

    if (!fixing && headSha !== webhookSha) {
      console.log(`  Webhook: ${bump.packageName} stale event (webhook: ${webhookSha.slice(0, 7)}, HEAD: ${headSha.slice(0, 7)}), skipping`);
      continue;
    }

    const statusChanged = status !== bump.ciStatus;
    const needsReanalysis = status === 'failure' || (status === 'success' && bump.verdict !== 'safe');
    if (!statusChanged && !needsReanalysis) {
      console.log(`  Webhook: ${bump.packageName} ciStatus already ${status}, skipping`);
      continue;
    }

    await updateBumps(active.id, [{ packageName: bump.packageName, fields: { ciStatus: status } }]);

    const atCap = (bump.fixAttempts ?? 0) >= MAX_FIX_ATTEMPTS;

    if (status === 'success' && bump.verdict !== 'safe') {
      if (atCap) {
        console.log(`  Webhook: ${bump.packageName} hit fix cap (${MAX_FIX_ATTEMPTS}), skipping re-analysis`);
        await commentOnPR(owner, repoName, bump.prNumber!,
          `✅ **CI passed** but fix attempts exhausted (${MAX_FIX_ATTEMPTS}). Needs manual review.`);
      } else {
        console.log(`  Webhook: CI passing for ${bump.packageName} but verdict is ${bump.verdict}, re-analysing...`);
        const branchRef = `depbot-triage/${bump.packageName}-${bump.targetVersion}`;
        const prevVerdict = await setReanalysing(active.id, bump.packageName);
        if (prevVerdict === null) {
          console.log(`  Webhook: ${bump.packageName} blocked from re-analysis (concurrent operation)`);
          continue;
        }
        try {
          const result = await classifyBump(owner, repoName, bump, branchRef);
          await updateBumps(active.id, [{
            packageName: bump.packageName,
            mergeNewFindings: true,
            fields: {
              verdict: result.verdict,
              verdictReason: result.reason,
              breakingChanges: result.breakingChanges,
              findings: result.findings,
              reanalysingAt: undefined,
            },
          }]);
          await commentOnPR(owner, repoName, bump.prNumber!,
            `✅ **CI passed.** Re-analysed — verdict updated to **${result.verdict}**.`);
          await tryAutoFix(active.id, owner, repoName, bump, result.findings);
        } catch (err) {
          await clearReanalysing(active.id, bump.packageName, prevVerdict);
          console.error(`  Webhook: Re-analysis failed for ${bump.packageName}:`, err);
        }
      }
    } else if (status === 'success' && bump.verdict === 'safe') {
      await commentOnPR(owner, repoName, bump.prNumber!,
        '✅ **CI passed** and safety analysis says this bump is safe.\n\n**Ready to merge.**');
    }

    if (status === 'failure') {
      if (atCap) {
        console.log(`  Webhook: ${bump.packageName} hit fix cap (${MAX_FIX_ATTEMPTS}), skipping re-analysis`);
        await commentOnPR(owner, repoName, bump.prNumber!,
          `❌ **CI failed.** Fix attempts exhausted (${MAX_FIX_ATTEMPTS}). Details: ${details}\n\nThis bump needs manual investigation.`);
      } else {
        console.log(`  Webhook: CI failed for ${bump.packageName}, pulling logs...`);
        const ciErrors = await getCIFailureLogs(owner, repoName, bump.prNumber!);
        if (ciErrors) {
          console.log(`  Webhook: Re-analysing ${bump.packageName} with CI errors...`);
          const branchRef = `depbot-triage/${bump.packageName}-${bump.targetVersion}`;
          const commitHistory = await getBranchCommitHistory(owner, repoName, branchRef);
          const prevVerdict = await setReanalysing(active.id, bump.packageName);
          if (prevVerdict === null) {
            console.log(`  Webhook: ${bump.packageName} blocked from re-analysis (concurrent operation)`);
            continue;
          }
          try {
            const enrichedErrors = commitHistory
              ? `${ciErrors}\n\nPrevious fix attempts on this branch:\n${commitHistory}`
              : ciErrors;
            const result = await reanalyseWithCIErrors(owner, repoName, bump, enrichedErrors);
            await updateBumps(active.id, [{
              packageName: bump.packageName,
              mergeNewFindings: true,
              fields: {
                verdict: result.verdict,
                verdictReason: result.reason,
                findings: result.findings,
                reanalysingAt: undefined,
              },
            }]);
            await commentOnPR(owner, repoName, bump.prNumber!,
              `❌ **CI failed.** Re-analysed with CI errors — verdict updated to **${result.verdict}**.\n\nDetails: ${details}`);
            await tryAutoFix(active.id, owner, repoName, bump, result.findings, enrichedErrors);
          } catch (err) {
            await clearReanalysing(active.id, bump.packageName, prevVerdict);
            console.error(`  Webhook: Re-analysis failed for ${bump.packageName}:`, err);
          }
        } else {
          await commentOnPR(owner, repoName, bump.prNumber!,
            `❌ **CI failed.** Details: ${details}\n\nThis bump may need manual investigation.`);
        }
      }
    }
  }

  // Re-read after all updates to check if everything is resolved
  const updated = await getCampaign(active.id);
  if (!updated) return;
  const allResolved = updated.plan.every(
    (b) => !b.prNumber || (b.verdict !== 'reanalysing' && b.verdict !== 'fixing' && /^(success|failure|no-checks)$/.test(b.ciStatus ?? '')),
  );
  if (allResolved) {
    console.log(`  Webhook: All CI resolved for campaign ${active.id}, marking done.`);
    const fields: Record<string, string> = { status: 'done' };
    if (!updated.completedAt) fields.completedAt = new Date().toISOString();
    await updateCampaign(active.id, fields);
  }
}

function verifySignature(req: Request): boolean {
  if (!config.githubWebhookSecret) return true;
  const sig = req.headers['x-hub-signature-256'] as string | undefined;
  if (!sig) return false;
  const hmac = crypto.createHmac('sha256', config.githubWebhookSecret);
  hmac.update(JSON.stringify(req.body));
  const expected = `sha256=${hmac.digest('hex')}`;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}
