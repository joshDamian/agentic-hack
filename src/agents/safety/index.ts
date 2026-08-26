import { z } from 'genkit';
import { ai } from '../../genkit.js';
import { extractBreakingChanges } from './changelog.js';
import { scanForUsage } from './usage.js';
import { getCampaign, updateCampaign } from '../../tools/firestore/client.js';
import type { BumpVerdict, PlannedBump } from '../../shared/types.js';
import { withRetry } from '../../shared/retry.js';
import { getPackageTypeDiff } from '../../tools/npm/typediff.js';
import { compileCheck } from '../../tools/npm/compile-check.js';
import { getFileContent, getInstallationOctokit } from '../../tools/github/client.js';

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

async function findFilesImporting(
  owner: string,
  repo: string,
  packageName: string,
): Promise<string[]> {
  try {
    const octokit = await getInstallationOctokit();
    const { data } = await octokit.rest.search.code({
      q: `"${packageName}" repo:${owner}/${repo} language:typescript`,
      per_page: 20,
    });
    return data.items
      .map((item) => item.path)
      .filter((p) => p.match(/\.(ts|tsx)$/) && !p.endsWith('.d.ts') && p !== 'package.json' && p !== 'package-lock.json');
  } catch {
    return [];
  }
}

async function collectSourceFiles(
  owner: string,
  repo: string,
  packageName: string,
  filePaths: string[],
): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  for (const filePath of filePaths) {
    if (!filePath.match(/\.(ts|tsx)$/) || filePath.endsWith('.d.ts')) continue;
    try {
      const content = await getFileContent(owner, repo, filePath);
      if (content.includes(packageName)) {
        sources.set(filePath, content);
      }
    } catch {}
  }
  return sources;
}

export async function classifyBump(
  owner: string,
  repo: string,
  bump: PlannedBump,
): Promise<ClassificationResult> {
  // Tier 2: type definition diff
  console.log(`    Tier 2: type diff for ${bump.packageName}...`);
  const typeDiff = getPackageTypeDiff(bump.packageName, bump.currentVersion, bump.targetVersion);
  if (typeDiff.hasDtsChanges) {
    console.log(`    Got ${typeDiff.diff.split('\n').length} lines of type changes`);
  }

  // Tier 3: changelog/release notes extraction
  const breakingChanges = await extractBreakingChanges(bump);
  const bcData = breakingChanges.changes.map((c) => {
    const entry: { api: string; kind: string; description: string; migrationHint?: string } = {
      api: c.api, kind: c.kind, description: c.description,
    };
    if (c.migrationHint) entry.migrationHint = c.migrationHint;
    return entry;
  });

  // Scan for usage (needed for LLM classification)
  const usageHits = await scanForUsage(owner, repo, breakingChanges, bump.packageName);
  const filesWithUsage = [...new Set(usageHits.map((h) => h.file))];

  // Tier 1: compile check (TypeScript repos only)
  // When changelog found nothing, usageHits is empty — find files independently
  const compileFiles = filesWithUsage.length > 0
    ? filesWithUsage
    : await findFilesImporting(owner, repo, bump.packageName);
  const sourceFiles = await collectSourceFiles(owner, repo, bump.packageName, compileFiles);
  let compileResult = { errors: [] as { file: string; line: number; message: string }[], ran: false };
  if (sourceFiles.size > 0) {
    console.log(`    Tier 1: compile check (${sourceFiles.size} files)...`);
    compileResult = await compileCheck(bump.packageName, bump.targetVersion, sourceFiles);
    if (compileResult.errors.length > 0) {
      console.log(`    Found ${compileResult.errors.length} compile errors`);
    }
  }

  // Compiler errors are definitive — auto-risky
  if (compileResult.errors.length > 0) {
    const compilerFindings = compileResult.errors.map((e) => ({
      file: e.file,
      line: e.line,
      isAffected: true,
      analysis: `Compiler error: ${e.message}`,
    }));

    const errorSummary = compileResult.errors
      .map((e) => `${e.file}:${e.line}: ${e.message}`)
      .join('; ');

    return {
      verdict: 'risky',
      reason: `TypeScript compilation fails with the new version. ${errorSummary}`,
      breakingChanges: bcData.length > 0 ? bcData : compileResult.errors.map((e) => ({
        api: extractApiFromError(e.message),
        kind: 'removed' as const,
        description: e.message,
      })),
      findings: compilerFindings,
    };
  }

  // No breaking changes from changelog and no type diff — likely safe
  if (!breakingChanges.hasBreakingChanges && !typeDiff.hasDtsChanges) {
    const from = bump.currentVersion.split('.')[0];
    const to = bump.targetVersion.split('.')[0];
    const isMajorBump = from !== to;
    if (isMajorBump && !compileResult.ran) {
      return {
        verdict: 'unknown',
        reason: `Major version bump (${from}.x → ${to}.x) but no breaking changes found in release notes or type definitions. Manual review recommended.`,
        breakingChanges: [],
        findings: [],
      };
    }
    if (isMajorBump && compileResult.ran) {
      return {
        verdict: 'safe',
        reason: `Major version bump but code compiles cleanly against the new version and no breaking changes found.`,
        breakingChanges: [],
        findings: [],
      };
    }
    return { verdict: 'safe', reason: 'No breaking changes in release notes.', breakingChanges: [], findings: [] };
  }

  if (usageHits.length === 0 && !typeDiff.hasDtsChanges) {
    return {
      verdict: 'safe',
      reason: `Breaking changes found (${bcData.map((c) => c.api).join(', ')}) but no usage of those APIs in this codebase.`,
      breakingChanges: bcData,
      findings: [],
    };
  }

  if (usageHits.length === 0 && typeDiff.hasDtsChanges && compileResult.ran) {
    return {
      verdict: 'safe',
      reason: `Type definitions changed but code compiles cleanly against the new version.`,
      breakingChanges: bcData,
      findings: [],
    };
  }

  // Build evidence for the LLM
  const evidenceSections: string[] = [];

  if (typeDiff.hasDtsChanges) {
    evidenceSections.push(`## Type definition changes (npm diff of .d.ts files)
This is the actual structural diff of the package's TypeScript type definitions between the old and new versions. Removed exports, changed signatures, and renamed APIs appear here as concrete evidence.

\`\`\`diff
${typeDiff.diff}
\`\`\``);
  }

  if (breakingChanges.hasBreakingChanges) {
    evidenceSections.push(`## Breaking changes from release notes
${breakingChanges.changes.map((c) => {
  let line = `- **${c.kind}**: \`${c.api}\` — ${c.description}`;
  if (c.migrationHint) line += `\n  Migration: ${c.migrationHint}`;
  return line;
}).join('\n')}`);
  }

  if (compileResult.ran && compileResult.errors.length === 0) {
    evidenceSections.push(`## Compile check result
The codebase compiles successfully against ${bump.packageName}@${newVersion(bump)}. This means type-level API changes (removed exports, changed signatures) do NOT affect this code. However, runtime behaviour changes may still apply.`);
  }

  const { output } = await withRetry(() =>
    ai.generate({
      prompt: `You are a dependency upgrade safety classifier. Analyse each usage hit against the evidence and give a concrete verdict.

Package: ${bump.packageName}
Upgrade: ${bump.currentVersion} → ${bump.targetVersion}

${evidenceSections.join('\n\n')}

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
- The type definition diff is concrete evidence of what actually changed in the API. If a function or class is removed in the diff, code that calls it IS affected. If the diff shows a signature change, check if the code uses the changed parameters.
- If the compile check passed, type-level breakages are ruled out — focus on runtime behaviour changes only.
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

function newVersion(bump: PlannedBump): string {
  return bump.targetVersion;
}

function extractApiFromError(message: string): string {
  const propMatch = message.match(/Property '(\w+)' does not exist/);
  if (propMatch) return propMatch[1];
  const moduleMatch = message.match(/Cannot find module '([^']+)'/);
  if (moduleMatch) return moduleMatch[1];
  return 'unknown';
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
