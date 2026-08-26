import { execFileSync } from 'node:child_process';

export interface TypeDiffResult {
  diff: string;
  hasDtsChanges: boolean;
}

export function getTypeDiff(
  packageName: string,
  oldVersion: string,
  newVersion: string,
): TypeDiffResult {
  try {
    const diff = execFileSync(
      'npm',
      ['diff', `--diff=${packageName}@${oldVersion}`, `--diff=${packageName}@${newVersion}`, '--', '*.d.ts'],
      { encoding: 'utf-8', timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    return { diff: diff.trim(), hasDtsChanges: diff.trim().length > 0 };
  } catch (err: any) {
    if (err.stdout && typeof err.stdout === 'string') {
      const out = err.stdout.trim();
      return { diff: out, hasDtsChanges: out.length > 0 };
    }
    console.log(`  typediff failed for ${packageName}: ${err.message}`);
    return { diff: '', hasDtsChanges: false };
  }
}

export function getTypesDiff(
  packageName: string,
  oldVersion: string,
  newVersion: string,
): TypeDiffResult {
  const typesPackage = `@types/${packageName.replace('@', '').replace('/', '__')}`;
  try {
    const diff = execFileSync(
      'npm',
      ['diff', `--diff=${typesPackage}@${oldVersion}`, `--diff=${typesPackage}@${newVersion}`, '--', '*.d.ts'],
      { encoding: 'utf-8', timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    return { diff: diff.trim(), hasDtsChanges: diff.trim().length > 0 };
  } catch {
    return { diff: '', hasDtsChanges: false };
  }
}

function truncateDiff(diff: string, maxChars: number = 15_000): string {
  if (diff.length <= maxChars) return diff;
  return diff.slice(0, maxChars) + '\n\n... (truncated, diff too large)';
}

export function getPackageTypeDiff(
  packageName: string,
  oldVersion: string,
  newVersion: string,
): TypeDiffResult {
  const bundled = getTypeDiff(packageName, oldVersion, newVersion);
  if (bundled.hasDtsChanges) {
    return { diff: truncateDiff(bundled.diff), hasDtsChanges: true };
  }

  const dt = getTypesDiff(packageName, oldVersion, newVersion);
  if (dt.hasDtsChanges) {
    return { diff: truncateDiff(dt.diff), hasDtsChanges: true };
  }

  return { diff: '', hasDtsChanges: false };
}
