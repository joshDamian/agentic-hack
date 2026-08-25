import type { Request, Response } from 'express';
import { listCampaigns } from './tools/firestore/client.js';
import type { Campaign, PlannedBump } from './shared/types.js';

export async function dashboardHandler(_req: Request, res: Response) {
  const campaigns = await listCampaigns();
  const latest = campaigns[0] ?? null;
  const html = renderDashboard(campaigns, latest);
  res.type('html').send(html);
}

function renderDashboard(campaigns: Campaign[], latest: Campaign | null): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>depbot-triage</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; background: #0d1117; color: #c9d1d9; padding: 2rem; max-width: 960px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin-bottom: 0.5rem; color: #f0f6fc; }
  .subtitle { color: #8b949e; margin-bottom: 2rem; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
  .stat { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 1rem; }
  .stat-value { font-size: 2rem; font-weight: 700; color: #f0f6fc; }
  .stat-label { font-size: 0.8rem; color: #8b949e; margin-top: 0.25rem; }
  .safe { color: #3fb950; }
  .risky { color: #f85149; }
  .unknown { color: #d29922; }
  .pending { color: #8b949e; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 2rem; }
  th { text-align: left; padding: 0.5rem; border-bottom: 1px solid #30363d; color: #8b949e; font-size: 0.8rem; text-transform: uppercase; }
  td { padding: 0.5rem; border-bottom: 1px solid #21262d; font-size: 0.9rem; }
  .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 12px; font-size: 0.75rem; font-weight: 600; }
  .badge-safe { background: #238636; color: #fff; }
  .badge-risky { background: #da3633; color: #fff; }
  .badge-unknown { background: #9e6a03; color: #fff; }
  .badge-pending { background: #30363d; color: #8b949e; }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .timestamp { color: #8b949e; font-size: 0.85rem; margin-bottom: 1.5rem; }
  .empty { color: #8b949e; padding: 2rem; text-align: center; }
</style>
</head>
<body>
<h1>depbot-triage</h1>
<p class="subtitle">Autonomous Dependabot backlog agent</p>
${latest ? renderLatestCampaign(latest) : '<p class="empty">No campaigns yet. Trigger a pipeline run to get started.</p>'}
${campaigns.length > 1 ? renderCampaignHistory(campaigns.slice(1)) : ''}
</body>
</html>`;
}

function renderLatestCampaign(c: Campaign): string {
  const safe = c.plan.filter((b) => b.verdict === 'safe').length;
  const risky = c.plan.filter((b) => b.verdict === 'risky').length;
  const unknown = c.plan.filter((b) => b.verdict === 'unknown').length;
  const pending = c.plan.filter((b) => !b.verdict).length;
  const prsOpened = c.plan.filter((b) => b.prNumber).length;
  const ciPassed = c.plan.filter((b) => b.ciStatus === 'success').length;
  const ciFailed = c.plan.filter((b) => b.ciStatus === 'failure').length;
  const totalAlertsClosed = c.plan.reduce((sum, b) => sum + b.alertsClosed, 0);

  return `
<p class="timestamp">Last run: ${formatDate(c.updatedAt)} · Status: <strong>${c.status}</strong></p>

<div class="stats">
  <div class="stat"><div class="stat-value">${totalAlertsClosed}</div><div class="stat-label">Alerts addressed</div></div>
  <div class="stat"><div class="stat-value">${c.plan.length}</div><div class="stat-label">Bumps planned</div></div>
  <div class="stat"><div class="stat-value safe">${safe}</div><div class="stat-label">Safe</div></div>
  <div class="stat"><div class="stat-value risky">${risky}</div><div class="stat-label">Risky</div></div>
  <div class="stat"><div class="stat-value">${prsOpened}</div><div class="stat-label">PRs opened</div></div>
  <div class="stat"><div class="stat-value safe">${ciPassed}</div><div class="stat-label">CI passed</div></div>
</div>

<table>
<thead><tr><th>Package</th><th>Bump</th><th>Alerts</th><th>Verdict</th><th>PR</th><th>CI</th></tr></thead>
<tbody>
${c.plan.map((b) => renderBumpRow(c, b)).join('\n')}
</tbody>
</table>`;
}

function renderBumpRow(c: Campaign, b: PlannedBump): string {
  const verdict = b.verdict ?? 'pending';
  const prLink = b.prNumber
    ? `<a href="https://github.com/${c.repoOwner}/${c.repoName}/pull/${b.prNumber}">#${b.prNumber}</a>`
    : '—';
  const ciLabel = b.ciStatus ?? '—';

  return `<tr>
  <td><strong>${b.packageName}</strong></td>
  <td>${b.currentVersion} → ${b.targetVersion}</td>
  <td>${b.alertsClosed}</td>
  <td><span class="badge badge-${verdict}">${verdict}</span></td>
  <td>${prLink}</td>
  <td>${ciLabel}</td>
</tr>`;
}

function renderCampaignHistory(campaigns: Campaign[]): string {
  return `
<h2 style="font-size:1.1rem; margin-bottom:0.5rem; color:#f0f6fc;">Previous runs</h2>
<table>
<thead><tr><th>Campaign</th><th>Status</th><th>Bumps</th><th>Date</th></tr></thead>
<tbody>
${campaigns.map((c) => `<tr>
  <td>${c.repoOwner}/${c.repoName}</td>
  <td>${c.status}</td>
  <td>${c.plan.length}</td>
  <td>${formatDate(c.createdAt)}</td>
</tr>`).join('\n')}
</tbody>
</table>`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });
}
