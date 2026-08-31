import { z } from 'genkit';
import { ai, classificationModel } from '../../genkit.js';
import { readRepoFile, listRepoFiles, searchCodeInRepo, runCompileCheck, getPackageDocs } from '../../tools/agent-tools.js';
import { getInstallationOctokit, getFileContent } from '../../tools/github/client.js';
import { bustSnapshot } from '../../tools/github/zipball.js';

const commitFixTool = ai.defineTool(
  {
    name: 'commitFix',
    description: 'Replace a section of code in a file on a PR branch. Reads the current file, replaces oldCode with newCode, and commits the change.',
    inputSchema: z.object({
      owner: z.string(),
      repo: z.string(),
      branch: z.string().describe('The PR branch name, e.g. depbot-triage/marked-14.0.0'),
      filePath: z.string().describe('Path to the file to edit, e.g. src/lib/utils.ts'),
      oldCode: z.string().describe('The exact code to replace — must match the file contents exactly'),
      newCode: z.string().describe('The replacement code'),
      commitMessage: z.string().describe('Short commit message describing the fix'),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      commitSha: z.string().optional(),
      error: z.string().optional(),
    }),
  },
  async ({ owner, repo, branch, filePath, oldCode, newCode, commitMessage }) => {
    if (filePath === 'package-lock.json') {
      return { success: false, error: 'Editing package-lock.json is not allowed — it is managed by npm' };
    }
    if (filePath.endsWith('.json') && (/\/\/\s/.test(newCode) || /\/\*/.test(newCode))) {
      return { success: false, error: 'Cannot write JS-style comments into JSON files' };
    }

    try {
      const octokit = await getInstallationOctokit();

      const content = await getFileContent(owner, repo, filePath, branch);
      if (!content.includes(oldCode)) {
        return { success: false, error: 'oldCode not found in file — check exact whitespace and content' };
      }

      const updated = content.replace(oldCode, newCode);

      const { data: refData } = await octokit.rest.git.getRef({
        owner, repo, ref: `heads/${branch}`,
      });
      const headSha = refData.object.sha;

      const { data: baseCommit } = await octokit.rest.git.getCommit({
        owner, repo, commit_sha: headSha,
      });

      const { data: blob } = await octokit.rest.git.createBlob({
        owner, repo,
        content: Buffer.from(updated).toString('base64'),
        encoding: 'base64',
      });

      const { data: tree } = await octokit.rest.git.createTree({
        owner, repo,
        base_tree: baseCommit.tree.sha,
        tree: [{ path: filePath, mode: '100644', type: 'blob', sha: blob.sha }],
      });

      const { data: commit } = await octokit.rest.git.createCommit({
        owner, repo,
        message: commitMessage,
        tree: tree.sha,
        parents: [headSha],
      });

      await octokit.rest.git.updateRef({
        owner, repo,
        ref: `heads/${branch}`,
        sha: commit.sha,
      });

      bustSnapshot(owner, repo, branch);
      return { success: true, commitSha: commit.sha };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
);

export const coderAgent = ai.defineAgent({
  name: 'codingAssistant',
  model: classificationModel,
  tools: [readRepoFile, listRepoFiles, searchCodeInRepo, runCompileCheck, getPackageDocs, commitFixTool],
  maxTurns: 20,
  system: `You are a coding assistant that applies fixes for breaking dependency upgrades.

When asked to apply a fix:
1. Read the affected file to see the current code in context — not just the finding line, but enough surrounding code to understand what the fix touches.
2. If CI errors are provided, those are ground truth. The build is broken at those exact lines. Fix the actual errors, not just what the suggested fix says.
3. If a suggested fix is provided, verify it makes sense in context. Check imports, variable names, function signatures. Adapt or rewrite it if the suggestion doesn't fit.
4. If the fix changes an API call, use getPackageDocs to check the correct API for the target version. Don't guess parameter order or method names.
5. Use searchCodeInRepo to find other call sites that might need the same fix — a renamed API usually appears in more than one file.
6. Use commitFix to apply each change. Make sure oldCode matches the file exactly (whitespace matters).
7. After all commits, run runCompileCheck to verify. If it fails, read the errors, fix them, and commit again.

If this is a retry (attempt 2+), previous fixes didn't work. Read the current file state — don't re-apply the same change. Look at what the previous commits changed and what's still broken.
Never edit package-lock.json. You may edit package.json and tsconfig.json if needed. Never write comments into JSON files.`,
});
