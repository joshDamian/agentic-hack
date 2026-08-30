import { z } from 'genkit';
import { ai } from './genkit.js';
import { listAlerts, getFileContent, getInstallationOctokit } from './tools/github/client.js';
import { planBumps } from './agents/prioritiser/plan.js';
import { createCampaign, updateCampaign, updateBumps, findStuckCampaign } from './tools/firestore/client.js';
import { prepBump, classifyPreparedBump } from './agents/safety/index.js';
import { clearFileCache } from './agents/safety/usage.js';
import { createBranchAndPR, postAnalysisReview } from './tools/github/pr.js';
import { getPRCIStatus } from './tools/github/ci.js';
import type { Campaign, PlannedBump } from './shared/types.js';
import { Semaphore } from './shared/concurrency.js';
import { clearSnapshots } from './tools/github/zipball.js';

async function reconcilePRs(
  owner: string,
  repo: string,
  bumps: PlannedBump[],
): Promise<Array<{ packageName: string; fields: Partial<PlannedBump> }>> {
  const octokit = await getInstallationOctokit();
  const { data: prs } = await octokit.rest.pulls.list({
    owner, repo, state: 'open', per_page: 100,
  });

  const updates: Array<{ packageName: string; fields: Partial<PlannedBump> }> = [];
  for (const bump of bumps) {
    if (bump.prNumber) continue;
    const branchName = `depbot-triage/${bump.packageName}-${bump.targetVersion}`;
    const match = prs.find((pr) => pr.head.ref === branchName);
    if (match) {
      bump.prNumber = match.number;
      bump.prUrl = match.html_url;
      bump.ciStatus = bump.ciStatus ?? 'pending';
      updates.push({
        packageName: bump.packageName,
        fields: { prNumber: match.number, prUrl: match.html_url, ciStatus: bump.ciStatus },
      });
    }
  }
  return updates;
}

export const pipelineFlow = ai.defineFlow(
  {
    name: 'pipelineFlow',
    inputSchema: z.object({
      owner: z.string(),
      repo: z.string(),
      dryRun: z.boolean().optional(),
      fresh: z.boolean().optional(),
    }),
    outputSchema: z.object({
      campaignId: z.string(),
      totalAlerts: z.number(),
      bumpsPlanned: z.number(),
      prsOpened: z.number(),
      safe: z.number(),
      risky: z.number(),
    }),
  },
  async ({ owner, repo, dryRun, fresh }) => {
    // Check for a stuck campaign to resume
    if (fresh) {
      const old = await findStuckCampaign(owner, repo);
      if (old) await updateCampaign(old.id, { status: 'failed' });
    }
    const stuck = fresh ? null : await findStuckCampaign(owner, repo);
    if (stuck) {
      console.log(`Resuming stuck campaign ${stuck.id} (status: ${stuck.status})`);
      const reconcileUpdates = await reconcilePRs(owner, repo, stuck.plan);
      if (reconcileUpdates.length > 0) {
        console.log(`  Reconciled ${reconcileUpdates.length} existing PRs from GitHub`);
        await updateBumps(stuck.id, reconcileUpdates);
      }
      return resumeCampaign(stuck, owner, repo, dryRun);
    }

    // Fresh run
    console.log('=== Prioritiser ===');
    const alerts = await listAlerts(owner, repo);
    const [lockRaw, pkgRaw] = await Promise.all([
      getFileContent(owner, repo, 'package-lock.json'),
      getFileContent(owner, repo, 'package.json'),
    ]);
    const packageLock = JSON.parse(lockRaw) as { packages: Record<string, { version: string }> };
    const packageJson = JSON.parse(pkgRaw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const bumps = planBumps(alerts, packageLock, packageJson);

    const campaignId = `${owner}-${repo}-${Date.now()}`;
    const campaign: Campaign = {
      id: campaignId,
      repoOwner: owner,
      repoName: repo,
      status: 'planning',
      plan: bumps,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
    };
    await createCampaign(campaign);
    console.log(`Campaign ${campaignId}: ${bumps.length} bumps for ${alerts.length} alerts`);

    return resumeCampaign(campaign, owner, repo, dryRun);
  },
);

async function resumeCampaign(
  campaign: Campaign,
  owner: string,
  repo: string,
  dryRun?: boolean,
) {
  const { id: campaignId, plan: bumps } = campaign;

  if (!campaign.startedAt) {
    await updateCampaign(campaignId, { startedAt: new Date().toISOString() });
  }

  clearFileCache();
  await updateCampaign(campaignId, { status: 'analysing' });

  const prepSem = new Semaphore(6);
  const classifySem = new Semaphore(6);
  const execSem = new Semaphore(4);
  const monitorSem = new Semaphore(3);

  async function saveBump(bump: PlannedBump) {
    await updateBumps(campaignId, [{
      packageName: bump.packageName,
      fields: {
        verdict: bump.verdict,
        verdictReason: bump.verdictReason,
        breakingChanges: bump.breakingChanges,
        findings: bump.findings,
        prNumber: bump.prNumber,
        prUrl: bump.prUrl,
        ciStatus: bump.ciStatus,
      },
    }]);
  }

  await Promise.all(bumps.map(async (bump) => {
    // --- Analyse ---
    if (!bump.verdict) {
      try {
        console.log(`  Prepping ${bump.packageName}...`);
        const prep = await prepSem.run(() => prepBump(owner, repo, bump));
        console.log(`  Classifying ${bump.packageName}...`);
        const result = await classifySem.run(() => classifyPreparedBump(owner, repo, bump, prep));
        bump.verdict = result.verdict;
        bump.verdictReason = result.reason;
        bump.breakingChanges = result.breakingChanges;
        bump.findings = result.findings;
      } catch (err) {
        console.log(`  Analysis failed for ${bump.packageName}: ${err instanceof Error ? err.message : err}`);
        bump.verdict = 'unknown';
        bump.verdictReason = 'Analysis failed — will retry on next run';
      }
      await saveBump(bump);
    }

    // --- Execute ---
    if (!bump.prNumber && !dryRun) {
      try {
        console.log(`  Opening PR for ${bump.packageName}...`);
        const result = await execSem.run(() => createBranchAndPR(owner, repo, bump));
        bump.prNumber = result.prNumber;
        bump.prUrl = result.prUrl;
        bump.ciStatus = 'pending';
        await execSem.run(() => postAnalysisReview(owner, repo, result.prNumber, bump));
      } catch (err) {
        console.log(`  PR failed for ${bump.packageName}: ${err instanceof Error ? err.message : err}`);
      }
      await saveBump(bump);
    }

    // --- Quick CI check (webhook handles the rest) ---
    if (bump.prNumber && bump.ciStatus === 'pending') {
      try {
        const { status } = await monitorSem.run(() => getPRCIStatus(owner, repo, bump.prNumber!));
        if (status !== 'pending') {
          bump.ciStatus = status;
          await saveBump(bump);
        }
      } catch {}
    }
  }));

  const fresh = await updateBumps(campaignId, []);
  const currentPlan = fresh?.plan ?? bumps;
  const allResolved = currentPlan.every(
    (b) => !b.prNumber || (b.verdict !== 'reanalysing' && /^(success|failure|no-checks)$/.test(b.ciStatus ?? '')),
  );
  if (allResolved) {
    await updateCampaign(campaignId, { status: 'done', completedAt: new Date().toISOString() });
  } else {
    await updateCampaign(campaignId, { status: 'monitoring' });
  }

  clearSnapshots();

  const safe = bumps.filter((b) => b.verdict === 'safe').length;
  const risky = bumps.filter((b) => b.verdict === 'risky').length;
  const prsOpened = bumps.filter((b) => b.prNumber).length;

  console.log(`\nDone. ${safe} safe, ${risky} risky, ${prsOpened} PRs.`);
  return { campaignId, totalAlerts: bumps.reduce((s, b) => s + b.alertsClosed, 0), bumpsPlanned: bumps.length, prsOpened, safe, risky };
}
