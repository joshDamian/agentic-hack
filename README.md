# Autonomous Dependabot Triage Agent

An autonomous agent that works through a repository's Dependabot backlog on its own — planning the minimum bump set that closes the most alerts, reading changelogs, scanning the codebase for real usage of breaking APIs, opening PRs, and self-healing broken builds through an iterative fix cycle.

Built for the [All Things Agentic](https://allthingsagentichackathon.devpost.com/) hackathon (The Taskmaster track).

## How it works

Four agents run as a pipeline, with state tracked in Firestore:

```
Prioritiser ─► Safety Analyser ─► Executor ─► Monitor
```

**Prioritiser** reads Dependabot alerts and `package-lock.json`, groups alerts by root package, and ranks bumps by alerts-closed-per-bump.

**Safety Analyser** fetches changelogs and release notes, extracts breaking changes, searches the codebase for actual usage of affected APIs (batched GitHub code search, then verified import checks), and runs an isolated `tsc --noEmit` compile check against the target version. Each bump gets a verdict: `safe`, `risky`, or `unknown`, with cited findings (`src/foo.ts:42`).

**Executor** creates a branch per bump, updates `package.json`, commits, opens a PR with the analysis as a review, and kicks off CI.

**Monitor** is handled by a webhook listener. When CI completes:
- Safe + CI green → ready to merge
- Risky or CI red → re-analyse with CI error logs, then hand off to the **Coder Agent**

### The fix cycle

When the Safety Analyser finds fixable breaking changes, the Coder Agent takes over:

1. Reads each affected file via the GitHub API
2. Writes a patch using the Git Data API (blobs, trees, commits) — no local clone needed
3. Polls CI every 15 seconds until the build finishes
4. If CI still fails, re-analyses with the new error logs and tries again
5. Loops up to 5 attempts per bump

The entire cycle — fix, poll, re-analyse, retry — runs as a self-contained loop inside the webhook handler. No human interaction required.

## Architecture
<img width="1856" height="1044" alt="slide-04" src="https://github.com/user-attachments/assets/be1b63b0-923d-4535-ae80-796f43c2df1d" />


```
src/
├── agents/
│   ├── prioritiser/    plan bumps from alerts
│   ├── safety/         changelog + code analysis + verdict
│   ├── executor/       branch, PR, review
│   ├── monitor/        CI polling (folded into webhook handler)
│   └── coder/          autonomous fix agent
├── tools/
│   ├── github/         Octokit client, PR creation, CI status, zipball cache
│   ├── firestore/      campaign state, transactional leases
│   └── npm/            compile checks, registry, type diffs
├── shared/             types, config, concurrency
├── pipeline.ts         orchestrates the four agents
├── webhook.ts          GitHub webhook handler + fix cycle
├── reanalyse.ts        manual re-analysis trigger
└── dashboard.ts        live status page
```

State is separated from logic. Each bump's verdict and CI status live in a Firestore campaign document. Concurrent webhook events are serialised with a transactional lease pattern (verdict set to `reanalysing` or `fixing` with a timestamp; 10-minute timeout for crash recovery).

## Stack

- **Runtime:** Node.js, TypeScript, Express
- **AI:** [Genkit](https://github.com/firebase/genkit) with `@genkit-ai/google-genai`, Gemini 3.5 via Vertex AI
- **State:** Cloud Firestore (campaign documents with transactional updates)
- **Compute:** Google Cloud Run (`europe-west3`)
- **Deploy:** Cloud Build → Artifact Registry → Cloud Run
- **GitHub integration:** GitHub App (Octokit, webhooks)

## Setup

### Prerequisites

- Node.js 20+
- A Google Cloud project with Firestore, Vertex AI, Cloud Run, and Artifact Registry enabled
- A GitHub App with these permissions:
  - **Dependabot alerts:** Read
  - **Contents:** Read & Write
  - **Pull requests:** Read & Write
  - **Checks:** Read
  - **Commit statuses:** Read
  - Webhook events: `check_suite`, `check_run`

### Environment

Create a `.env` file:

```env
GOOGLE_CLOUD_PROJECT=your-gcp-project-id
GOOGLE_CLOUD_LOCATION=europe-west3
GITHUB_APP_ID=your-app-id
GITHUB_INSTALLATION_ID=your-installation-id
GITHUB_APP_KEY_PATH=~/.config/agentic-hack/github-app.pem
GITHUB_WEBHOOK_SECRET=your-webhook-secret
TARGET_REPO_OWNER=owner
TARGET_REPO_NAME=repo
```

### Run locally

```bash
npm install
npm run dev
```

The dev server starts on port 8080 with a live dashboard at `/` and Genkit dev UI.

### Deploy

```bash
gcloud builds submit --config cloudbuild.yaml \
  --substitutions SHORT_SHA=$(git rev-parse --short HEAD)
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Live dashboard |
| `POST` | `/trigger` | Start a pipeline run (`{owner, repo, fresh?}`) |
| `POST` | `/webhook` | GitHub webhook receiver |
| `POST` | `/reanalyse` | Re-analyse a single bump |
| `GET` | `/api/status` | Campaign status |
| `GET` | `/api/stream` | SSE stream for dashboard updates |
| `GET` | `/healthz` | Health check |

## License

[MIT](LICENSE)
