import { z } from 'genkit';
import { ai } from '../genkit.js';
import { getFileContent, getInstallationOctokit } from './github/client.js';
import { compileCheck } from './npm/compile-check.js';
import { getPackageTypeDiff } from './npm/typediff.js';

export const readRepoFile = ai.defineTool(
  {
    name: 'readRepoFile',
    description: 'Read a file from the repository. Returns the file contents as a string.',
    inputSchema: z.object({
      owner: z.string(),
      repo: z.string(),
      path: z.string().describe('File path relative to repo root, e.g. src/lib/utils.ts'),
      ref: z.string().optional().describe('Git ref (branch, tag, SHA). Defaults to HEAD.'),
    }),
    outputSchema: z.string(),
  },
  async ({ owner, repo, path, ref }) => {
    try {
      return await getFileContent(owner, repo, path, ref);
    } catch (err: any) {
      return `Error reading ${path}: ${err.message ?? err}`;
    }
  },
);

export const listRepoFiles = ai.defineTool(
  {
    name: 'listRepoFiles',
    description: 'List TypeScript source files in the repository (under src/). Returns file paths, one per line.',
    inputSchema: z.object({
      owner: z.string(),
      repo: z.string(),
      ref: z.string().optional(),
    }),
    outputSchema: z.string(),
  },
  async ({ owner, repo, ref }) => {
    try {
      const octokit = await getInstallationOctokit();
      const { data: tree } = await octokit.rest.git.getTree({
        owner, repo, tree_sha: ref ?? 'HEAD', recursive: 'true',
      });
      const files = tree.tree
        .filter((f) => f.type === 'blob' && f.path?.match(/\.(ts|tsx)$/) && !f.path.endsWith('.d.ts'))
        .map((f) => f.path!)
        .filter((p) => p.startsWith('src/'));
      return files.join('\n');
    } catch (err: any) {
      return `Error listing files: ${err.message ?? err}`;
    }
  },
);

export const searchCodeInRepo = ai.defineTool(
  {
    name: 'searchCodeInRepo',
    description: 'Search for a text pattern in the repository source files. Returns matching lines with file paths, line numbers, and surrounding context.',
    inputSchema: z.object({
      owner: z.string(),
      repo: z.string(),
      pattern: z.string().describe('Text to search for (exact match, not regex)'),
      ref: z.string().optional(),
    }),
    outputSchema: z.string(),
  },
  async ({ owner, repo, pattern, ref }) => {
    let files: string[];
    try {
      const octokit = await getInstallationOctokit();
      const { data: tree } = await octokit.rest.git.getTree({
        owner, repo, tree_sha: ref ?? 'HEAD', recursive: 'true',
      });
      files = tree.tree
        .filter((f) => f.type === 'blob' && f.path?.match(/\.(ts|tsx)$/) && !f.path.endsWith('.d.ts'))
        .map((f) => f.path!)
        .filter((p) => p.startsWith('src/'));
    } catch (err: any) {
      return `Error listing repo tree: ${err.message ?? err}`;
    }

    const results: string[] = [];
    for (const filePath of files) {
      if (results.length > 50) break;
      try {
        const content = await getFileContent(owner, repo, filePath, ref);
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(pattern)) {
            const start = Math.max(0, i - 2);
            const end = Math.min(lines.length, i + 3);
            const context = lines.slice(start, end).map((l, idx) => {
              const lineNum = start + idx + 1;
              const marker = lineNum === i + 1 ? '→' : ' ';
              return `${marker} ${lineNum} | ${l}`;
            }).join('\n');
            results.push(`${filePath}:${i + 1}\n${context}`);
          }
        }
      } catch {}
    }
    return results.length > 0 ? results.join('\n\n') : 'No matches found.';
  },
);

export const runCompileCheck = ai.defineTool(
  {
    name: 'runCompileCheck',
    description: 'Compile-check the repository source files against a specific package version. Installs the target version in an isolated directory and runs tsc. Returns compiler errors or "Clean — no errors" if compilation succeeds.',
    inputSchema: z.object({
      owner: z.string(),
      repo: z.string(),
      packageName: z.string(),
      targetVersion: z.string(),
      ref: z.string().optional(),
    }),
    outputSchema: z.string(),
  },
  async ({ owner, repo, packageName, targetVersion, ref }) => {
    let files: string[];
    try {
      const octokit = await getInstallationOctokit();
      const { data: tree } = await octokit.rest.git.getTree({
        owner, repo, tree_sha: ref ?? 'HEAD', recursive: 'true',
      });
      files = tree.tree
        .filter((f) => f.type === 'blob' && f.path?.match(/\.(ts|tsx)$/) && !f.path.endsWith('.d.ts'))
        .map((f) => f.path!)
        .filter((p) => p.startsWith('src/'));
    } catch (err: any) {
      return `Error listing repo tree: ${err.message ?? err}`;
    }

    const sourceFiles = new Map<string, string>();
    for (const filePath of files) {
      try {
        const content = await getFileContent(owner, repo, filePath, ref);
        if (content.includes(packageName)) {
          sourceFiles.set(filePath, content);
        }
      } catch {}
    }

    if (sourceFiles.size === 0) return 'No source files import this package.';

    try {
      const result = await compileCheck(packageName, targetVersion, sourceFiles);
      if (!result.ran) return 'Compile check did not run (no relevant source files).';
      if (result.errors.length === 0) return 'Clean — no errors.';

      return result.errors.map((e) =>
        `${e.file}:${e.line} — ${e.message}`
      ).join('\n');
    } catch (err: any) {
      return `Compile check failed: ${err.message ?? err}`;
    }
  },
);

export const getTypeDiffTool = ai.defineTool(
  {
    name: 'getTypeDiff',
    description: 'Get the diff of TypeScript type definitions (.d.ts files) between two versions of a package. Shows what APIs changed, were added, or removed.',
    inputSchema: z.object({
      packageName: z.string(),
      oldVersion: z.string(),
      newVersion: z.string(),
    }),
    outputSchema: z.string(),
  },
  async ({ packageName, oldVersion, newVersion }) => {
    try {
      const result = getPackageTypeDiff(packageName, oldVersion, newVersion);
      if (!result.hasDtsChanges) return 'No type definition changes between these versions.';
      return result.diff;
    } catch (err: any) {
      return `Type diff failed: ${err.message ?? err}`;
    }
  },
);
