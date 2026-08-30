import { getInstallationOctokit, getFileContent } from './client.js';
import { commentOnPR } from './ci.js';
import type { PlannedBump } from '../../shared/types.js';
import { dedent } from '../../shared/text.js';

const TODO_PREFIX = '// TODO(depbot-triage):';

const EXT_LANG: Record<string, string> = {
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript',
  '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust',
  '.java': 'java', '.kt': 'kotlin', '.cs': 'csharp', '.php': 'php',
  '.swift': 'swift', '.sh': 'bash', '.yml': 'yaml', '.yaml': 'yaml',
  '.json': 'json', '.css': 'css', '.html': 'html', '.sql': 'sql',
};

function langFromPath(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) return '';
  return EXT_LANG[filePath.slice(dot)] ?? '';
}

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

  try {
    await octokit.rest.git.getRef({ owner, repo, ref: `heads/${branchName}` });
    const { data: prs } = await octokit.rest.pulls.list({
      owner, repo, head: `${owner}:${branchName}`, state: 'open',
    });
    if (prs.length > 0) {
      return { prNumber: prs[0].number, prUrl: prs[0].html_url, branchName };
    }
    await octokit.rest.git.deleteRef({ owner, repo, ref: `heads/${branchName}` });
  } catch (err: any) {
    if (err.status !== 404) throw err;
  }

  const { data: pkgFile } = await octokit.rest.repos.getContent({
    owner, repo, path: 'package.json', ref: defaultBranch,
  });
  if (!('content' in pkgFile)) throw new Error('package.json is not a file');

  const pkgJson = JSON.parse(Buffer.from(pkgFile.content, 'base64').toString('utf-8'));
  const depKey = findDepKey(pkgJson, bump.packageName);
  if (!depKey) throw new Error(`${bump.packageName} not found in package.json`);

  pkgJson[depKey][bump.packageName] = `^${bump.targetVersion}`;
  const updatedContent = JSON.stringify(pkgJson, null, 2) + '\n';

  const treeEntries: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string }> = [];

  const { data: pkgBlob } = await octokit.rest.git.createBlob({
    owner, repo,
    content: Buffer.from(updatedContent).toString('base64'),
    encoding: 'base64',
  });
  treeEntries.push({ path: 'package.json', mode: '100644', type: 'blob', sha: pkgBlob.sha });

  const affected = bump.findings?.filter((f) => f.isAffected) ?? [];
  if (affected.length > 0) {
    const byFile = new Map<string, Map<number, { line: number; api: string; analysis: string }>>();
    for (const f of affected) {
      if (!byFile.has(f.file)) byFile.set(f.file, new Map());
      const fileMap = byFile.get(f.file)!;
      if (!fileMap.has(f.line)) {
        fileMap.set(f.line, { line: f.line, api: f.file, analysis: f.analysis });
      }
    }

    for (const [filePath, findingsMap] of byFile) {
      try {
        const content = await getFileContent(owner, repo, filePath);
        const lines = content.split('\n');

        const sorted = [...findingsMap.values()].sort((a, b) => b.line - a.line);
        for (const f of sorted) {
          const idx = f.line - 1;
          if (idx >= 0 && idx < lines.length) {
            const indent = lines[idx].match(/^(\s*)/)?.[1] ?? '';
            const todoComment = `${indent}${TODO_PREFIX} ${bump.packageName} ${bump.currentVersion} → ${bump.targetVersion} — review usage below`;
            lines.splice(idx, 0, todoComment);
          }
        }

        const modified = lines.join('\n');
        const { data: fileBlob } = await octokit.rest.git.createBlob({
          owner, repo,
          content: Buffer.from(modified).toString('base64'),
          encoding: 'base64',
        });
        treeEntries.push({ path: filePath, mode: '100644', type: 'blob', sha: fileBlob.sha });
      } catch {
        // If we can't read/modify the file, skip the TODO — the PR still works
      }
    }
  }

  const { data: baseTree } = await octokit.rest.git.getCommit({
    owner, repo, commit_sha: headSha,
  });

  const { data: tree } = await octokit.rest.git.createTree({
    owner, repo,
    base_tree: baseTree.tree.sha,
    tree: treeEntries,
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

  const prBody = formatPRBody(bump, owner, repo);
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

function formatPRBody(bump: PlannedBump, owner: string, repo: string): string {
  const verdictEmoji = bump.verdict === 'safe' ? '✅' : bump.verdict === 'risky' ? '⚠️' : '❓';

  let body = `## Dependency bump

| | |
|---|---|
| **Package** | \`${bump.packageName}\` |
| **From** | \`${bump.currentVersion}\` |
| **To** | \`${bump.targetVersion}\` |
| **Alerts closed** | ${bump.alertsClosed} |
| **Verdict** | ${verdictEmoji} ${bump.verdict ?? 'pending'} |

### Verdict reason

${bump.verdictReason ?? 'Analysis pending'}
`;

  if (bump.breakingChanges?.length) {
    body += '\n### Breaking changes\n\n';
    for (const bc of bump.breakingChanges) {
      body += `- **${bc.kind}**: \`${bc.api}\` — ${bc.description}\n`;
      if (bc.migrationHint) body += `  - Migration: ${bc.migrationHint}\n`;
    }
  }

  const alertLinks = bump.alertNumbers
    .map((n) => `- [Alert #${n}](https://github.com/${owner}/${repo}/security/dependabot/${n})`)
    .join('\n');
  body += `\n### Alerts closed\n\n${alertLinks}`;
  body += '\n\n---\n*Opened by [depbot-triage](https://github.com/joshDamian/agentic-hack) — an autonomous Dependabot backlog agent.*';
  return body;
}

export interface AnalysisOutput {
  reviewBody: string | null;
  inlineComments: Array<{ path: string; line: number; body: string }>;
}

export function buildAnalysisOutput(
  bump: PlannedBump,
  owner: string,
  repo: string,
): AnalysisOutput {
  const findings = bump.findings;
  if (!findings?.length) return { reviewBody: null, inlineComments: [] };

  const affected = findings.filter((f) => f.isAffected);
  const falsePositives = findings.filter((f) => !f.isAffected);
  const verdictEmoji = bump.verdict === 'safe' ? '✅' : bump.verdict === 'risky' ? '⚠️' : '❓';

  let body = `## ${verdictEmoji} Safety Analysis — \`${bump.packageName}\` ${bump.currentVersion} → ${bump.targetVersion}\n\n`;

  if (affected.length > 0) {
    body += `Found ${affected.length} location${affected.length > 1 ? 's' : ''} in this codebase affected by the upgrade. See inline comments for details.\n\n`;
  }

  if (falsePositives.length > 0) {
    body += '<details><summary>Checked but not affected (' + falsePositives.length + ')</summary>\n\n';
    for (const f of falsePositives) {
      body += `- [\`${f.file}:${f.line}\`](https://github.com/${owner}/${repo}/blob/HEAD/${f.file}#L${f.line}) — ${f.analysis}\n`;
    }
    body += '\n</details>\n';
  }

  body += '\n---\n*Analysis by [depbot-triage](https://github.com/joshDamian/agentic-hack)*';

  const deduped = new Map<string, typeof affected[number]>();
  for (const f of affected) {
    const key = `${f.file}:${f.line}`;
    if (!deduped.has(key)) deduped.set(key, f);
  }

  const inlineComments = [...deduped.values()].map((f) => {
    const lang = langFromPath(f.file);
    let comment = `**⚠️ Breaking change in \`${bump.packageName}\` ${bump.currentVersion} → ${bump.targetVersion}**\n\n`;
    comment += `${f.analysis}\n`;
    if (f.suggestedFix) {
      comment += `\n**Suggested fix:**\n\`\`\`${lang}\n${dedent(f.suggestedFix)}\n\`\`\`\n`;
    }
    return { path: f.file, line: f.line, body: comment };
  });

  return { reviewBody: body, inlineComments };
}

async function pushTodoAnnotations(
  owner: string,
  repo: string,
  branch: string,
  bump: PlannedBump,
  missingFiles: string[],
): Promise<void> {
  const octokit = await getInstallationOctokit();
  const { data: refData } = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
  const headSha = refData.object.sha;
  const { data: headCommit } = await octokit.rest.git.getCommit({ owner, repo, commit_sha: headSha });

  const affected = bump.findings?.filter((f) => f.isAffected && missingFiles.includes(f.file)) ?? [];
  const byFile = new Map<string, Array<{ line: number; analysis: string }>>();
  for (const f of affected) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file)!.push({ line: f.line, analysis: f.analysis });
  }

  const treeEntries: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string }> = [];
  for (const [filePath, findings] of byFile) {
    try {
      const content = await getFileContent(owner, repo, filePath, branch);
      const lines = content.split('\n');
      const sorted = findings.sort((a, b) => b.line - a.line);
      for (const f of sorted) {
        const idx = f.line - 1;
        if (idx >= 0 && idx < lines.length) {
          const indent = lines[idx].match(/^(\s*)/)?.[1] ?? '';
          const todo = `${indent}${TODO_PREFIX} ${bump.packageName} ${bump.currentVersion} → ${bump.targetVersion} — review usage below`;
          lines.splice(idx, 0, todo);
        }
      }
      const { data: blob } = await octokit.rest.git.createBlob({
        owner, repo, content: Buffer.from(lines.join('\n')).toString('base64'), encoding: 'base64',
      });
      treeEntries.push({ path: filePath, mode: '100644', type: 'blob', sha: blob.sha });
    } catch {}
  }

  if (treeEntries.length === 0) return;

  const { data: tree } = await octokit.rest.git.createTree({
    owner, repo, base_tree: headCommit.tree.sha, tree: treeEntries,
  });
  const { data: commit } = await octokit.rest.git.createCommit({
    owner, repo, message: `annotate affected files for ${bump.packageName} upgrade`, tree: tree.sha, parents: [headSha],
  });
  await octokit.rest.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: commit.sha });
}

function mapInlineComments(
  inlineComments: Array<{ path: string; line: number; body: string }>,
  files: Array<{ filename: string; patch?: string }>,
): Array<{ path: string; position: number; body: string }> {
  const comments: Array<{ path: string; position: number; body: string }> = [];
  for (const c of inlineComments) {
    const diffFile = files.find((f) => f.filename === c.path);
    if (!diffFile?.patch) continue;

    let position = 0;
    let newLine = 0;
    let found = false;
    for (const line of diffFile.patch.split('\n')) {
      const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
      if (hunk) {
        newLine = parseInt(hunk[1], 10) - 1;
        position++;
        continue;
      }
      if (line.startsWith('-')) {
        position++;
        continue;
      }
      newLine++;
      position++;
      if (newLine === c.line) {
        comments.push({ path: c.path, position, body: c.body });
        found = true;
        break;
      }
    }
    if (!found && diffFile.patch) {
      comments.push({ path: c.path, position: 1, body: c.body });
    }
  }
  return comments;
}

export async function postAnalysisReview(
  owner: string,
  repo: string,
  prNumber: number,
  bump: PlannedBump,
  force?: boolean,
): Promise<void> {
  const { reviewBody, inlineComments } = buildAnalysisOutput(bump, owner, repo);
  if (!reviewBody) return;

  const octokit = await getInstallationOctokit();

  if (!force) {
    const [{ data: existingReviews }, { data: existingComments }] = await Promise.all([
      octokit.rest.pulls.listReviews({ owner, repo, pull_number: prNumber }),
      octokit.rest.issues.listComments({ owner, repo, issue_number: prNumber }),
    ]);
    const alreadyPosted = existingReviews.some((r) => r.body?.includes('Safety Analysis'))
      || existingComments.some((c) => c.body?.includes('Safety Analysis'));
    if (alreadyPosted) return;
  }

  if (inlineComments.length === 0) {
    await commentOnPR(owner, repo, prNumber, reviewBody);
    return;
  }

  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  let { data: files } = await octokit.rest.pulls.listFiles({ owner, repo, pull_number: prNumber });

  const missingFiles = [...new Set(inlineComments.map((c) => c.path))]
    .filter((path) => !files.some((f) => f.filename === path));

  if (missingFiles.length > 0) {
    await pushTodoAnnotations(owner, repo, pr.head.ref, bump, missingFiles);
    ({ data: files } = await octokit.rest.pulls.listFiles({ owner, repo, pull_number: prNumber }));
  }

  const comments = mapInlineComments(inlineComments, files);

  if (comments.length > 0) {
    const { data: freshPr } = missingFiles.length > 0
      ? await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber })
      : { data: pr };
    await octokit.rest.pulls.createReview({
      owner, repo, pull_number: prNumber,
      commit_id: freshPr.head.sha,
      event: 'COMMENT',
      body: reviewBody,
      comments,
    });
  } else {
    await commentOnPR(owner, repo, prNumber, reviewBody);
  }
}
