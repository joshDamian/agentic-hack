import fs from 'node:fs';
import path from 'node:path';
import { z } from 'genkit';
import { ai } from '../../genkit.js';
import { extractBreakingChanges } from './changelog.js';
import { safetyAgent, verdictSchema } from './agent.js';
import { getCampaign, updateCampaign } from '../../tools/firestore/client.js';
import { compileCheck } from '../../tools/npm/compile-check.js';
import { getRepoSnapshot } from '../../tools/github/zipball.js';
import type { BumpVerdict, PlannedBump } from '../../shared/types.js';

export { clearFileCache } from './usage.js';

const MAX_FILES = 10;
const MAX_LINES_PER_FILE = 500;

async function gatherSourceFiles(
  owner: string, repo: string, packageName: string, ref?: string,
): Promise<Map<string, string>> {
  const matched = new Map<string, string>();
  try {
    const root = await getRepoSnapshot(owner, repo, ref);
    const walk = (dir: string, prefix: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (matched.size >= MAX_FILES) return;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
          walk(path.join(dir, entry.name), rel);
        } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts') && rel.startsWith('src/')) {
          const content = fs.readFileSync(path.join(dir, entry.name), 'utf-8');
          if (content.includes(packageName)) {
            matched.set(rel, content);
          }
        }
      }
    };
    walk(root, '');
  } catch {}
  return matched;
}

function formatCodeContext(files: Map<string, string>): string {
  if (files.size === 0) return 'No source files import this package.';
  return [...files.entries()].map(([filePath, content]) => {
    const lines = content.split('\n');
    const trimmed = lines.length > MAX_LINES_PER_FILE
      ? lines.slice(0, MAX_LINES_PER_FILE).join('\n') + `\n... (${lines.length - MAX_LINES_PER_FILE} more lines)`
      : content;
    const numbered = trimmed.split('\n').map((line, i) => `${i + 1} | ${line}`).join('\n');
    return `--- ${filePath} ---\n${numbered}`;
  }).join('\n\n');
}

export interface ClassificationResult {
  verdict: 'safe' | 'risky' | 'unknown';
  reason: string;
  breakingChanges: PlannedBump['breakingChanges'];
  findings: PlannedBump['findings'];
}

export interface PrepResult {
  bcData: NonNullable<PlannedBump['breakingChanges']>;
  bcSection: string;
  isMajor: boolean;
  codeContext: string;
  compileSection: string;
}

export async function prepBump(
  owner: string,
  repo: string,
  bump: PlannedBump,
  ref?: string,
): Promise<PrepResult> {
  const [breakingChanges, sourceFiles] = await Promise.all([
    extractBreakingChanges(bump),
    gatherSourceFiles(owner, repo, bump.packageName, ref),
  ]);

  const bcData = breakingChanges.changes.map((c) => {
    const entry: { api: string; kind: string; description: string; migrationHint?: string } = {
      api: c.api, kind: c.kind, description: c.description,
    };
    if (c.migrationHint) entry.migrationHint = c.migrationHint;
    return entry;
  });

  let bcSection = '';
  if (breakingChanges.hasBreakingChanges) {
    bcSection = `\n\nKnown breaking changes from release notes:\n${breakingChanges.changes.map((c) => {
      let line = `- ${c.kind}: \`${c.api}\` — ${c.description}`;
      if (c.migrationHint) line += `\n  Migration: ${c.migrationHint}`;
      return line;
    }).join('\n')}`;
  }

  const from = bump.currentVersion.split('.')[0];
  const to = bump.targetVersion.split('.')[0];
  const isMajor = from !== to;

  const codeContext = formatCodeContext(sourceFiles);

  let compileSection = '';
  if (sourceFiles.size > 0) {
    try {
      const ccResult = await compileCheck(bump.packageName, bump.targetVersion, sourceFiles);
      if (!ccResult.ran) {
        compileSection = '\n\nCompile check: could not run (install failed).';
      } else if (ccResult.errors.length === 0) {
        compileSection = '\n\nCompile check against target version: **PASSED** — no type errors.';
      } else {
        const errorLines = ccResult.errors.map((e) => `  ${e.file}:${e.line} — ${e.message}`).join('\n');
        compileSection = `\n\nCompile check against target version: **FAILED** — ${ccResult.errors.length} error(s):\n${errorLines}`;
      }
    } catch (err) {
      compileSection = `\n\nCompile check: error — ${err instanceof Error ? err.message : err}`;
    }
  }

  return { bcData, bcSection, isMajor, codeContext, compileSection };
}

export async function classifyPreparedBump(
  owner: string,
  repo: string,
  bump: PlannedBump,
  prep: PrepResult,
  ref?: string,
): Promise<ClassificationResult> {
  const { bcData, bcSection, isMajor, codeContext, compileSection } = prep;
  const from = bump.currentVersion.split('.')[0];
  const to = bump.targetVersion.split('.')[0];

  const prompt = `Investigate whether upgrading **${bump.packageName}** from ${bump.currentVersion} to ${bump.targetVersion} will break the repository **${owner}/${repo}**.${isMajor ? ` This is a major version bump (${from}.x → ${to}.x) — be extra thorough.` : ''}

Repository: owner="${owner}", repo="${repo}"${ref ? `, ref="${ref}"` : ''}
Package: ${bump.packageName}
Current version: ${bump.currentVersion}
Target version: ${bump.targetVersion}${bcSection}${compileSection}

Source files that import ${bump.packageName}:

${codeContext}

Analyse each file's usage against the breaking changes. The compile check result above is definitive for type errors — if it failed, the verdict must be "risky". Use getTypeDiff if you need more detail on what changed.`;

  let response;
  try {
    const chat = safetyAgent.chat();
    response = await chat.send(prompt);
  } catch (err: any) {
    if (err?.status === 'ABORTED' && err?.details?.response) {
      const partial = err.details.response;
      response = { text: partial.text?.() ?? partial.message?.text?.() ?? '' };
    } else {
      throw err;
    }
  }

  return parseAgentResponse(response.text, bcData);
}

function parseAgentResponse(
  responseText: string,
  bcData: NonNullable<PlannedBump['breakingChanges']>,
): ClassificationResult {
  let result: z.infer<typeof verdictSchema> | null = null;
  const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/) ?? responseText.match(/(\{[\s\S]*\})/);
  const raw = jsonMatch?.[1]?.trim() ?? responseText.trim();
  try {
    result = verdictSchema.parse(JSON.parse(raw));
  } catch {
    return {
      verdict: 'unknown' as const,
      reason: 'Safety agent did not produce a structured verdict.',
      breakingChanges: bcData,
      findings: [],
    };
  }

  return {
    verdict: result.verdict,
    reason: result.reason,
    breakingChanges: bcData.length > 0 ? bcData : [],
    findings: result.findings.map((f) => {
      const entry: { file: string; line: number; isAffected: boolean; analysis: string; originalCode?: string; suggestedFix?: string } = {
        file: f.file, line: f.line, isAffected: f.isAffected, analysis: f.analysis,
      };
      if (f.originalCode) entry.originalCode = f.originalCode;
      if (f.suggestedFix) entry.suggestedFix = f.suggestedFix;
      return entry;
    }),
  };
}

export async function classifyBump(
  owner: string,
  repo: string,
  bump: PlannedBump,
  ref?: string,
): Promise<ClassificationResult> {
  const prep = await prepBump(owner, repo, bump, ref);
  return classifyPreparedBump(owner, repo, bump, prep, ref);
}

export async function reanalyseWithCIErrors(
  owner: string,
  repo: string,
  bump: PlannedBump,
  ciErrors: string,
): Promise<ClassificationResult> {
  const branchName = `depbot-triage/${bump.packageName}-${bump.targetVersion}`;
  const sourceFiles = await gatherSourceFiles(owner, repo, bump.packageName, branchName);
  const codeContext = formatCodeContext(sourceFiles);

  const previousFindings = (bump.findings ?? [])
    .filter((f) => f.isAffected)
    .map((f) => `- ${f.file}:${f.line} — ${f.analysis}`)
    .join('\n');

  const prompt = `Re-analyse the upgrade of **${bump.packageName}** from ${bump.currentVersion} to ${bump.targetVersion} in **${owner}/${repo}**.

The previous analysis marked this bump as "${bump.verdict}", but **CI failed** on the PR branch. The CI errors below are the ground truth — the build is broken.

CI error output:
\`\`\`
${ciErrors}
\`\`\`

${previousFindings ? `Previous findings:\n${previousFindings}\n` : ''}
Source files on the PR branch (${branchName}):

${codeContext}

Based on the CI errors, identify every affected file and line. The verdict must be "risky" since CI failed. For each affected finding, include originalCode (the exact code from the file) and suggestedFix (the corrected code).`;

  let response;
  try {
    const chat = safetyAgent.chat();
    response = await chat.send(prompt);
  } catch (err: any) {
    if (err?.status === 'ABORTED' && err?.details?.response) {
      const partial = err.details.response;
      response = { text: partial.text?.() ?? partial.message?.text?.() ?? '' };
    } else {
      throw err;
    }
  }

  return parseAgentResponse(response.text, bump.breakingChanges ?? []);
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

    const results: Array<{ packageName: string; verdict: 'safe' | 'risky' | 'unknown'; reason: string }> = [];

    for (const bump of campaign.plan) {
      console.log(`Analysing ${bump.packageName}...`);
      const result = await classifyBump(campaign.repoOwner, campaign.repoName, bump);
      bump.verdict = result.verdict;
      bump.verdictReason = result.reason;
      bump.breakingChanges = result.breakingChanges;
      bump.findings = result.findings;
      results.push({ packageName: bump.packageName, verdict: result.verdict, reason: result.reason });
      await updateCampaign(campaignId, { plan: campaign.plan });
    }

    return { campaignId, results };
  },
);
