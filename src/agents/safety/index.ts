import { z } from 'genkit';
import { ai } from '../../genkit.js';
import { extractBreakingChanges } from './changelog.js';
import { scanForUsage } from './usage.js';
import { getCampaign, updateCampaign } from '../../tools/firestore/client.js';
import type { BumpVerdict, PlannedBump } from '../../shared/types.js';

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
    return {
      verdict: 'safe',
      reason: `Breaking changes found but none affect this codebase: ${breakingChanges.changes.map((c) => c.api).join(', ')}`,
    };
  }

  const { output } = await ai.generate({
    // gemini-3.5-pro not yet available on Vertex AI — swap when it launches
    prompt: `You are a dependency upgrade safety classifier. Given the breaking changes and the codebase usage hits below, determine if this upgrade is safe or risky.

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

  return {
    verdict: output!.verdict,
    reason: output!.reason,
  };
}

export const safetyAnalyserFlow = ai.defineFlow(
  {
    name: 'safetyAnalyserFlow',
    inputSchema: z.object({ campaignId: z.string() }),
    outputSchema: z.object({
      campaignId: z.string(),
      results: z.array(z.object({
        packageName: z.string(),
        verdict: z.enum(['safe', 'risky', 'unknown']),
        reason: z.string(),
      })),
    }),
  },
  async ({ campaignId }) => {
    const campaign = await getCampaign(campaignId);
    if (!campaign) throw new Error(`Campaign ${campaignId} not found`);

    await updateCampaign(campaignId, { status: 'analysing' });

    const results: Array<{ packageName: string; verdict: BumpVerdict; reason: string }> = [];

    for (const bump of campaign.plan) {
      console.log(`Analysing ${bump.packageName}...`);
      const { verdict, reason } = await classifyBump(
        campaign.repoOwner,
        campaign.repoName,
        bump,
      );

      bump.verdict = verdict;
      bump.verdictReason = reason;
      results.push({ packageName: bump.packageName, verdict, reason });
    }

    await updateCampaign(campaignId, { plan: campaign.plan });

    return { campaignId, results };
  },
);
