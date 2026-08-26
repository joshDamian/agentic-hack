import { z } from 'genkit';
import { ai } from '../../genkit.js';
import { resolveGitHubRepo } from '../../tools/npm/registry.js';
import { fetchReleaseNotes } from '../../tools/github/releases.js';
import type { PlannedBump } from '../../shared/types.js';
import { withRetry } from '../../shared/retry.js';
import semver from 'semver';

export const breakingChangeSchema = z.object({
  hasBreakingChanges: z.boolean(),
  changes: z.array(z.object({
    api: z.string().describe('The identifier that changed — a method, class, option, or export name (e.g. "CancelToken", "process", "Extract"). Use the bare name, not a full call expression or prose description.'),
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

  const { output } = await withRetry(() =>
    ai.generate({
      prompt: `You are analysing release notes for the npm package "${bump.packageName}" to identify breaking changes between version ${bump.currentVersion} and ${bump.targetVersion}.

Extract every breaking change — removed APIs, renamed functions, changed method signatures, changed default behaviour, dropped Node.js version support, removed options or parameters, sync-to-async migration. Focus on changes that would require code modifications.

Look carefully for sections titled "Breaking Changes", "BREAKING", "Migration", or similar. Also look for entries marked as "removed", "deprecated", "no longer supported", or "replaced by".

This is a ${semver.major(bump.targetVersion) > semver.major(bump.currentVersion) ? 'major' : 'minor/patch'} version bump. ${semver.major(bump.targetVersion) > semver.major(bump.currentVersion) ? 'Major version bumps almost always contain breaking changes — look thoroughly.' : ''}

Only set hasBreakingChanges to false if you are confident there are genuinely no breaking changes in the notes.

Release notes:

${releaseNotes}`,
      output: { schema: breakingChangeSchema },
    }),
  );

  return output!;
}
