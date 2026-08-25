export const config = {
  gcpProject: process.env.GOOGLE_CLOUD_PROJECT ?? 'all-things-agentic-506113',
  gcpLocation: process.env.GOOGLE_CLOUD_LOCATION ?? 'europe-west3',
  githubAppId: process.env.GITHUB_APP_ID ?? '',
  githubAppKeyPath: process.env.GITHUB_APP_KEY_PATH ?? `${process.env.HOME}/.config/agentic-hack/github-app.pem`,
  githubInstallationId: process.env.GITHUB_INSTALLATION_ID ?? '',
  targetRepo: {
    owner: process.env.TARGET_REPO_OWNER ?? 'joshDamian',
    name: process.env.TARGET_REPO_NAME ?? 'depbot-test-repo',
  },
};
