import { z } from 'genkit';
import { ai } from '../../genkit.js';
import { resolveGitHubRepo } from '../../tools/npm/registry.js';
import { fetchReleaseNotes } from '../../tools/github/releases.js';
import type { PlannedBump } from '../../shared/types.js';

export const breakingChangeSchema = z.object({
  hasBreakingChanges: z.boolean(),
  changes: z.array(z.object({
    api: z.string().describe('The removed, renamed, or changed function/method/option name'),
    kind: z.enum(['removed', 'renamed', 'signature-changed', 'behavior-changed', 'other']),
    description: z.string().describe('One-line summary of what changed'),
    migrationHint: z.string().optional().describe('What to use instead, if mentioned'),
  })),
});

export type BreakingChanges = z.infer<typeof breakingChangeSchema>;

export async function extractBreakingChanges(bump: PlannedBump): Promise<BreakingChanges> {
  const repo = await resolveGitHubRepo(bump.packageName);
  if (!repo) {
    return { hasBreakingChanges: false, changes: [] };
  }

  const releaseNotes = await fetchReleaseNotes(
    repo.repoOwner,
    repo.repoName,
    bump.currentVersion,
    bump.targetVersion,
  );

  if (releaseNotes.startsWith('No release notes found')) {
    return { hasBreakingChanges: false, changes: [] };
  }

  const { output } = await ai.generate({
    prompt: `You are analysing release notes for the npm package "${bump.packageName}" to identify breaking changes between version ${bump.currentVersion} and ${bump.targetVersion}.

Extract every breaking change — removed APIs, renamed functions, changed method signatures, changed default behaviour. Focus on changes that would require code modifications.

If there are no breaking changes, set hasBreakingChanges to false and return an empty changes array.

Release notes:

${releaseNotes}`,
    output: { schema: breakingChangeSchema },
  });

  return output!;
}
