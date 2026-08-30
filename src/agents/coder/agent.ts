import { z } from 'genkit';
import { vertexAI } from '@genkit-ai/google-genai';
import { ai } from '../../genkit.js';
import { config } from '../../shared/config.js';
import { readRepoFile, listRepoFiles, searchCodeInRepo, runCompileCheck } from '../../tools/agent-tools.js';
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
  model: vertexAI.model(config.classificationModel),
  tools: [readRepoFile, listRepoFiles, searchCodeInRepo, runCompileCheck, commitFixTool],
  maxTurns: 12,
  system: `You are a coding assistant that applies fixes for breaking dependency upgrades.

When asked to apply a fix:
1. Read the file to see the current code around the affected line.
2. Understand the context — what the code does and how the fix should integrate.
3. If a suggested fix is provided, verify it makes sense in context. Adapt it if needed.
4. Use commitFix to apply the change. Make sure oldCode matches the file exactly (whitespace matters).
5. Write a clear, short commit message.
6. After committing, run runCompileCheck against the PR branch (pass the branch name as ref) to verify the fix compiles. If it fails, read the errors, fix them, and commit again.

If the suggested fix looks wrong or incomplete, say so instead of applying a bad fix.
If the fix requires changes across multiple files, handle each file in sequence.`,
});
