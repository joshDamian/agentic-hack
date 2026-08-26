import { z } from 'genkit';
import { ai } from './genkit.js';
import { listAlerts, getFileContent } from './tools/github/client.js';
import { planBumps } from './agents/prioritiser/plan.js';
import { createCampaign, updateCampaign } from './tools/firestore/client.js';
import { classifyBump } from './agents/safety/index.js';
import { clearFileCache } from './agents/safety/usage.js';
import { createBranchAndPR, buildAnalysisComment } from './tools/github/pr.js';
import { getPRCIStatus, commentOnPR } from './tools/github/ci.js';
import type { Campaign } from './shared/types.js';
import { runWithConcurrency } from './shared/concurrency.js';

export const pipelineFlow = ai.defineFlow(
  {
    name: 'pipelineFlow',
    inputSchema: z.object({
      owner: z.string(),
      repo: z.string(),
      dryRun: z.boolean().optional(),
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
  async ({ owner, repo, dryRun }) => {
    // 1. Prioritise
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
    };
    await createCampaign(campaign);
    console.log(`Campaign ${campaignId}: ${bumps.length} bumps for ${alerts.length} alerts`);

    // 2. Safety Analyser
    clearFileCache();
    console.log('=== Safety Analyser ===');
    await updateCampaign(campaignId, { status: 'analysing' });
    await runWithConcurrency(bumps, 3, async (bump) => {
      console.log(`  Analysing ${bump.packageName}...`);
      const result = await classifyBump(owner, repo, bump);
      bump.verdict = result.verdict;
      bump.verdictReason = result.reason;
      bump.breakingChanges = result.breakingChanges;
      bump.findings = result.findings;
    });
    await updateCampaign(campaignId, { plan: bumps });

    // 3. Executor
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

        const analysisComment = buildAnalysisComment(bump);
        if (analysisComment) {
          await commentOnPR(owner, repo, result.prNumber, analysisComment);
        }
      } catch (err) {
        console.log(`  Failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    await updateCampaign(campaignId, { plan: bumps, status: 'monitoring' });

    // 4. Monitor (initial check)
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
    }
    await updateCampaign(campaignId, { plan: bumps, status: 'done' });

    const safe = bumps.filter((b) => b.verdict === 'safe').length;
    const risky = bumps.filter((b) => b.verdict === 'risky').length;

    console.log(`\nDone. ${safe} safe, ${risky} risky, ${prsOpened} PRs opened.`);
    return { campaignId, totalAlerts: alerts.length, bumpsPlanned: bumps.length, prsOpened, safe, risky };
  },
);
