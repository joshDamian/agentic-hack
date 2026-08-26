import { z } from 'genkit';
import { ai } from './genkit.js';
import { getCampaign, updateCampaign } from './tools/firestore/client.js';
import { classifyBump } from './agents/safety/index.js';
import { buildAnalysisComment } from './tools/github/pr.js';
import { commentOnPR } from './tools/github/ci.js';

export const reanalyseFlow = ai.defineFlow(
  {
    name: 'reanalyseFlow',
    inputSchema: z.object({
      campaignId: z.string(),
      packageName: z.string(),
    }),
    outputSchema: z.object({
      packageName: z.string(),
      previousVerdict: z.string(),
      newVerdict: z.string(),
      reason: z.string(),
      prNumber: z.number().optional(),
    }),
  },
  async ({ campaignId, packageName }) => {
    const campaign = await getCampaign(campaignId);
    if (!campaign) throw new Error(`Campaign ${campaignId} not found`);

    const bump = campaign.plan.find((b) => b.packageName === packageName);
    if (!bump) throw new Error(`Package ${packageName} not in campaign plan`);

    const previousVerdict = bump.verdict ?? 'none';

    console.log(`Re-analysing ${packageName} (was: ${previousVerdict})...`);
    const result = await classifyBump(campaign.repoOwner, campaign.repoName, bump);
    bump.verdict = result.verdict;
    bump.verdictReason = result.reason;
    bump.breakingChanges = result.breakingChanges;
    bump.findings = result.findings;

    await updateCampaign(campaignId, { plan: campaign.plan });

    if (bump.prNumber) {
      const comment = buildAnalysisComment(bump);
      const header = previousVerdict !== result.verdict
        ? `🔄 **Re-analysis** — verdict changed: ${previousVerdict} → **${result.verdict}**\n\n`
        : `🔄 **Re-analysis** — verdict unchanged: **${result.verdict}**\n\n`;

      await commentOnPR(
        campaign.repoOwner,
        campaign.repoName,
        bump.prNumber,
        header + (comment ?? result.reason),
      );
    }

    return {
      packageName,
      previousVerdict,
      newVerdict: result.verdict,
      reason: result.reason,
      prNumber: bump.prNumber,
    };
  },
);
