import { z } from 'genkit';
import { ai } from '../../genkit.js';
import { getCampaign, updateCampaign } from '../../tools/firestore/client.js';
import { createBranchAndPR, postAnalysisReview } from '../../tools/github/pr.js';

const prResultSchema = z.object({
  packageName: z.string(),
  prNumber: z.number(),
  prUrl: z.string(),
  verdict: z.string(),
});

export const executorFlow = ai.defineFlow(
  {
    name: 'executorFlow',
    inputSchema: z.object({
      campaignId: z.string(),
      dryRun: z.boolean().optional(),
    }),
    outputSchema: z.object({
      campaignId: z.string(),
      prsOpened: z.array(prResultSchema),
      skipped: z.array(z.object({
        packageName: z.string(),
        reason: z.string(),
      })),
    }),
  },
  async ({ campaignId, dryRun }) => {
    const campaign = await getCampaign(campaignId);
    if (!campaign) throw new Error(`Campaign ${campaignId} not found`);

    await updateCampaign(campaignId, { status: 'executing' });

    const prsOpened: Array<{ packageName: string; prNumber: number; prUrl: string; verdict: string }> = [];
    const skipped: Array<{ packageName: string; reason: string }> = [];

    for (const bump of campaign.plan) {
      if (!bump.verdict) {
        skipped.push({ packageName: bump.packageName, reason: 'no verdict yet' });
        continue;
      }

      if (bump.prNumber) {
        skipped.push({ packageName: bump.packageName, reason: `PR #${bump.prNumber} already exists` });
        continue;
      }

      if (dryRun) {
        console.log(`[DRY RUN] would open PR for ${bump.packageName} ${bump.currentVersion} → ${bump.targetVersion} (${bump.verdict})`);
        prsOpened.push({
          packageName: bump.packageName,
          prNumber: 0,
          prUrl: 'dry-run',
          verdict: bump.verdict,
        });
        continue;
      }

      try {
        console.log(`Opening PR for ${bump.packageName}...`);
        const result = await createBranchAndPR(
          campaign.repoOwner,
          campaign.repoName,
          bump,
        );
        bump.prNumber = result.prNumber;
        bump.prUrl = result.prUrl;
        bump.ciStatus = 'pending';

        await postAnalysisReview(campaign.repoOwner, campaign.repoName, result.prNumber, bump);

        prsOpened.push({
          packageName: bump.packageName,
          prNumber: result.prNumber,
          prUrl: result.prUrl,
          verdict: bump.verdict,
        });
        await updateCampaign(campaignId, { plan: campaign.plan });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`Failed to open PR for ${bump.packageName}: ${message}`);
        skipped.push({ packageName: bump.packageName, reason: message });
      }
    }

    await updateCampaign(campaignId, { status: 'monitoring', plan: campaign.plan });

    return { campaignId, prsOpened, skipped };
  },
);
