import { z } from 'genkit';
import { ai } from '../../genkit.js';
import { listAlerts, getFileContent } from '../../tools/github/client.js';
import { createCampaign } from '../../tools/firestore/client.js';
import { planBumps } from './plan.js';
import type { Campaign } from '../../shared/types.js';

export const prioritiseFlow = ai.defineFlow(
  {
    name: 'prioritiseFlow',
    inputSchema: z.object({
      owner: z.string(),
      repo: z.string(),
    }),
    outputSchema: z.object({
      campaignId: z.string(),
      totalAlerts: z.number(),
      plannedBumps: z.number(),
      topBumps: z.array(z.object({
        packageName: z.string(),
        currentVersion: z.string(),
        targetVersion: z.string(),
        alertsClosed: z.number(),
      })),
    }),
  },
  async ({ owner, repo }) => {
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

    return {
      campaignId,
      totalAlerts: alerts.length,
      plannedBumps: bumps.length,
      topBumps: bumps.slice(0, 5).map((b) => ({
        packageName: b.packageName,
        currentVersion: b.currentVersion,
        targetVersion: b.targetVersion,
        alertsClosed: b.alertsClosed,
      })),
    };
  },
);
