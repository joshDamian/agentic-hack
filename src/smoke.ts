import 'dotenv/config';
import { extractBreakingChanges } from './agents/safety/changelog.js';
import { scanForUsage } from './agents/safety/usage.js';
import { ai } from './genkit.js';
import { z } from 'genkit';
import type { PlannedBump, BumpVerdict } from './shared/types.js';

const verdictSchema = z.object({
  verdict: z.enum(['safe', 'risky', 'unknown']),
  reason: z.string(),
});

async function classifyBump(
  owner: string,
  repo: string,
  bump: PlannedBump,
): Promise<{ verdict: BumpVerdict; reason: string }> {
  const breakingChanges = await extractBreakingChanges(bump);

  if (!breakingChanges.hasBreakingChanges) {
    return { verdict: 'safe', reason: 'No breaking changes in release notes' };
  }

  const usageHits = await scanForUsage(owner, repo, breakingChanges);

  if (usageHits.length === 0) {
    return {
      verdict: 'safe',
      reason: `Breaking changes exist but none affect this codebase`,
    };
  }

  console.log(`  Usage hits: ${usageHits.map((h) => `${h.file}:${h.line}`).join(', ')}`);

  const { output } = await ai.generate({
    prompt: `You are a dependency upgrade safety classifier.

Package: ${bump.packageName}
Upgrade: ${bump.currentVersion} → ${bump.targetVersion}

Breaking changes:
${breakingChanges.changes.map((c) => `- ${c.kind}: ${c.api} — ${c.description}`).join('\n')}

Usage hits in the codebase:
${usageHits.map((h) => `- ${h.file}:${h.line}: ${h.snippet}`).join('\n')}

If the usage hits actually use the broken APIs, verdict is "risky" and cite the specific file:line.
If the usage hits are false positives (different context, comments, etc.), verdict is "safe".
If you can't tell, verdict is "unknown".`,
    output: { schema: verdictSchema },
  });

  return { verdict: output!.verdict, reason: output!.reason };
}

async function main() {
  const bump: PlannedBump = {
    packageName: 'lodash',
    ecosystem: 'npm',
    currentVersion: '4.17.19',
    targetVersion: '4.18.0',
    alertsClosed: 5,
    alertNumbers: [3, 43, 47, 57, 58],
  };

  console.log(`${bump.packageName} ${bump.currentVersion} → ${bump.targetVersion}`);
  const result = await classifyBump('joshDamian', 'depbot-test-repo', bump);
  console.log(`Verdict: ${result.verdict}`);
  console.log(`Reason: ${result.reason}`);
}
main();
