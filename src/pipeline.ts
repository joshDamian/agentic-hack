import { z } from 'genkit';
import { ai } from './genkit.js';
import { listAlerts, getFileContent } from './tools/github/client.js';
import { planBumps } from './agents/prioritiser/plan.js';
import { createCampaign, updateCampaign } from './tools/firestore/client.js';
import { extractBreakingChanges } from './agents/safety/changelog.js';
import { scanForUsage } from './agents/safety/usage.js';
import { createBranchAndPR } from './tools/github/pr.js';
import { getPRCIStatus, commentOnPR } from './tools/github/ci.js';
import type { BumpVerdict, Campaign, PlannedBump } from './shared/types.js';

const verdictSchema = z.object({
  verdict: z.enum(['safe', 'risky', 'unknown']),
  reason: z.string(),
});

async function classifyBump(
  owner: string,
  repo: string,
  bump: PlannedBump,
): Promise<{ verdict: BumpVerdict; reason: string }> {
  const breakingChanges = await extractBreakingChanges(bump);

  if (!breakingChanges.hasBreakingChanges) {
    return { verdict: 'safe', reason: 'No breaking changes in release notes' };
  }

  const usageHits = await scanForUsage(owner, repo, breakingChanges);

  if (usageHits.length === 0) {
    return { verdict: 'safe', reason: 'Breaking changes exist but none affect this codebase' };
  }

  const { output } = await ai.generate({
    prompt: `You are a dependency upgrade safety classifier.

Package: ${bump.packageName}
Upgrade: ${bump.currentVersion} → ${bump.targetVersion}

Breaking changes:
${breakingChanges.changes.map((c) => `- ${c.kind}: ${c.api} — ${c.description}`).join('\n')}

Usage hits in the codebase:
${usageHits.map((h) => `- ${h.file}:${h.line}: ${h.snippet}`).join('\n')}

If the usage hits actually use the broken APIs, verdict is "risky" and cite the specific file:line.
If the usage hits are false positives (different context, comments, etc.), verdict is "safe".
If you can't tell, verdict is "unknown".`,
    output: { schema: verdictSchema },
  });

  return { verdict: output!.verdict, reason: output!.reason };
}

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
    const lockRaw = await getFileContent(owner, repo, 'package-lock.json');
    const packageLock = JSON.parse(lockRaw) as { packages: Record<string, { version: string }> };
    const bumps = planBumps(alerts, packageLock);

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
    console.log('=== Safety Analyser ===');
    await updateCampaign(campaignId, { status: 'analysing' });
    for (const bump of bumps) {
      console.log(`  Analysing ${bump.packageName}...`);
      const { verdict, reason } = await classifyBump(owner, repo, bump);
      bump.verdict = verdict;
      bump.verdictReason = reason;
    }
    await updateCampaign(campaignId, { plan: bumps });

    // 3. Executor
    console.log('=== Executor ===');
    await updateCampaign(campaignId, { status: 'executing' });
    let prsOpened = 0;
    for (const bump of bumps) {
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
