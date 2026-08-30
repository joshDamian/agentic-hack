import { getInstallationOctokit } from './client.js';

export type CIStatus = 'pending' | 'success' | 'failure' | 'no-checks';

export async function getPRCIStatus(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<{ status: CIStatus; details: string; headSha: string }> {
  const octokit = await getInstallationOctokit();

  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  const headSha = pr.head.sha;

  const { data: checkRuns } = await octokit.rest.checks.listForRef({
    owner, repo, ref: headSha,
  });

  if (checkRuns.total_count === 0) {
    const { data: statuses } = await octokit.rest.repos.getCombinedStatusForRef({
      owner, repo, ref: headSha,
    });
    if (statuses.total_count === 0) return { status: 'no-checks', details: 'No CI checks configured', headSha };
    return {
      status: statuses.state === 'success' ? 'success' : statuses.state === 'pending' ? 'pending' : 'failure',
      details: statuses.statuses.map((s) => `${s.context}: ${s.state}`).join(', '),
      headSha,
    };
  }

  const failed = checkRuns.check_runs.filter((r) => r.conclusion === 'failure');
  const pending = checkRuns.check_runs.filter((r) => r.status !== 'completed');

  if (pending.length > 0) {
    return { status: 'pending', details: `${pending.length} checks still running`, headSha };
  }

  if (failed.length > 0) {
    return {
      status: 'failure',
      details: failed.map((r) => `${r.name}: ${r.conclusion}`).join(', '),
      headSha,
    };
  }

  return { status: 'success', details: 'All checks passed', headSha };
}

export async function getCIFailureLogs(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<string> {
  const octokit = await getInstallationOctokit();
  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  const headSha = pr.head.sha;

  const { data: checkRuns } = await octokit.rest.checks.listForRef({ owner, repo, ref: headSha });
  const failed = checkRuns.check_runs.filter((r) => r.conclusion === 'failure');
  if (failed.length === 0) return '';

  const lines: string[] = [];

  for (const run of failed) {
    lines.push(`=== ${run.name} ===`);

    // Try annotations first (structured errors)
    try {
      const { data: annotations } = await octokit.rest.checks.listAnnotations({
        owner, repo, check_run_id: run.id,
      });
      if (annotations.length > 0) {
        for (const a of annotations.slice(0, 20)) {
          lines.push(`${a.path}:${a.start_line} [${a.annotation_level}] ${a.message}`);
        }
        continue;
      }
    } catch {}

    // Fall back to output summary
    if (run.output?.summary) {
      lines.push(run.output.summary.slice(0, 2000));
    } else if (run.output?.text) {
      lines.push(run.output.text.slice(0, 2000));
    }
  }

  return lines.join('\n');
}

export async function commentOnPR(
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
): Promise<void> {
  const octokit = await getInstallationOctokit();
  await octokit.rest.issues.createComment({
    owner, repo, issue_number: prNumber, body,
  });
}
