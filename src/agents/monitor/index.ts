import { z } from 'genkit';
import { ai } from '../../genkit.js';
import { getCampaign, updateCampaign } from '../../tools/firestore/client.js';
import { getPRCIStatus, commentOnPR } from '../../tools/github/ci.js';

export const monitorFlow = ai.defineFlow(
  {
    name: 'monitorFlow',
    inputSchema: z.object({ campaignId: z.string() }),
    outputSchema: z.object({
      campaignId: z.string(),
      results: z.array(z.object({
        packageName: z.string(),
        prNumber: z.number(),
        ciStatus: z.string(),
        details: z.string(),
      })),
      allDone: z.boolean(),
    }),
  },
  async ({ campaignId }) => {
    const campaign = await getCampaign(campaignId);
    if (!campaign) throw new Error(`Campaign ${campaignId} not found`);

    const bumpsWithPRs = campaign.plan.filter((b) => b.prNumber);
    const results: Array<{ packageName: string; prNumber: number; ciStatus: string; details: string }> = [];

    for (const bump of bumpsWithPRs) {
      if (bump.ciStatus === 'success' || bump.ciStatus === 'failure') {
        results.push({
          packageName: bump.packageName,
          prNumber: bump.prNumber!,
          ciStatus: bump.ciStatus,
          details: 'already resolved',
        });
        continue;
      }

      console.log(`Checking CI for ${bump.packageName} PR #${bump.prNumber}...`);
      const { status, details } = await getPRCIStatus(
        campaign.repoOwner,
        campaign.repoName,
        bump.prNumber!,
      );

      bump.ciStatus = status;
      results.push({
        packageName: bump.packageName,
        prNumber: bump.prNumber!,
        ciStatus: status,
        details,
      });

      if (status === 'success' && bump.verdict === 'safe') {
        await commentOnPR(
          campaign.repoOwner,
          campaign.repoName,
          bump.prNumber!,
          `✅ **CI passed** and safety analysis says this bump is safe.\n\n**Ready to merge.**`,
        );
      }

      if (status === 'failure') {
        await commentOnPR(
          campaign.repoOwner,
          campaign.repoName,
          bump.prNumber!,
          `❌ **CI failed.** Details: ${details}\n\nThis bump may need manual investigation.`,
        );
      }

      await updateCampaign(campaignId, { plan: campaign.plan });
    }

    const allDone = bumpsWithPRs.every(
      (b) => b.ciStatus === 'success' || b.ciStatus === 'failure' || b.ciStatus === 'no-checks',
    );

    if (allDone) {
      await updateCampaign(campaignId, { status: 'done' });
    }

    return { campaignId, results, allDone };
  },
);
