import 'dotenv/config';
import { classifyBump } from './agents/safety/index.js';
import { buildAnalysisOutput } from './tools/github/pr.js';
import type { PlannedBump } from './shared/types.js';

const bump: PlannedBump = {
  packageName: 'jsonwebtoken',
  ecosystem: 'npm',
  currentVersion: '8.5.1',
  targetVersion: '9.0.2',
  alertsClosed: 2,
  alertNumbers: [10, 11],
};

const owner = process.env.TARGET_REPO_OWNER!;
const repo = process.env.TARGET_REPO_NAME!;

console.log(`Classifying ${bump.packageName} ${bump.currentVersion} → ${bump.targetVersion}`);
console.log(`Repo: ${owner}/${repo}\n`);

const result = await classifyBump(owner, repo, bump);

console.log(`\nVerdict: ${result.verdict}`);
console.log(`Reason: ${result.reason}`);
console.log(`\nBreaking changes: ${result.breakingChanges?.length ?? 0}`);
for (const bc of result.breakingChanges ?? []) {
  console.log(`  - ${bc.kind}: ${bc.api} — ${bc.description}`);
}
console.log(`\nFindings: ${result.findings?.length ?? 0}`);
for (const f of result.findings ?? []) {
  console.log(`  ${f.isAffected ? '⚠️' : '✓'} ${f.file}:${f.line}`);
  console.log(`    ${f.analysis}`);
  if (f.suggestedFix) console.log(`    Fix: ${f.suggestedFix}`);
}

// Test the analysis comment builder
bump.verdict = result.verdict;
bump.verdictReason = result.reason;
bump.breakingChanges = result.breakingChanges;
bump.findings = result.findings;

const { reviewBody, inlineComments } = buildAnalysisOutput(bump, owner, repo);
if (reviewBody) {
  console.log('\n=== Review Body ===\n');
  console.log(reviewBody);
  if (inlineComments.length > 0) {
    console.log('\n=== Inline Comments ===\n');
    for (const c of inlineComments) console.log(c.body);
  }
} else {
  console.log('\n(No analysis output — no findings)');
}
