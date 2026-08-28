import { getFileContent, getInstallationOctokit } from '../../tools/github/client.js';
import type { BreakingChanges } from './changelog.js';

export interface UsageHit {
  api: string;
  file: string;
  line: number;
  snippet: string;
  context: string;
}

const fileCache = new Map<string, string>();

let searchQueue: Promise<void> = Promise.resolve();
async function rateLimitedSearch(): Promise<void> {
  const ticket = searchQueue.then(
    () => new Promise<void>((r) => setTimeout(r, 6500)),
  );
  searchQueue = ticket;
  await ticket;
}

export function clearFileCache(): void {
  fileCache.clear();
}

async function getCachedFileContent(owner: string, repo: string, path: string, ref?: string): Promise<string> {
  const key = `${owner}/${repo}/${path}${ref ? `@${ref}` : ''}`;
  const cached = fileCache.get(key);
  if (cached !== undefined) return cached;
  const content = await getFileContent(owner, repo, path, ref);
  fileCache.set(key, content);
  return content;
}

const GENERIC_TERMS = new Set([
  'node', 'error', 'type', 'class', 'code', 'table', 'url', 'config',
  'options', 'default', 'module', 'export', 'import', 'function', 'object',
  'string', 'number', 'boolean', 'array', 'promise', 'async', 'await',
  'callback', 'event', 'data', 'name', 'value', 'key', 'path', 'file',
  'json', 'html', 'css', 'lib', 'src', 'dist', 'tag', 'log',
  'this', 'new', 'var', 'let', 'const', 'return', 'true', 'false', 'null',
  'prototype', 'constructor', 'extends', 'super', 'static', 'get', 'set',
  'try', 'catch', 'throw', 'finally', 'for', 'while', 'break', 'continue',
  'switch', 'case', 'yield', 'void', 'delete', 'typeof', 'instanceof',
]);

function extractSearchTerms(api: string): string[] {
  const raw = api
    .replace(/[()]/g, '')
    .split(/\s*[/,]\s*/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !t.includes(' '));

  const terms = new Set<string>();
  for (const t of raw) {
    if (!GENERIC_TERMS.has(t.toLowerCase())) terms.add(t);
    const parts = t.split('.');
    if (parts.length > 1) {
      for (const p of parts) {
        if (p.length >= 3 && !GENERIC_TERMS.has(p.toLowerCase())) terms.add(p);
      }
    }
  }
  return [...terms];
}

function isSourceFile(filePath: string): boolean {
  return /\.(ts|tsx|js|jsx|mts|mjs|cts|cjs)$/.test(filePath);
}

function importsPackage(content: string, packageName: string): boolean {
  return content.includes(`'${packageName}'`) || content.includes(`"${packageName}"`);
}

function isTrivialLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return true;
  if (/^import\s.*from\s+['"]/.test(trimmed)) return true;
  if (/^(export\s+)?(type|interface)\s/.test(trimmed)) return true;
  return false;
}

async function searchCode(
  octokit: Awaited<ReturnType<typeof getInstallationOctokit>>,
  query: string,
  filesToScan: Set<string>,
): Promise<void> {
  try {
    await rateLimitedSearch();
    const { data } = await octokit.rest.search.code({ q: query, per_page: 30 });
    for (const item of data.items) {
      if (isSourceFile(item.path)) filesToScan.add(item.path);
    }
  } catch {}
}

export async function scanForUsage(
  owner: string,
  repo: string,
  breakingChanges: BreakingChanges,
  packageName?: string,
  ref?: string,
  knownFiles?: string[],
): Promise<UsageHit[]> {
  if (!breakingChanges.hasBreakingChanges) return [];

  const octokit = await getInstallationOctokit();
  const hits: UsageHit[] = [];
  const seenFiles = new Set<string>();

  const filesToScan = new Set<string>(knownFiles ?? []);
  const repoScope = `repo:${owner}/${repo}`;

  if (packageName) {
    await searchCode(octokit, `"${packageName}" ${repoScope}`, filesToScan);
  }

  const allTerms = new Set<string>();
  for (const change of breakingChanges.changes) {
    for (const term of extractSearchTerms(change.api)) {
      allTerms.add(term);
    }
  }

  const termChunks: string[][] = [];
  const termsArray = [...allTerms];
  for (let i = 0; i < termsArray.length; i += 4) {
    termChunks.push(termsArray.slice(i, i + 4));
  }

  for (const chunk of termChunks) {
    const orQuery = chunk.map((t) => `"${t}"`).join(' OR ');
    await searchCode(octokit, `${orQuery} ${repoScope}`, filesToScan);
  }

  // Only keep files that actually import/require this package
  if (packageName) {
    const verified = new Set<string>();
    for (const filePath of filesToScan) {
      const content = await getCachedFileContent(owner, repo, filePath, ref);
      if (importsPackage(content, packageName)) verified.add(filePath);
    }
    filesToScan.clear();
    for (const f of verified) filesToScan.add(f);
  }

  for (const change of breakingChanges.changes) {
    const terms = extractSearchTerms(change.api);
    for (const term of terms) {
      for (const filePath of filesToScan) {
        const cacheKey = `${filePath}:${term}`;
        if (seenFiles.has(cacheKey)) continue;
        seenFiles.add(cacheKey);

        const content = await getCachedFileContent(owner, repo, filePath, ref);
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(term) && !isTrivialLine(lines[i])) {
            const start = Math.max(0, i - 4);
            const end = Math.min(lines.length, i + 5);
            const contextLines = lines.slice(start, end).map((l, idx) => {
              const lineNum = start + idx + 1;
              const marker = lineNum === i + 1 ? '→' : ' ';
              return `${marker} ${lineNum} | ${l}`;
            });
            hits.push({
              api: term,
              file: filePath,
              line: i + 1,
              snippet: lines[i].trim(),
              context: contextLines.join('\n'),
            });
          }
        }
      }
    }
  }

  return hits;
}
