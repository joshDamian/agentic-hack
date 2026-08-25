# Plan

The runway from today through submission. This document is stateful — the "Right now" section at the top gets updated at the end of each working day. Everything below the top block is the fixed plan and should only change if we deliberately re-plan.

The visual version of this plan (with the architecture diagram, shot list, cut list, and risk register) is the published brief. Refer to it for the whole picture.

---

## Right now

*Update these three lines at the end of each working day.*

- **Day:** 1 of 13 · Tue Aug 18 · foundations verified
- **Shipped:** Genkit + Vertex + Gemini 3.5 pipeline works end-to-end, region locked to europe-west3, dev UI returns a real structured response
- **Next:** Day 2 · GitHub App + Firestore schema

---

## Deadline

**Aug 31, 2026 · 5:00pm PDT** — equivalent to **Sep 1 · 1:00am WAT**. Do not brinkmanship an intercontinental deadline. Aim to submit by early evening Lagos time on the 31st.

---

## The runway, day by day

Each day owns exactly one shippable thing. If a day slips, that day is the slip — don't pull work forward. Drop something from the cut list in `CLAUDE.md` instead.

### Tue Aug 18 · Foundations ✓
Genkit pipeline verified. Region locked to `europe-west3`. Dev UI returns structured output. Credit form submitted. $50 budget alert set.

### Wed Aug 19 · GitHub auth + Firestore schema
Create the GitHub App. Install on the target repo with `security_events`, `contents`, `pull_requests`, `actions` scopes. Wire Octokit. Initialise Firestore collections: `campaigns`, `bumps`, `alerts_seen`, `pr_state`, `runs`. End of day: `list_alerts()` returns the real 200+ alerts as JSON.

### Thu Aug 20 · Prioritiser
Ingest alerts, group by root package, compute the minimum bump-set that closes the maximum alerts. Rank by alerts-closed-per-bump. Store the plan. No Gemini yet — pure code. End of day: a JSON plan showing "bump axios → closes 12 alerts" etc.

### Fri Aug 21 · Changelog reader
For each planned bump, fetch release notes (GitHub Releases API, npm registry). `gemini-3.5-flash` extracts a structured list of breaking changes with removed/renamed API names. Cache aggressively in Firestore — every re-run should skip re-fetch.

### Sat Aug 22 · Codebase usage analyser
Given a list of breaking API names, scan the repo for real usage. Exact grep first (cheap). `gemini-3.5-pro` for semantic ambiguity (rare, expensive). Classify each bump: **safe / risky / unknown**. Risky verdicts must cite `src/foo.ts:42` — that specificity is the demo moment. End of day: pipeline goes from alert list → ranked plan → per-bump verdicts.

### Sun Aug 23 · Executor · branch + PR
For each safe bump: create a branch off default, update the package manifest (detect npm/yarn/pnpm), commit, push, open a PR with a structured body describing plan + verdict. Batch compatible safe bumps into one PR to save CI runs. Risky bumps still open a PR, but labelled and with the code-cited comment.

### Mon Aug 24 · Executor · CI + merge
Poll the Actions API for the PR's CI status. On green + safe verdict → merge and close the resolved alerts. On red → keep PR open. The auto-merge is the scariest 20 lines in the whole build — guard with `DRY_RUN` flag; demo it as `DRY_RUN=false` on a controlled repo.

### Tue Aug 25 · Monitor · failure handling
When a batched PR fails CI, the monitor root-causes which bump broke it (isolate by re-running each bump alone or reading the CI log), splits the batch, retries the safe ones, comments the failure on the offender. End of day: full pipeline runs on a test repo unattended, backlog visibly drops.

### Wed Aug 26 · Deploy · Cloud Run + Scheduler
First `gcloud run deploy` to `europe-west3`. Grant the runtime service account `roles/aiplatform.user` and `roles/datastore.user`. Wire Cloud Scheduler cron for a nightly trigger. Confirm the deployed URL responds — expect one auth or region gotcha. Trigger a scheduled run and watch it complete without you.

### Thu Aug 27 · Dashboard
A single Express route on the same Cloud Run service reads Firestore and renders a status page: backlog burndown line, PRs by state, recent verdicts. Server-render HTML. No SPA. Include a "last run at" and "next run at" timestamp — proves autonomy.

### Fri Aug 28 · Real repo hardening
Point at the actual 200+ alert repo. Fix whatever breaks: rate limits, monorepo weirdness, unusual manifest formats, huge changelogs. Cache and batch API reads. Collect the "before" screenshots. `DRY_RUN=true` on this repo — don't merge into your own work.

### Sat Aug 29 · Record
Live demo footage against the controlled test repo where you know the outcome. Cut in the "real repo before" screenshots for scale. Screen record: Cloud Run dashboard, Vertex AI logs, Firestore reads, the `.run.app` URL, GitHub PRs opening live. Record 3+ takes — the first is always throat-clearing.

### Sun Aug 30 · Edit + write + submit
Cut video to under 4 minutes. Polish README (a stranger clones and runs it in one command). Fill the submission form. Draft the blog post for the +0.6 bonus. Video hosted publicly on YouTube — no unlisted, no private. Post the social + hashtag `#AllThingsAgenticHackathon`. Publish the blog.

### Mon Aug 31 · Buffer + final submit
Submit by early evening Lagos time. Use today for any regression the recording uncovered and for the second-category selection (Individual / Hobbyist). Confirm submission accepted; screenshot the confirmation. Tomorrow: sleep. Then the AWS port starts.

---

## Four-minute video shot list

Judges may stop watching at 4:00. Every second is spent on either the mechanism, the ground truth, or the pitch.

| Time | Beat |
|---|---|
| 0:00 – 0:20 | **The dread.** "This is my real repo. 214 Dependabot alerts. I've been avoiding this for months." Camera on the alerts page. Real count visible. |
| 0:20 – 0:50 | **Who has this problem.** Solo builders and small teams whose backlog nobody has time to work through. Setup for the impact score. |
| 0:50 – 1:30 | **Architecture beat.** Cut to the diagram. Name the four agents and what each owns. Name the shared services. 30 seconds, clean. |
| 1:30 – 2:30 | **Live run.** Trigger on the controlled test repo. Dashboard: plan builds → verdicts appear → PRs open → CI runs → merges happen. |
| 2:30 – 3:15 | **Ground truth.** Cut to actual GitHub. Alert count drops. Click into one blocked PR — read the comment aloud. Concrete, verifiable, cited. |
| 3:15 – 3:45 | **Proof it's on Google Cloud.** Cloud Run dashboard green. Vertex AI logs with real request traffic. `.run.app` URL visible. Firestore document view. |
| 3:45 – 4:00 | **Closing card.** Repo URL, architecture link, one line: "Runs nightly. I never touch it. The backlog will be gone in a week." |

---

## +0.6 bonus checklist

Slot into days 27–30. Not on the deadline.

- [ ] Blog / video about the build (+0.2) — dev.to or your site, 800 words, honest about what broke
- [ ] Social post with `#AllThingsAgenticHackathon` (+0.2) — one thread, honest, links to the video
- [ ] Gemma added to the codebase-usage classifier (+0.2) — small local model, keeps proprietary code off the hosted one
