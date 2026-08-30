import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { getInstallationOctokit } from './client.js';

const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

function cacheKey(owner: string, repo: string, ref: string): string {
  return `${owner}/${repo}/${ref}`;
}

export async function getRepoSnapshot(
  owner: string,
  repo: string,
  ref = 'HEAD',
): Promise<string> {
  const key = cacheKey(owner, repo, ref);
  const cached = cache.get(key);
  if (cached && fs.existsSync(cached)) return cached;

  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = downloadAndExtract(owner, repo, ref, key);
  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}

async function downloadAndExtract(
  owner: string,
  repo: string,
  ref: string,
  key: string,
): Promise<string> {
  const octokit = await getInstallationOctokit();
  const { data } = await octokit.rest.repos.downloadZipballArchive({
    owner,
    repo,
    ref,
  }) as { data: ArrayBuffer };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'depbot-zip-'));
  const zipPath = path.join(tmpDir, 'repo.zip');
  fs.writeFileSync(zipPath, Buffer.from(data));

  execFileSync('unzip', ['-q', '-o', zipPath, '-d', tmpDir], { timeout: 30_000 });
  fs.unlinkSync(zipPath);

  const entries = fs.readdirSync(tmpDir);
  const root = entries.length === 1
    ? path.join(tmpDir, entries[0])
    : tmpDir;

  cache.set(key, root);
  return root;
}

export function bustSnapshot(owner: string, repo: string, ref: string): void {
  const key = cacheKey(owner, repo, ref);
  const dir = cache.get(key);
  if (dir) {
    cache.delete(key);
    const parent = path.dirname(dir);
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

export function clearSnapshots(): void {
  for (const [, dir] of cache) {
    const parent = path.dirname(dir);
    fs.rmSync(parent, { recursive: true, force: true });
  }
  cache.clear();
}
