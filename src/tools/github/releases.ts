import semver from 'semver';

interface GitHubRelease {
  tagName: string;
  name: string;
  body: string;
}

const CHANGELOG_NAMES = ['CHANGELOG.md', 'HISTORY.md', 'CHANGES.md'];

export async function fetchReleaseNotes(
  owner: string,
  repo: string,
  fromVersion: string,
  toVersion: string,
): Promise<string> {
  const releases = await fetchAllReleases(owner, repo);

  const relevant = releases.filter((r) => {
    const v = semver.coerce(r.tagName);
    if (!v) return false;
    const from = semver.coerce(fromVersion);
    const to = semver.coerce(toVersion);
    if (!from || !to) return false;
    return semver.gt(v, from) && semver.lte(v, to);
  });

  if (relevant.length > 0) {
    relevant.sort((a, b) => {
      const va = semver.coerce(a.tagName)!;
      const vb = semver.coerce(b.tagName)!;
      return semver.compare(va, vb);
    });

    return relevant
      .map((r) => `## ${r.tagName}\n\n${r.body}`)
      .join('\n\n---\n\n');
  }

  const changelog = await fetchChangelogFile(owner, repo);
  if (changelog) return changelog;

  return `No release notes found for ${owner}/${repo} between ${fromVersion} and ${toVersion}`;
}

async function fetchChangelogFile(owner: string, repo: string): Promise<string | null> {
  for (const name of CHANGELOG_NAMES) {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${name}`,
      { headers: { Accept: 'application/vnd.github.raw+json' } },
    );
    if (res.ok) {
      const text = await res.text();
      // Cap at 30k chars to avoid blowing Gemini's context with huge changelogs
      return text.slice(0, 30_000);
    }
  }
  return null;
}

async function fetchAllReleases(owner: string, repo: string): Promise<GitHubRelease[]> {
  const releases: GitHubRelease[] = [];
  let page = 1;

  while (true) {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/releases?per_page=100&page=${page}`,
      { headers: { Accept: 'application/vnd.github+json' } },
    );

    if (!res.ok) break;

    const data = await res.json() as Array<{ tag_name: string; name: string | null; body: string | null }>;
    if (data.length === 0) break;

    for (const r of data) {
      releases.push({
        tagName: r.tag_name,
        name: r.name ?? r.tag_name,
        body: r.body ?? '',
      });
    }

    if (data.length < 100) break;
    page++;
  }

  return releases;
}
