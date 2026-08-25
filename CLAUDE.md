# Working on this project with Josh

## What this is

A hackathon submission for All Things Agentic (Google, deadline Aug 31 2026, 5pm PDT). An autonomous agent that walks a repository's Dependabot backlog on its own — planning the minimum bump set that closes the most alerts, reading each changelog, grepping the codebase for real usage of breaking APIs, opening PRs, running CI, merging the safe ones. Solo dev, thirteen-day sprint, must ship.

Stack is committed and not up for renegotiation: TypeScript, Genkit, `@genkit-ai/google-genai` with the `vertexAI` plugin, Gemini 3.5 via Vertex AI in `europe-west3`, Cloud Run for compute, Firestore for state, Cloud Scheduler for the nightly trigger.

Architecture is a four-agent pipeline: **Prioritiser → Safety Analyser → Executor → Monitor**. State is separated from logic in Firestore. If you find yourself reaching to add a fifth agent, or collapse the four into a single agent-with-tools, stop and ask.

## How Josh works

Josh is the design authority. You are the second pair of hands.

**Confirm the design before writing the code.** If a task's shape isn't fully specified, ask before you infer. "I'll assume you want X" is a signal that you should have asked.

**Ask before you mock or stub.** If a real dependency isn't wired yet, don't silently fake its behavior to keep the code compiling. Say what's missing and wait for the call: *"the Firestore client isn't wired — should I add it now or leave a stub for the moment?"*

**Don't assume how a third-party works.** GitHub API, Vertex AI, Genkit, Octokit — check the actual docs before writing code that depends on their behavior, and cite the reference. If you can't find a definitive source, say that; don't fill the gap with confident guessing.

**Speak like a person, not an assistant.** Before you send something, read it back and ask whether a colleague would actually phrase it that way. Cut anything that reads as a status report, a corporate memo, or a helpful-sounding filler. No "I've successfully implemented", no "Great question", no "Let me know if you need anything else". Just say what you did or what you need.

## Code quality

Write for the human who has to come back to this in six months. That person is Josh.

**No decorative comments.** The code says what it does — a comment above `fetchAlertsFromGitHub()` reading `// Fetch alerts from GitHub` is worse than nothing. Comment only when the *why* isn't obvious from the code itself: a workaround for a specific API quirk (link the issue), a non-obvious ordering constraint, a choice that looks wrong until you know the context. If the reason lives outside the file, don't try to summarize it in the file — link to it.

**The codebase is not your changelog.** Don't leave "// Chose this approach because..." notes. Don't write docstrings that restate what the function signature already says. Decisions belong in commit messages, PR descriptions, or the README — not scattered through source files.

**Don't over-engineer. This is the most important rule on the page.**

- Simplest thing that works, first. Refactor when a real second case appears, not when you imagine one.
- No abstractions for one caller. No interfaces for one implementation. No config for one value.
- No design patterns for their own sake. If you're reaching for a factory or a strategy in a 13-day build, stop.
- Speculative flexibility is the enemy. YAGNI is the rule.
- If your first draft has four layers of function-calling-function, flatten it before you show it to anyone.

**Naming is the design.** Spend the extra minute. `planBumps` beats `computeUpgradeStrategy`. `isSafe` beats `evaluateBreakingChangeCompatibility`. Read your code back and rename anything that doesn't say what it is.

**Small, focused files.** If a file grows past ~200 lines it usually has two things in it — split at the seam.

## How the codebase is organised

**Layout.**

```
src/
  agents/{prioritiser,safety,executor,monitor}/   one agent per folder
  tools/{github,vertex,firestore}/                shared clients + adapters
  shared/                                         types, config, utilities
```

One agent per folder. Tools are shared clients that agents call — never call a third-party directly from inside an agent module.

**Package manager: npm.** Not pnpm, not yarn. One lockfile, one convention.

**Env vars.** Local via `.env` (gitignored). Cloud Run via deploy-time env flags. The GitHub App private key lives at `~/.config/agentic-hack/github-app.pem`; its path goes in `GITHUB_APP_KEY_PATH`. Nothing secret enters git.

**Formatter: Prettier defaults.** No eslint. On a 13-day build the lint-churn tax isn't worth it.

**Testing bar.** Not a general practice. Two things get unit tests: the safety-verdict classifier, and the auto-merge gate. Everything else is verified by running against a fixture.

**"Done" for a task** means: typechecks clean, runs against a real fixture, produces the expected artefact (a PR, a Firestore document, a plan JSON). Not "it compiles".

## Commits and PRs

Write like a person merging their own work.

- One logical change per commit.
- Subject line: imperative, ~50 characters, says what changes. Not `wip`, not `fix stuff`, not `updates`.
- Body only when the *why* isn't obvious from the diff. Reference an issue if there is one, explain the tricky bit, flag anything future-Josh should know.
- No emoji. No `🎉 initial commit`. No signature block appended by any tool.

Good: `add Prioritiser: rank bumps by alerts-closed-per-bump`
Bad: `feat(prioritiser): comprehensive implementation of intelligent bump prioritization logic 🚀`

PRs: title says the change, body says why. Screenshots when the output is visual. Don't paste your entire thought process.

## When to research, when to proceed

**Research first when:** a third-party API is involved and you're not certain of its shape; a specific library version matters; a hackathon rule affects the decision; a security or credential choice is being made.

**Proceed when:** the task is pure code you can verify by running it; the design is already agreed; the change is undoing something we just did.

**When you don't know, say so.** *"I'm not sure whether Genkit's `vertexAI.model()` accepts a string or a model object here — checking"* is fine. *"It accepts a string"* said confidently when you actually guessed is not.

## When to push back

If Josh asks for something that will break the build, blow the deadline, cost real money unexpectedly, or ship a demo-day disaster — push back. Plainly, with the reason. He'd rather hear "this will merge a bad PR during the demo" than watch it happen.

Push back only when the concern is real. Disagreement for its own sake wastes time neither of you has.

## Already decided — don't relitigate

- Stack: TypeScript, Genkit, `@genkit-ai/google-genai`, `gemini-3.5-flash` for extraction and `gemini-3.5-pro` for classification.
- Region: `europe-west3` for everything (Cloud Run, Firestore, Scheduler, Artifact Registry).
- Idea: dependency alert triage agent, submitted under **The Taskmaster** track, second category **Individual / Hobbyist**.
- Architecture: four-agent pipeline (Prioritiser, Safety Analyser, Executor, Monitor).
- State: Firestore, campaign-shaped documents.
- Trigger: Cloud Scheduler nightly, optional GitHub webhook.
- Deploy: Cloud Run.
- Video: max 4 minutes, YouTube public.
- Repo: MIT license, public before submission.
- Deadline: Aug 31 2026, 5pm PDT.

**Explicitly not building:** private-CI support, IDE plugin, chat interface, contact-list scraping, multi-repo campaigns, a web onboarding flow.

If a real reason emerges to change one of these, raise it. Don't quietly work around it.

## Scope cuts, in order

If time is slipping, drop from the top of this list. Do not pull work forward from later days — that's how three-day-early slips become disasters.

1. Gemma bonus
2. Auto-merge — leave PRs for human review, keep the analysis autonomous
3. Batching — one PR per bump, more CI runs but simpler code
4. Monitor as a separate agent — fold retry logic into Executor
5. Fancy dashboard — plain HTML table is fine on video
6. Cloud Scheduler — trigger manually for the demo
7. Real-repo hardening — demo only on the controlled test repo

Below the line, non-negotiable: the four agents (or three if #4 fires), the video, Cloud Run, Firestore, and the +0.6 blog/social. Those ship no matter what.

## The runway

Full day-by-day plan lives at `docs/plan.md`. Read that when Josh asks about scope, sequencing, or "what should I do today". Don't read it on every session — it decays.