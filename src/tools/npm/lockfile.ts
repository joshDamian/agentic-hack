import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

export async function regenerateLockfile(
  packageJson: string,
  packageLock: string,
): Promise<string | null> {
  const dir = mkdtempSync(join(tmpdir(), 'depbot-lock-'));
  try {
    writeFileSync(join(dir, 'package.json'), packageJson);
    writeFileSync(join(dir, 'package-lock.json'), packageLock);
    execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts'], {
      cwd: dir,
      timeout: 60_000,
      stdio: 'pipe',
    });
    const updated = readFileSync(join(dir, 'package-lock.json'), 'utf-8');
    if (updated === packageLock) return null;
    return updated;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
