import { z } from 'genkit';
import { ai } from '../../genkit.js';
import { extractBreakingChanges } from './changelog.js';
import { scanForUsage, clearFileCache } from './usage.js';
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
  analysis: z.string().describe('What the code does + what the package changed that breaks it. State facts, no hedging. One sentence.'),
  suggestedFix: z.string().optional().describe('If affected, the corrected code snippet — code only, no prose'),
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
  ref?: string,
): Promise<string[]> {
  // Walk the git tree — code search index lags on recent pushes,
  // so the tree walk is the only reliable source for all files.
  // collectSourceFiles filters to files that actually contain the package name.
  try {
    const octokit = await getInstallationOctokit();
    const { data: tree } = await octokit.rest.git.getTree({
      owner, repo, tree_sha: ref ?? 'HEAD', recursive: 'true',
    });
    return tree.tree
      .filter((f) => f.type === 'blob' && f.path?.match(/\.(ts|tsx)$/) && !f.path.endsWith('.d.ts'))
      .map((f) => f.path!)
      .filter((p) => p.startsWith('src/'));
  } catch {
    return [];
  }
}

async function collectSourceFiles(
  owner: string,
  repo: string,
  packageName: string,
  filePaths: string[],
  ref?: string,
): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  for (const filePath of filePaths) {
    if (!filePath.match(/\.(ts|tsx)$/) || filePath.endsWith('.d.ts')) continue;
    try {
      const content = await getFileContent(owner, repo, filePath, ref);
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
  ref?: string,
): Promise<ClassificationResult> {
  clearFileCache();
  const typeDiff = getPackageTypeDiff(bump.packageName, bump.currentVersion, bump.targetVersion);

  // Tier 3: changelog/release notes extraction
  const breakingChanges = await extractBreakingChanges(bump);
  const bcData = breakingChanges.changes.map((c) => {
    const entry: { api: string; kind: string; description: string; migrationHint?: string } = {
      api: c.api, kind: c.kind, description: c.description,
    };
    if (c.migrationHint) entry.migrationHint = c.migrationHint;
    return entry;
  });

  // Discover all files importing this package via git tree walk (reliable)
  const importingFiles = await findFilesImporting(owner, repo, bump.packageName, ref);
  const sourceFiles = await collectSourceFiles(owner, repo, bump.packageName, importingFiles, ref);
  const knownFiles = [...sourceFiles.keys()];

  // Scan for usage — pass known files so code search lag doesn't miss any
  const usageHits = await scanForUsage(owner, repo, breakingChanges, bump.packageName, ref, knownFiles);
  const filesWithUsage = [...new Set(usageHits.map((h) => h.file))];
  let compileResult = { errors: [] as { file: string; line: number; message: string }[], ran: false };
  if (sourceFiles.size > 0) {
    compileResult = await compileCheck(bump.packageName, bump.targetVersion, sourceFiles);
  }

  // Compiler errors are definitive — auto-risky
  if (compileResult.errors.length > 0) {
    const seen = new Set<string>();
    const compilerFindings = compileResult.errors
      .filter((e) => {
        const key = `${e.file}:${e.line}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((e) => ({
        file: e.file,
        line: e.line,
        isAffected: true,
        analysis: formatCompilerFinding(e, bump, typeDiff.hasDtsChanges ? typeDiff.diff : undefined),
      }));

    const affectedApis = [...new Set(compileResult.errors.map((e) => `\`${extractApiFromError(e.message)}\``))];
    const affectedFiles = [...new Set(compileResult.errors.map((e) => `\`${e.file}\``))];

    return {
      verdict: 'risky',
      reason: `Code in ${affectedFiles.join(', ')} uses ${affectedApis.join(', ')} which ${compileResult.errors.length === 1 ? 'no longer exists' : 'no longer exist'} in ${bump.packageName}@${bump.targetVersion}. This will fail to compile after the upgrade.`,
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
        reason: `${bump.packageName} ${from}.x → ${to}.x is a major version bump, but no breaking changes found in release notes and the code compiles cleanly against ${bump.targetVersion}.`,
        breakingChanges: [],
        findings: [],
      };
    }
    return { verdict: 'safe', reason: `No breaking changes found in ${bump.packageName} ${bump.currentVersion} → ${bump.targetVersion} release notes.`, breakingChanges: [], findings: [] };
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
    const changesSummary = bcData.length > 0
      ? `Breaking changes in ${bump.packageName} ${bump.targetVersion} (${bcData.map((c) => c.api).join(', ')}) don't affect this codebase — no usage found and code compiles cleanly.`
      : `${bump.packageName} type definitions changed in ${bump.targetVersion}, but code compiles cleanly against the new version.`;
    return {
      verdict: 'safe',
      reason: changesSummary,
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
- Set isAffected to false for: import statements, function/type declarations, false positive text matches, comments, unrelated code.
- The type definition diff is concrete evidence of what actually changed in the API. If a function or class is removed in the diff, code that calls it IS affected. If the diff shows a signature change, check if the code uses the changed parameters.
- If the compile check passed, type-level breakages are ruled out — focus on runtime behaviour changes only.
- In analysis, state exactly what the code does and exactly what the package changed that breaks it. No hedging ("by default", "may", "might") — say what happens. If something was removed, say "removed", not "rejected by default". One sentence.
- If affected, provide suggestedFix with ONLY the corrected code snippet (no English explanation, no "Remove X" instructions — just the replacement code).
- SKIP trivial hits entirely — do NOT emit a finding for import statements, type declarations, or lines that only reference the package name without calling any API. Only emit findings for lines where the code actually calls, accesses, or passes a value related to a breaking change.

For the overall verdict:
- "risky" if ANY usage is affected. Cite the file:line in the reason.
- "safe" if all hits are false positives or unaffected. Say why in one sentence.
- "unknown" only if the code is too ambiguous to classify.

In the reason field, write one composed sentence: what changed, what this code uses, and whether it's affected.`,
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
  const callMatch = message.match(/is not callable|is not a function|not assignable.*'(\w+)'/);
  if (callMatch) return callMatch[1] ?? 'default export';
  return 'unknown';
}

function confirmedInDiff(diff: string, removed: string, added: string): boolean {
  const lines = diff.split('\n');
  let sawRemoval = false;
  let sawAddition = false;
  const removedRe = new RegExp(`\\b${removed}\\b`);
  const addedRe = new RegExp(`\\b${added}\\b`);
  for (const line of lines) {
    if (line.startsWith('-') && removedRe.test(line)) sawRemoval = true;
    if (line.startsWith('+') && addedRe.test(line)) sawAddition = true;
    if (sawRemoval && sawAddition) return true;
  }
  return false;
}

function formatCompilerFinding(
  error: { file: string; line: number; message: string; suggestion?: string },
  bump: PlannedBump,
  typeDiff?: string,
): string {
  const api = extractApiFromError(error.message);
  const suggestion = error.message.match(/Did you mean '(\w+)'/)?.[1];

  if (suggestion) {
    if (typeDiff && confirmedInDiff(typeDiff, api, suggestion)) {
      return `\`${api}\` was replaced by \`${suggestion}\` in ${bump.packageName}@${bump.targetVersion}. Update the call at line ${error.line} — check the new signature before assuming it's a drop-in.`;
    }
    return `\`${api}\` no longer exists in ${bump.packageName}@${bump.targetVersion}. The closest available API is \`${suggestion}\` — check whether it's a drop-in replacement or requires changes.`;
  }

  if (error.message.includes('does not exist on type')) {
    return `\`${api}\` no longer exists in ${bump.packageName}@${bump.targetVersion}. This call at line ${error.line} will break after the upgrade.`;
  }

  if (error.message.includes('is not callable') || error.message.includes('is not a function')) {
    return `The default export of ${bump.packageName} is no longer callable in version ${bump.targetVersion}. The call at line ${error.line} needs to be updated to the new API.`;
  }

  return `${bump.packageName}@${bump.targetVersion} introduces a type incompatibility at line ${error.line}: ${error.message}`;
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
