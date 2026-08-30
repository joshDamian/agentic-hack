import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from './shared/config.js';
import { listCampaigns, updateBumps, updateCampaign } from './tools/firestore/client.js';
import { getPRCIStatus, commentOnPR, getCIFailureLogs } from './tools/github/ci.js';
import { classifyBump, reanalyseWithCIErrors } from './agents/safety/index.js';
import type { Campaign, PlannedBump } from './shared/types.js';

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

  const branches: string[] = event === 'check_suite'
    ? (payload.check_suite.pull_requests ?? []).map((pr: any) => pr.head.ref as string)
    : (payload.check_run.pull_requests ?? []).map((pr: any) => pr.head.ref as string);

  if (branches.length === 0) {
    res.status(200).send('No PR branches');
    return;
  }

  res.status(200).send('Processing');

  handleCICompletion(owner, repoName, branches).catch((err) =>
    console.error('Webhook handler error:', err),
  );
}

async function handleCICompletion(owner: string, repoName: string, branches: string[]): Promise<void> {
  const campaigns = await listCampaigns();
  const active = campaigns.find(
    (c) => c.repoOwner === owner && c.repoName === repoName && !['done', 'failed'].includes(c.status),
  );
  if (!active) return;

  const matchedBumps = active.plan.filter((b) => {
    const branchName = `depbot-triage/${b.packageName}-${b.targetVersion}`;
    return branches.includes(branchName) && b.prNumber && b.verdict !== 'reanalysing';
  });

  if (matchedBumps.length === 0) return;

  for (const bump of matchedBumps) {
    console.log(`  Webhook: CI completed for ${bump.packageName}, checking status...`);
    const { status, details } = await getPRCIStatus(owner, repoName, bump.prNumber!);

    const statusChanged = status !== bump.ciStatus;
    const needsReanalysis = status === 'failure' || (status === 'success' && bump.verdict !== 'safe');
    if (!statusChanged && !needsReanalysis) {
      console.log(`  Webhook: ${bump.packageName} ciStatus already ${status}, skipping`);
      continue;
    }

    const fields: Partial<PlannedBump> = { ciStatus: status };

    if (status === 'success' && bump.verdict !== 'safe') {
      console.log(`  Webhook: CI passing for ${bump.packageName} but verdict is ${bump.verdict}, re-analysing...`);
      const prevVerdict = bump.verdict;
      const branchRef = `depbot-triage/${bump.packageName}-${bump.targetVersion}`;
      await updateBumps(active.id, [{ packageName: bump.packageName, fields: { verdict: 'reanalysing' } }]);
      try {
        const result = await classifyBump(owner, repoName, bump, branchRef);
        fields.verdict = result.verdict;
        fields.verdictReason = result.reason;
        fields.breakingChanges = result.breakingChanges;
        fields.findings = result.findings;
        await commentOnPR(owner, repoName, bump.prNumber!,
          `✅ **CI passed.** Re-analysed — verdict updated to **${result.verdict}**.`);
      } catch (err) {
        fields.verdict = prevVerdict;
        console.error(`  Webhook: Re-analysis failed for ${bump.packageName}:`, err);
      }
    } else if (status === 'success' && bump.verdict === 'safe') {
      await commentOnPR(owner, repoName, bump.prNumber!,
        '✅ **CI passed** and safety analysis says this bump is safe.\n\n**Ready to merge.**');
    }

    if (status === 'failure') {
      console.log(`  Webhook: CI failed for ${bump.packageName}, pulling logs...`);
      const ciErrors = await getCIFailureLogs(owner, repoName, bump.prNumber!);
      if (ciErrors) {
        console.log(`  Webhook: Re-analysing ${bump.packageName} with CI errors...`);
        const prevVerdict = bump.verdict;
        await updateBumps(active.id, [{ packageName: bump.packageName, fields: { verdict: 'reanalysing' } }]);
        try {
          const result = await reanalyseWithCIErrors(owner, repoName, bump, ciErrors);
          fields.verdict = result.verdict;
          fields.verdictReason = result.reason;
          fields.findings = result.findings;
          await commentOnPR(owner, repoName, bump.prNumber!,
            `❌ **CI failed.** Re-analysed with CI errors — verdict updated to **${result.verdict}**.\n\nDetails: ${details}`);
        } catch (err) {
          fields.verdict = prevVerdict;
          console.error(`  Webhook: Re-analysis failed for ${bump.packageName}:`, err);
        }
      } else {
        await commentOnPR(owner, repoName, bump.prNumber!,
          `❌ **CI failed.** Details: ${details}\n\nThis bump may need manual investigation.`);
      }
    }

    await updateBumps(active.id, [{ packageName: bump.packageName, fields }]);
  }

  // Re-read after all updates to check if everything is resolved
  const updated = await updateBumps(active.id, []);
  if (!updated) return;
  const allResolved = updated.plan.every(
    (b) => !b.prNumber || /^(success|failure|no-checks)$/.test(b.ciStatus ?? ''),
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
