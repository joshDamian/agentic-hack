import { getInstallationOctokit } from './client.js';

export type CIStatus = 'pending' | 'success' | 'failure' | 'no-checks';

export async function getPRCIStatus(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<{ status: CIStatus; details: string }> {
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
    if (statuses.total_count === 0) return { status: 'no-checks', details: 'No CI checks configured' };
    return {
      status: statuses.state === 'success' ? 'success' : statuses.state === 'pending' ? 'pending' : 'failure',
      details: statuses.statuses.map((s) => `${s.context}: ${s.state}`).join(', '),
    };
  }

  const failed = checkRuns.check_runs.filter((r) => r.conclusion === 'failure');
  const pending = checkRuns.check_runs.filter((r) => r.status !== 'completed');

  if (pending.length > 0) {
    return { status: 'pending', details: `${pending.length} checks still running` };
  }

  if (failed.length > 0) {
    return {
      status: 'failure',
      details: failed.map((r) => `${r.name}: ${r.conclusion}`).join(', '),
    };
  }

  return { status: 'success', details: 'All checks passed' };
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
