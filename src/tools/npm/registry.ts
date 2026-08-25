interface NpmPackageInfo {
  repoOwner: string;
  repoName: string;
}

export async function resolveGitHubRepo(packageName: string): Promise<NpmPackageInfo | null> {
  const res = await fetch(`https://registry.npmjs.org/${packageName}`);
  if (!res.ok) return null;

  const data = await res.json() as { repository?: { url?: string } };
  const url = data.repository?.url;
  if (!url) return null;

  const match = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!match) return null;

  return { repoOwner: match[1], repoName: match[2] };
}
