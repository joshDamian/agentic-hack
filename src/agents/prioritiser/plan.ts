import semver from 'semver';
import type { DependabotAlert, PlannedBump } from '../../shared/types.js';

interface PackageLock {
  packages: Record<string, { version: string }>;
}

export function planBumps(
  alerts: DependabotAlert[],
  packageLock: PackageLock,
  packageJson?: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> },
): PlannedBump[] {
  const directDeps = packageJson
    ? new Set([
        ...Object.keys(packageJson.dependencies ?? {}),
        ...Object.keys(packageJson.devDependencies ?? {}),
      ])
    : null;

  const groups = new Map<string, DependabotAlert[]>();
  for (const a of alerts) {
    const name = a.dependency.package.name;
    if (directDeps && !directDeps.has(name)) continue;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name)!.push(a);
  }

  const bumps: PlannedBump[] = [];

  for (const [packageName, group] of groups) {
    const targetVersion = highestPatchedVersion(group);
    if (!targetVersion) continue;

    const lockEntry = packageLock.packages[`node_modules/${packageName}`];
    const currentVersion = lockEntry?.version ?? 'unknown';

    bumps.push({
      packageName,
      ecosystem: group[0].dependency.package.ecosystem,
      currentVersion,
      targetVersion,
      alertsClosed: group.length,
      alertNumbers: group.map((a) => a.number),
    });
  }

  bumps.sort((a, b) => b.alertsClosed - a.alertsClosed);
  return bumps;
}

function highestPatchedVersion(alerts: DependabotAlert[]): string | null {
  let highest: string | null = null;
  for (const a of alerts) {
    const v = a.securityVulnerability.firstPatchedVersion;
    if (!v) continue;
    if (!highest || semver.gt(semver.coerce(v)!, semver.coerce(highest)!)) {
      highest = v;
    }
  }
  return highest;
}
