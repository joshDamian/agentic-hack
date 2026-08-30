import { z } from 'genkit';
import { ai } from '../../genkit.js';
import { extractBreakingChanges } from './changelog.js';
import { safetyAgent, verdictSchema } from './agent.js';
import { getCampaign, updateCampaign } from '../../tools/firestore/client.js';
import { getFileContent, getInstallationOctokit } from '../../tools/github/client.js';
import type { BumpVerdict, PlannedBump } from '../../shared/types.js';

export { clearFileCache } from './usage.js';

const MAX_FILES = 10;
const MAX_LINES_PER_FILE = 500;

async function gatherCodeContext(
  owner: string, repo: string, packageName: string, ref?: string,
): Promise<string> {
  let allFiles: string[];
  try {
    const octokit = await getInstallationOctokit();
    const { data: tree } = await octokit.rest.git.getTree({
      owner, repo, tree_sha: ref ?? 'HEAD', recursive: 'true',
    });
    allFiles = tree.tree
      .filter((f) => f.type === 'blob' && f.path?.match(/\.(ts|tsx)$/) && !f.path.endsWith('.d.ts'))
      .map((f) => f.path!)
      .filter((p) => p.startsWith('src/'));
  } catch {
    return 'Could not list repository files (tree fetch failed).';
  }

  const matched: Array<{ path: string; content: string }> = [];
  for (const filePath of allFiles) {
    if (matched.length >= MAX_FILES) break;
    try {
      const content = await getFileContent(owner, repo, filePath, ref);
      if (content.includes(packageName)) {
        const lines = content.split('\n');
        const trimmed = lines.length > MAX_LINES_PER_FILE
          ? lines.slice(0, MAX_LINES_PER_FILE).join('\n') + `\n... (${lines.length - MAX_LINES_PER_FILE} more lines)`
          : content;
        matched.push({ path: filePath, content: trimmed });
      }
    } catch {}
  }

  if (matched.length === 0) return 'No source files import this package.';
  return matched.map((f) => {
    const numbered = f.content.split('\n').map((line, i) => `${i + 1} | ${line}`).join('\n');
    return `--- ${f.path} ---\n${numbered}`;
  }).join('\n\n');
}

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
  ref?: string,
): Promise<ClassificationResult> {
  const breakingChanges = await extractBreakingChanges(bump);
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

  const codeContext = await gatherCodeContext(owner, repo, bump.packageName, ref);

  const prompt = `Investigate whether upgrading **${bump.packageName}** from ${bump.currentVersion} to ${bump.targetVersion} will break the repository **${owner}/${repo}**.${isMajor ? ` This is a major version bump (${from}.x → ${to}.x) — be extra thorough.` : ''}

Repository: owner="${owner}", repo="${repo}"${ref ? `, ref="${ref}"` : ''}
Package: ${bump.packageName}
Current version: ${bump.currentVersion}
Target version: ${bump.targetVersion}${bcSection}

Source files that import ${bump.packageName}:

${codeContext}

Analyse each file's usage against the breaking changes. Use runCompileCheck or getTypeDiff if you need more evidence.`;

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

  let result: z.infer<typeof verdictSchema> | null = null;
  const text = response.text;
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? text.match(/(\{[\s\S]*\})/);
  const raw = jsonMatch?.[1]?.trim() ?? text.trim();
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
