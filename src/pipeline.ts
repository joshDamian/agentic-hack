import { z } from 'genkit';
import { ai } from './genkit.js';
import { listAlerts, getFileContent, getInstallationOctokit } from './tools/github/client.js';
import { planBumps } from './agents/prioritiser/plan.js';
import { createCampaign, updateCampaign, findStuckCampaign } from './tools/firestore/client.js';
import { classifyBump } from './agents/safety/index.js';
import { clearFileCache } from './agents/safety/usage.js';
import { createBranchAndPR, postAnalysisReview } from './tools/github/pr.js';
import { getPRCIStatus, commentOnPR } from './tools/github/ci.js';
import type { Campaign, PlannedBump } from './shared/types.js';
import { runWithConcurrency } from './shared/concurrency.js';

async function reconcilePRs(owner: string, repo: string, bumps: PlannedBump[]): Promise<number> {
  const octokit = await getInstallationOctokit();
  const { data: prs } = await octokit.rest.pulls.list({
    owner, repo, state: 'open', per_page: 100,
  });

  let reconciled = 0;
  for (const bump of bumps) {
    if (bump.prNumber) continue;
    const branchName = `depbot-triage/${bump.packageName}-${bump.targetVersion}`;
    const match = prs.find((pr) => pr.head.ref === branchName);
    if (match) {
      bump.prNumber = match.number;
      bump.prUrl = match.html_url;
      bump.ciStatus = bump.ciStatus ?? 'pending';
      reconciled++;
    }
  }
  return reconciled;
}

const stageOrder = ['planning', 'analysing', 'executing', 'monitoring', 'done'] as const;

function stageAtOrPast(current: string, target: string): boolean {
  return stageOrder.indexOf(current as any) >= stageOrder.indexOf(target as any);
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
      const reconciled = await reconcilePRs(owner, repo, stuck.plan);
      if (reconciled > 0) {
        console.log(`  Reconciled ${reconciled} existing PRs from GitHub`);
        await updateCampaign(stuck.id, { plan: stuck.plan });
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

  // --- Analyse (skip if already past) ---
  if (!stageAtOrPast(campaign.status, 'executing')) {
    clearFileCache();
    console.log('=== Safety Analyser ===');
    await updateCampaign(campaignId, { status: 'analysing' });

    const needsAnalysis = bumps.filter((b) => !b.verdict);
    if (needsAnalysis.length < bumps.length) {
      console.log(`  Skipping ${bumps.length - needsAnalysis.length} already-analysed bumps`);
    }

    await runWithConcurrency(needsAnalysis, 3, async (bump) => {
      try {
        console.log(`  Analysing ${bump.packageName}...`);
        const result = await classifyBump(owner, repo, bump);
        bump.verdict = result.verdict;
        bump.verdictReason = result.reason;
        bump.breakingChanges = result.breakingChanges;
        bump.findings = result.findings;
      } catch (err) {
        console.log(`  Analysis failed for ${bump.packageName}: ${err instanceof Error ? err.message : err}`);
        bump.verdict = 'unknown';
        bump.verdictReason = 'Analysis failed — will retry on next run';
      }
      await updateCampaign(campaignId, { plan: bumps });
    });
  }

  // --- Execute (skip if already past) ---
  if (!stageAtOrPast(campaign.status, 'monitoring')) {
    console.log('=== Executor ===');
    await updateCampaign(campaignId, { status: 'executing' });
    let prsOpened = 0;
    for (const bump of bumps) {
      if (bump.prNumber) {
        console.log(`  Skipping ${bump.packageName}: PR #${bump.prNumber} already exists`);
        continue;
      }
      if (dryRun) {
        console.log(`  [DRY RUN] ${bump.packageName}: ${bump.verdict}`);
        continue;
      }
      try {
        console.log(`  Opening PR for ${bump.packageName}...`);
        const result = await createBranchAndPR(owner, repo, bump);
        bump.prNumber = result.prNumber;
        bump.prUrl = result.prUrl;
        bump.ciStatus = 'pending';
        prsOpened++;

        await postAnalysisReview(owner, repo, result.prNumber, bump);
      } catch (err) {
        console.log(`  Failed: ${err instanceof Error ? err.message : err}`);
      }
      // Save after each PR so a restart doesn't lose progress
      await updateCampaign(campaignId, { plan: bumps });
    }
    await updateCampaign(campaignId, { status: 'monitoring' });
  }

  // --- Monitor ---
  console.log('=== Monitor ===');
  for (const bump of bumps) {
    if (!bump.prNumber) continue;
    const { status, details } = await getPRCIStatus(owner, repo, bump.prNumber);
    bump.ciStatus = status;
    if (status === 'success' && bump.verdict === 'safe') {
      await commentOnPR(owner, repo, bump.prNumber, '✅ **CI passed** and safety analysis says this bump is safe.\n\n**Ready to merge.**');
    }
    if (status === 'failure') {
      await commentOnPR(owner, repo, bump.prNumber, `❌ **CI failed.** Details: ${details}\n\nThis bump may need manual investigation.`);
    }
    await updateCampaign(campaignId, { plan: bumps });
  }
  await updateCampaign(campaignId, { status: 'done', completedAt: new Date().toISOString() });

  const safe = bumps.filter((b) => b.verdict === 'safe').length;
  const risky = bumps.filter((b) => b.verdict === 'risky').length;
  const prsOpened = bumps.filter((b) => b.prNumber).length;

  console.log(`\nDone. ${safe} safe, ${risky} risky, ${prsOpened} PRs.`);
  return { campaignId, totalAlerts: bumps.reduce((s, b) => s + b.alertsClosed, 0), bumpsPlanned: bumps.length, prsOpened, safe, risky };
}
