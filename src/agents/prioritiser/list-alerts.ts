import { z } from 'genkit';
import { ai } from '../../genkit.js';
import { listAlerts } from '../../tools/github/client.js';
import { config } from '../../shared/config.js';

export const listAlertsFlow = ai.defineFlow(
  {
    name: 'listAlertsFlow',
    inputSchema: z.object({
      owner: z.string().optional(),
      repo: z.string().optional(),
    }),
    outputSchema: z.object({
      alertCount: z.number(),
      alerts: z.array(z.object({
        number: z.number(),
        package: z.string(),
        severity: z.string(),
        summary: z.string(),
        patchedVersion: z.string().nullable(),
      })),
    }),
  },
  async (input) => {
    const owner = input.owner ?? config.targetRepo.owner;
    const repo = input.repo ?? config.targetRepo.name;
    const alerts = await listAlerts(owner, repo);
    return {
      alertCount: alerts.length,
      alerts: alerts.map((a) => ({
        number: a.number,
        package: a.dependency.package.name,
        severity: a.securityAdvisory.severity,
        summary: a.securityAdvisory.summary,
        patchedVersion: a.securityVulnerability.firstPatchedVersion,
      })),
    };
  },
);
