import semver from 'semver';
import { Octokit } from 'octokit';

interface GitHubRelease {
  tagName: string;
  name: string;
  body: string;
}

const CHANGELOG_NAMES = ['CHANGELOG.md', 'HISTORY.md', 'CHANGES.md'];

// Public repo reads use a personal token (5000 req/hr) or unauthenticated (60 req/hr).
// Installation tokens can't read repos the app isn't installed on.
const publicOctokit = new Octokit({
  auth: process.env.GITHUB_TOKEN || undefined,
});

export async function fetchReleaseNotes(
  owner: string,
  repo: string,
  fromVersion: string,
  toVersion: string,
): Promise<string> {
  const releases = await fetchReleasesInRange(owner, repo, fromVersion);

  const relevant = releases.filter((r) => {
    const v = semver.coerce(r.tagName);
    const to = semver.coerce(toVersion);
    if (!v || !to) return false;
    return semver.lte(v, to);
  });

  if (relevant.length > 0) {
    relevant.sort((a, b) => {
      const va = semver.coerce(a.tagName)!;
      const vb = semver.coerce(b.tagName)!;
      return semver.compare(va, vb);
    });

    const important = relevant.filter((r) => {
      const v = semver.coerce(r.tagName);
      if (!v) return false;
      if (v.patch === 0) return true;
      if (/breaking|deprecat|removed|renamed/i.test(r.body)) return true;
      return false;
    });
    const selected = important.length > 0 ? important : relevant.slice(-10);

    const fromMajor = semver.coerce(fromVersion)?.major;
    const toMajor = semver.coerce(toVersion)?.major;
    const isMajorJump = fromMajor !== undefined && toMajor !== undefined && toMajor > fromMajor;

    const majorReleases = isMajorJump
      ? selected.filter((r) => {
          const v = semver.coerce(r.tagName);
          return v && v.minor === 0 && v.patch === 0;
        })
      : [];

    let breakingSummary = '';
    for (const r of majorReleases) {
      const sections = extractBreakingSections(r.body);
      if (sections) {
        breakingSummary += `## BREAKING CHANGES IN ${r.tagName}\n\n${sections}\n\n---\n\n`;
      }
    }

    let notes = breakingSummary + selected
      .map((r) => `## ${r.tagName}\n\n${r.body}`)
      .join('\n\n---\n\n');
    const hasMajorRelease = selected.some((r) => {
      const v = semver.coerce(r.tagName);
      return v && v.major > fromMajor! && v.minor === 0 && v.patch === 0;
    });
    const mentionsBreaking = /breaking|deprecat|removed|renamed/i.test(notes);

    if (isMajorJump && (!hasMajorRelease || !mentionsBreaking)) {
      const changelog = await fetchChangelogFile(owner, repo);
      if (changelog) {
        notes += '\n\n---\n\n## CHANGELOG.md (supplemental)\n\n' + changelog;
      }
    }

    return notes.slice(0, 30_000);
  }

  const changelog = await fetchChangelogFile(owner, repo);
  if (changelog) return changelog;

  return `No release notes found for ${owner}/${repo} between ${fromVersion} and ${toVersion}`;
}

function extractBreakingSections(body: string): string | null {
  const lines = body.split('\n');
  const sections: string[] = [];
  let capturing = false;

  for (const line of lines) {
    const isHeading = /^##\s/.test(line);
    if (isHeading) {
      if (/breaking|deprecat|removed|migration|api\s*change/i.test(line)) {
        capturing = true;
        sections.push(line);
      } else {
        capturing = false;
      }
    } else if (capturing) {
      sections.push(line);
    }
  }

  return sections.length > 0 ? sections.join('\n').trim() : null;
}

async function fetchChangelogFile(owner: string, repo: string): Promise<string | null> {
  for (const name of CHANGELOG_NAMES) {
    try {
      const { data } = await publicOctokit.rest.repos.getContent({ owner, repo, path: name });
      if (!('content' in data)) continue;
      const text = Buffer.from(data.content, 'base64').toString('utf-8');
      return text.slice(0, 30_000);
    } catch {
      continue;
    }
  }
  return null;
}

async function fetchReleasesInRange(
  owner: string,
  repo: string,
  fromVersion: string,
): Promise<GitHubRelease[]> {
  const from = semver.coerce(fromVersion);
  const releases: GitHubRelease[] = [];
  let page = 1;

  try {
    while (true) {
      const { data } = await publicOctokit.rest.repos.listReleases({
        owner, repo, per_page: 100, page,
      });
      if (data.length === 0) break;

      let pastRange = false;
      for (const r of data) {
        const v = semver.coerce(r.tag_name);
        if (v && from && semver.lte(v, from)) {
          pastRange = true;
          break;
        }
        releases.push({
          tagName: r.tag_name,
          name: r.name ?? r.tag_name,
          body: r.body ?? '',
        });
      }

      if (pastRange || data.length < 100) break;
      page++;
    }
  } catch (err: any) {
    console.log(`  Failed to fetch releases for ${owner}/${repo}: ${err.status ?? err.message}`);
  }

  return releases;
}
