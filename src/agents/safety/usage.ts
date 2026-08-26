import { getFileContent, getInstallationOctokit } from '../../tools/github/client.js';
import type { BreakingChanges } from './changelog.js';

export interface UsageHit {
  api: string;
  file: string;
  line: number;
  snippet: string;
  context: string;
}

function extractSearchTerms(api: string): string[] {
  // "jwt.sign / jwt.verify" → ["jwt.sign", "jwt.verify"]
  // "AxiosError" → ["AxiosError"]
  return api
    .split(/\s*[/,]\s*/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !t.includes(' '));
}

export async function scanForUsage(
  owner: string,
  repo: string,
  breakingChanges: BreakingChanges,
): Promise<UsageHit[]> {
  if (!breakingChanges.hasBreakingChanges) return [];

  const octokit = await getInstallationOctokit();
  const hits: UsageHit[] = [];
  const seenFiles = new Set<string>();

  for (const change of breakingChanges.changes) {
    const terms = extractSearchTerms(change.api);

    for (const term of terms) {
      try {
        // GitHub code search: 10 requests/min for authenticated users
        await new Promise((r) => setTimeout(r, 6500));
        const { data } = await octokit.rest.search.code({
          q: `${term} repo:${owner}/${repo}`,
          per_page: 10,
        });

        for (const item of data.items) {
          if (item.path === 'package.json' || item.path === 'package-lock.json') continue;

          const cacheKey = `${item.path}:${term}`;
          if (seenFiles.has(cacheKey)) continue;
          seenFiles.add(cacheKey);

          const content = await getFileContent(owner, repo, item.path);
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
                file: item.path,
                line: i + 1,
                snippet: lines[i].trim(),
                context: contextLines.join('\n'),
              });
            }
          }
        }
      } catch {
        // Search API can 422 on short/symbolic terms — skip
      }
    }
  }

  return hits;
}
