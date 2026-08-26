import { z } from 'genkit';
import { ai } from '../../genkit.js';
import { extractBreakingChanges } from './changelog.js';
import { scanForUsage } from './usage.js';
import { getCampaign, updateCampaign } from '../../tools/firestore/client.js';
import type { BumpVerdict, PlannedBump } from '../../shared/types.js';
import { withRetry } from '../../shared/retry.js';

const findingSchema = z.object({
  file: z.string(),
  line: z.number(),
  isAffected: z.boolean(),
  analysis: z.string().describe('Why this usage is or is not affected by the breaking change'),
  suggestedFix: z.string().optional().describe('If affected, the specific code change needed'),
});

const classificationSchema = z.object({
  verdict: z.enum(['safe', 'risky', 'unknown']),
  reason: z.string().describe('Structured: 1) what changed in the package, 2) what the codebase uses, 3) whether usage is affected'),
  findings: z.array(findingSchema),
});

export interface ClassificationResult {
  verdict: BumpVerdict;
  reason: string;
  breakingChanges: PlannedBump['breakingChanges'];
  findings: PlannedBump['findings'];
}

export async function classifyBump(
  owner: string,
  repo: string,
  bump: PlannedBump,
): Promise<ClassificationResult> {
  const breakingChanges = await extractBreakingChanges(bump);
  const bcData = breakingChanges.changes.map((c) => {
    const entry: { api: string; kind: string; description: string; migrationHint?: string } = {
      api: c.api, kind: c.kind, description: c.description,
    };
    if (c.migrationHint) entry.migrationHint = c.migrationHint;
    return entry;
  });

  if (!breakingChanges.hasBreakingChanges) {
    return { verdict: 'safe', reason: 'No breaking changes in release notes.', breakingChanges: [], findings: [] };
  }

  const usageHits = await scanForUsage(owner, repo, breakingChanges);

  if (usageHits.length === 0) {
    return {
      verdict: 'safe',
      reason: `Breaking changes found (${bcData.map((c) => c.api).join(', ')}) but no usage of those APIs in this codebase.`,
      breakingChanges: bcData,
      findings: [],
    };
  }

  const { output } = await withRetry(() =>
    ai.generate({
      prompt: `You are a dependency upgrade safety classifier. Analyse each usage hit against the breaking changes and give a concrete verdict.

Package: ${bump.packageName}
Upgrade: ${bump.currentVersion} → ${bump.targetVersion}

## Breaking changes in this upgrade
${breakingChanges.changes.map((c) => {
  let line = `- **${c.kind}**: \`${c.api}\` — ${c.description}`;
  if (c.migrationHint) line += `\n  Migration: ${c.migrationHint}`;
  return line;
}).join('\n')}

## Usage found in the codebase
${usageHits.map((h) => `### ${h.file}:${h.line}
\`\`\`
${h.context}
\`\`\`
`).join('\n')}

## Instructions
For each usage hit above, output a finding:
- Set isAffected to true ONLY if the code actually calls a broken API in a way that would fail after the upgrade.
- Set isAffected to false for: import statements that don't call the broken method, false positive text matches, comments, unrelated code.
- In analysis, be specific: name the breaking change, say what the code does, say why it is or isn't affected.
- If affected, provide suggestedFix with the corrected code.

For the overall verdict:
- "risky" if ANY usage is affected. Cite the file:line in the reason.
- "safe" if all hits are false positives or unaffected. Say why.
- "unknown" only if the code is too ambiguous to classify.

In the reason field, structure as: what changed → what the codebase uses → whether it's affected.`,
      output: { schema: classificationSchema },
    }),
  );

  return {
    verdict: output!.verdict,
    reason: output!.reason,
    breakingChanges: bcData,
    findings: output!.findings.map((f) => {
      const entry: { file: string; line: number; isAffected: boolean; analysis: string; suggestedFix?: string } = {
        file: f.file, line: f.line, isAffected: f.isAffected, analysis: f.analysis,
      };
      if (f.suggestedFix) entry.suggestedFix = f.suggestedFix;
      return entry;
    }),
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
      const result = await classifyBump(campaign.repoOwner, campaign.repoName, bump);
      bump.verdict = result.verdict;
      bump.verdictReason = result.reason;
      bump.breakingChanges = result.breakingChanges;
      bump.findings = result.findings;
      results.push({ packageName: bump.packageName, verdict: result.verdict, reason: result.reason });
    }

    await updateCampaign(campaignId, { plan: campaign.plan });

    return { campaignId, results };
  },
);
