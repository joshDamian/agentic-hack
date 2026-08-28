import { App, Octokit } from 'octokit';
import type { Endpoints } from '@octokit/types';
import fs from 'node:fs';
import { config } from '../../shared/config.js';
import type { DependabotAlert } from '../../shared/types.js';

type GitHubAlert = Endpoints['GET /repos/{owner}/{repo}/dependabot/alerts']['response']['data'][number];

let app: App | null = null;

function getApp(): App {
  if (app) return app;

  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY
    ?? fs.readFileSync(config.githubAppKeyPath, 'utf-8');
  app = new App({
    appId: config.githubAppId,
    privateKey,
  });
  return app;
}

export async function getInstallationOctokit(): Promise<Octokit> {
  return getApp().getInstallationOctokit(Number(config.githubInstallationId));
}

function toAlert(a: GitHubAlert): DependabotAlert {
  return {
    number: a.number,
    state: a.state,
    dependency: {
      package: {
        ecosystem: a.dependency.package!.ecosystem,
        name: a.dependency.package!.name,
      },
      manifestPath: a.dependency.manifest_path ?? '',
      scope: a.dependency.scope ?? 'runtime',
    },
    securityAdvisory: {
      ghsaId: a.security_advisory.ghsa_id,
      severity: a.security_advisory.severity,
      summary: a.security_advisory.summary,
      description: a.security_advisory.description,
    },
    securityVulnerability: {
      vulnerableVersionRange: a.security_vulnerability.vulnerable_version_range,
      firstPatchedVersion: a.security_vulnerability.first_patched_version?.identifier ?? null,
    },
    createdAt: a.created_at,
    fixedAt: a.fixed_at ?? null,
    autoDismissedAt: a.auto_dismissed_at ?? null,
  };
}

export async function listInstallationRepos(): Promise<Array<{ owner: string; name: string }>> {
  const octokit = await getInstallationOctokit();
  const { data } = await octokit.rest.apps.listReposAccessibleToInstallation({ per_page: 100 });
  return data.repositories.map((r) => ({ owner: r.owner.login, name: r.name }));
}

export async function listAlerts(
  owner: string,
  repo: string,
): Promise<DependabotAlert[]> {
  const octokit = await getInstallationOctokit();
  const data = await octokit.paginate(octokit.rest.dependabot.listAlertsForRepo, {
    owner,
    repo,
    state: 'open',
    per_page: 100,
  });
  return data.map(toAlert);
}

export async function getFileContent(
  owner: string,
  repo: string,
  path: string,
  ref?: string,
): Promise<string> {
  const octokit = await getInstallationOctokit();
  const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ...(ref && { ref }) });
  if (!('content' in data)) throw new Error(`${path} is not a file`);
  return Buffer.from(data.content, 'base64').toString('utf-8');
}
