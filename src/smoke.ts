import 'dotenv/config';
import { listAlerts, getFileContent } from './tools/github/client.js';
import { planBumps } from './agents/prioritiser/plan.js';
import { createCampaign, getCampaign, updateCampaign } from './tools/firestore/client.js';
import { createBranchAndPR } from './tools/github/pr.js';
import { getPRCIStatus } from './tools/github/ci.js';
import { config } from './shared/config.js';
import type { Campaign } from './shared/types.js';

async function main() {
  const { owner, name: repo } = config.targetRepo;

  console.log('Fetching alerts and planning bumps...');
  const alerts = await listAlerts(owner, repo);
  const lockRaw = await getFileContent(owner, repo, 'package-lock.json');
  const packageLock = JSON.parse(lockRaw) as { packages: Record<string, { version: string }> };
  const bumps = planBumps(alerts, packageLock);

  // Pick a small, safe bump to test
  const testBump = bumps.find((b) => b.packageName === 'semver')!;
  testBump.verdict = 'safe';
  testBump.verdictReason = 'Patch version bump, no breaking changes';

  console.log(`\nTest bump: ${testBump.packageName} ${testBump.currentVersion} → ${testBump.targetVersion}`);
  console.log('Creating branch and PR...');

  const result = await createBranchAndPR(owner, repo, testBump);
  console.log(`PR opened: ${result.prUrl}`);

  console.log('Checking CI status...');
  const ci = await getPRCIStatus(owner, repo, result.prNumber);
  console.log(`CI: ${ci.status} — ${ci.details}`);
}
main();
