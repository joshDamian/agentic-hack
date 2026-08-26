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

async function getCachedFileContent(owner: string, repo: string, path: string): Promise<string> {
  const key = `${owner}/${repo}/${path}`;
  const cached = fileCache.get(key);
  if (cached !== undefined) return cached;
  const content = await getFileContent(owner, repo, path);
  fileCache.set(key, content);
  return content;
}

function extractSearchTerms(api: string): string[] {
  const raw = api
    .replace(/[()]/g, '')
    .split(/\s*[/,]\s*/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !t.includes(' '));

  const terms = new Set<string>();
  for (const t of raw) {
    terms.add(t);
    const parts = t.split('.');
    if (parts.length > 1) {
      for (const p of parts) {
        if (p.length >= 3) terms.add(p);
      }
    }
  }
  return [...terms];
}

export async function scanForUsage(
  owner: string,
  repo: string,
  breakingChanges: BreakingChanges,
  packageName?: string,
): Promise<UsageHit[]> {
  if (!breakingChanges.hasBreakingChanges) return [];

  const octokit = await getInstallationOctokit();
  const hits: UsageHit[] = [];
  const seenFiles = new Set<string>();

  const filesToScan = new Set<string>();

  if (packageName) {
    try {
      await rateLimitedSearch();
      const { data } = await octokit.rest.search.code({
        q: `${packageName} repo:${owner}/${repo}`,
        per_page: 10,
      });
      for (const item of data.items) {
        if (item.path !== 'package.json' && item.path !== 'package-lock.json') {
          filesToScan.add(item.path);
        }
      }
    } catch {}
  }

  if (filesToScan.size === 0) {
    for (const change of breakingChanges.changes) {
      for (const term of extractSearchTerms(change.api)) {
        try {
          await rateLimitedSearch();
          const { data } = await octokit.rest.search.code({
            q: `${term} repo:${owner}/${repo}`,
            per_page: 10,
          });
          for (const item of data.items) {
            if (item.path !== 'package.json' && item.path !== 'package-lock.json') {
              filesToScan.add(item.path);
            }
          }
        } catch {}
      }
    }
  }

  for (const change of breakingChanges.changes) {
    const terms = extractSearchTerms(change.api);
    for (const term of terms) {
      for (const filePath of filesToScan) {
        const cacheKey = `${filePath}:${term}`;
        if (seenFiles.has(cacheKey)) continue;
        seenFiles.add(cacheKey);

        const content = await getCachedFileContent(owner, repo, filePath);
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(term)) {
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
