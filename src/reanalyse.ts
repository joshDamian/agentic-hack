import { z } from 'genkit';
import { ai } from './genkit.js';
import { getCampaign, updateBumps, setReanalysing, clearReanalysing } from './tools/firestore/client.js';
import { classifyBump, reanalyseWithCIErrors } from './agents/safety/index.js';
import { postAnalysisReview } from './tools/github/pr.js';
import { commentOnPR, getCIFailureLogs } from './tools/github/ci.js';

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
  const newAffectedFiles = new Set(newAffected.map((f) => f.file));
  const resolved = prevAffected.filter((f) => !newAffectedFiles.has(f.file));
  const stillOpen = prevAffected.filter((f) => newAffectedFiles.has(f.file));

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

    const previousFindings = (bump.findings ?? []).filter((f) => f.isAffected);

    const prevVerdict = await setReanalysing(campaignId, packageName);
    if (prevVerdict === null) {
      throw new Error(`${packageName} is locked by another operation (fix in progress or already re-analysing)`);
    }

    const branchRef = bump.prNumber
      ? `depbot-triage/${packageName}-${bump.targetVersion}`
      : undefined;
    console.log(`Re-analysing ${packageName} (was: ${prevVerdict})...`);

    let result;
    try {
      let ciErrors: string | null = null;
      if (bump.ciStatus === 'failure' && bump.prNumber) {
        ciErrors = await getCIFailureLogs(campaign.repoOwner, campaign.repoName, bump.prNumber);
      }
      result = ciErrors
        ? await reanalyseWithCIErrors(campaign.repoOwner, campaign.repoName, bump, ciErrors)
        : await classifyBump(campaign.repoOwner, campaign.repoName, bump, branchRef);
    } catch (err) {
      await clearReanalysing(campaignId, packageName, prevVerdict);
      throw err;
    }

    await updateBumps(campaignId, [{
      packageName,
      mergeNewFindings: true,
      fields: {
        verdict: result.verdict,
        verdictReason: result.reason,
        breakingChanges: result.breakingChanges,
        findings: result.findings ?? [],
        reanalysingAt: undefined,
      },
    }]);

    if (bump.prNumber) {
      const comment = buildReanalysisComment(
        prevVerdict, result.verdict, result.reason,
        previousFindings, result.findings ?? [],
      );

      await commentOnPR(
        campaign.repoOwner,
        campaign.repoName,
        bump.prNumber,
        comment,
      );
      const freshCampaign = await getCampaign(campaignId);
      const freshBump = freshCampaign?.plan.find((b) => b.packageName === packageName);
      if (freshBump) {
        await postAnalysisReview(
          campaign.repoOwner,
          campaign.repoName,
          bump.prNumber,
          freshBump,
          true,
        );
      }
    }

    return {
      packageName,
      previousVerdict: prevVerdict,
      newVerdict: result.verdict,
      reason: result.reason,
      prNumber: bump.prNumber,
    };
  },
);
