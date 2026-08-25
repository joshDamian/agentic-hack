import { getInstallationOctokit } from './client.js';
import type { PlannedBump } from '../../shared/types.js';

export async function getDefaultBranch(owner: string, repo: string): Promise<string> {
  const octokit = await getInstallationOctokit();
  const { data } = await octokit.rest.repos.get({ owner, repo });
  return data.default_branch;
}

export async function getHeadSha(owner: string, repo: string, branch: string): Promise<string> {
  const octokit = await getInstallationOctokit();
  const { data } = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
  return data.object.sha;
}

export async function createBranchAndPR(
  owner: string,
  repo: string,
  bump: PlannedBump,
): Promise<{ prNumber: number; prUrl: string; branchName: string }> {
  const octokit = await getInstallationOctokit();
  const defaultBranch = await getDefaultBranch(owner, repo);
  const headSha = await getHeadSha(owner, repo, defaultBranch);

  const branchName = `depbot-triage/${bump.packageName}-${bump.targetVersion}`;

  const { data: pkgFile } = await octokit.rest.repos.getContent({
    owner, repo, path: 'package.json', ref: defaultBranch,
  });
  if (!('content' in pkgFile)) throw new Error('package.json is not a file');

  const pkgJson = JSON.parse(Buffer.from(pkgFile.content, 'base64').toString('utf-8'));
  const depKey = findDepKey(pkgJson, bump.packageName);
  if (!depKey) throw new Error(`${bump.packageName} not found in package.json`);

  pkgJson[depKey][bump.packageName] = `^${bump.targetVersion}`;
  const updatedContent = JSON.stringify(pkgJson, null, 2) + '\n';

  const { data: blob } = await octokit.rest.git.createBlob({
    owner, repo,
    content: Buffer.from(updatedContent).toString('base64'),
    encoding: 'base64',
  });

  const { data: baseTree } = await octokit.rest.git.getCommit({
    owner, repo, commit_sha: headSha,
  });

  const { data: tree } = await octokit.rest.git.createTree({
    owner, repo,
    base_tree: baseTree.tree.sha,
    tree: [{
      path: 'package.json',
      mode: '100644',
      type: 'blob',
      sha: blob.sha,
    }],
  });

  const { data: commit } = await octokit.rest.git.createCommit({
    owner, repo,
    message: `bump ${bump.packageName} from ${bump.currentVersion} to ${bump.targetVersion}`,
    tree: tree.sha,
    parents: [headSha],
  });

  await octokit.rest.git.createRef({
    owner, repo,
    ref: `refs/heads/${branchName}`,
    sha: commit.sha,
  });

  const prBody = formatPRBody(bump);
  const { data: pr } = await octokit.rest.pulls.create({
    owner, repo,
    title: `bump ${bump.packageName} to ${bump.targetVersion}`,
    head: branchName,
    base: defaultBranch,
    body: prBody,
  });

  return { prNumber: pr.number, prUrl: pr.html_url, branchName };
}

function findDepKey(
  pkgJson: Record<string, Record<string, string>>,
  packageName: string,
): string | null {
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
    if (pkgJson[key]?.[packageName]) return key;
  }
  return null;
}

function formatPRBody(bump: PlannedBump): string {
  const verdictEmoji = bump.verdict === 'safe' ? '✅' : bump.verdict === 'risky' ? '⚠️' : '❓';

  return `## Dependency bump

| | |
|---|---|
| **Package** | \`${bump.packageName}\` |
| **From** | \`${bump.currentVersion}\` |
| **To** | \`${bump.targetVersion}\` |
| **Alerts closed** | ${bump.alertsClosed} |
| **Verdict** | ${verdictEmoji} ${bump.verdict ?? 'pending'} |

### Verdict reason

${bump.verdictReason ?? 'Analysis pending'}

### Alerts closed

${bump.alertNumbers.map((n) => `- #${n}`).join('\n')}

---
*Opened by [depbot-triage](https://github.com/joshDamian/agentic-hack) — an autonomous Dependabot backlog agent.*`;
}
