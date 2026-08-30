import { z } from 'genkit';
import { ai } from './genkit.js';
import { getCampaign, updateCampaign } from './tools/firestore/client.js';
import { classifyBump } from './agents/safety/index.js';
import { postAnalysisReview } from './tools/github/pr.js';
import { commentOnPR } from './tools/github/ci.js';

interface Finding {
  file: string;
  line: number;
  isAffected: boolean;
  analysis: string;
}

function buildReanalysisComment(
  prevVerdict: string,
  newVerdict: string,
  newReason: string,
  prevAffected: Finding[],
  newFindings: Finding[],
): string {
  const verdictChanged = prevVerdict !== newVerdict;
  let header = verdictChanged
    ? `🔄 **Re-analysis** — verdict changed: ${prevVerdict} → **${newVerdict}**\n\n`
    : `🔄 **Re-analysis** — verdict unchanged: **${newVerdict}**\n\n`;

  if (prevAffected.length === 0) {
    return header + newReason;
  }

  const newAffected = (newFindings ?? []).filter((f) => f.isAffected);
  const newAffectedKeys = new Set(newAffected.map((f) => `${f.file}:${f.line}`));
  const resolved = prevAffected.filter((f) => !newAffectedKeys.has(`${f.file}:${f.line}`));
  const stillOpen = prevAffected.filter((f) => newAffectedKeys.has(`${f.file}:${f.line}`));

  if (resolved.length > 0) {
    header += `**Resolved:**\n`;
    for (const f of resolved) {
      header += `- ~\`${f.file}:${f.line}\` — ${f.analysis}~\n`;
    }
    header += '\n';
  }

  if (stillOpen.length > 0) {
    header += `**Still affected:**\n`;
    for (const f of stillOpen) {
      header += `- \`${f.file}:${f.line}\` — ${f.analysis}\n`;
    }
    header += '\n';
  }

  if (resolved.length > 0 && stillOpen.length === 0 && newReason) {
    header += newReason;
  }

  return header;
}

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
    const previousFindings = (bump.findings ?? []).filter((f) => f.isAffected);

    const branchRef = bump.prNumber
      ? `depbot-triage/${packageName}-${bump.targetVersion}`
      : undefined;
    console.log(`Re-analysing ${packageName} (was: ${previousVerdict})...`);
    const result = await classifyBump(campaign.repoOwner, campaign.repoName, bump, branchRef);
    // Re-read campaign before writing to avoid clobbering concurrent re-analyses
    const fresh = await getCampaign(campaignId);
    const freshBump = fresh!.plan.find((b) => b.packageName === packageName)!;
    freshBump.verdict = result.verdict;
    freshBump.verdictReason = result.reason;
    freshBump.breakingChanges = result.breakingChanges;
    freshBump.findings = result.findings;

    await updateCampaign(campaignId, { plan: fresh!.plan });

    if (freshBump.prNumber) {
      const comment = buildReanalysisComment(
        previousVerdict, result.verdict, result.reason,
        previousFindings, result.findings ?? [],
      );

      await commentOnPR(
        campaign.repoOwner,
        campaign.repoName,
        freshBump.prNumber,
        comment,
      );
      await postAnalysisReview(
        campaign.repoOwner,
        campaign.repoName,
        freshBump.prNumber,
        freshBump,
        true,
      );
    }

    return {
      packageName,
      previousVerdict,
      newVerdict: result.verdict,
      reason: result.reason,
      prNumber: freshBump.prNumber,
    };
  },
);
