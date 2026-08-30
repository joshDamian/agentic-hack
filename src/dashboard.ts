import type { Request, Response } from 'express';
import { listCampaigns } from './tools/firestore/client.js';
import { config } from './shared/config.js';
import type { Campaign, PlannedBump } from './shared/types.js';
import { dedent } from './shared/text.js';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import java from 'highlight.js/lib/languages/java';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import sql from 'highlight.js/lib/languages/sql';
import php from 'highlight.js/lib/languages/php';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('ruby', ruby);
hljs.registerLanguage('go', go);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('java', java);
hljs.registerLanguage('json', json);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('css', css);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('php', php);

const SCHEDULE_HOUR = Number(process.env.PIPELINE_SCHEDULE_HOUR ?? '2');
const SCHEDULE_TZ = process.env.PIPELINE_TIMEZONE ?? 'Africa/Lagos';

function resolveRepo(
  repoParam: string | undefined,
  campaigns: Campaign[],
): { campaigns: Campaign[]; repo: { owner: string; name: string } } {
  if (repoParam && repoParam.includes('/')) {
    const [owner, ...rest] = repoParam.split('/');
    const repo = { owner, name: rest.join('/') };
    return { campaigns: campaigns.filter((c) => c.repoOwner === owner && c.repoName === repo.name), repo };
  }
  const repo = campaigns[0]
    ? { owner: campaigns[0].repoOwner, name: campaigns[0].repoName }
    : config.targetRepo;
  return { campaigns, repo };
}

export async function dashboardHandler(req: Request, res: Response) {
  const all = await listCampaigns();
  const { campaigns, repo } = resolveRepo(req.query.repo as string | undefined, all);
  const latest = campaigns[0] ?? null;
  res.type('html').send(renderPage(campaigns, latest, repo));
}

export async function dashboardPartialHandler(req: Request, res: Response) {
  const all = await listCampaigns();
  const { campaigns, repo } = resolveRepo(req.query.repo as string | undefined, all);
  const latest = campaigns[0] ?? null;
  const active = !!latest && !['done', 'failed'].includes(latest.status);
  const stuck = !!latest && isStuck(latest);
  const html = `${renderTopbar(repo, active, stuck, latest)}
<main>
${latest ? renderToast(latest) : ''}
${latest ? renderRunCard(latest, stuck) : renderEmpty()}
${campaigns.length > 1 ? renderHistory(campaigns.slice(1)) : ''}
</main>`;
  res.type('html').send(html);
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });
}

function fmtDuration(startIso: string, endIso: string): string {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  if (mins < 60) return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs}h`;
}

const stageKeys = ['planning', 'analysing', 'executing', 'monitoring', 'done'];
const stageLabels = ['Plan', 'Analyse', 'Execute', 'Monitor', 'Done'];

function isStuck(c: Campaign): boolean {
  if (['done', 'failed'].includes(c.status)) return false;
  const age = Date.now() - new Date(c.updatedAt).getTime();
  return age > 2 * 60 * 1000;
}

function renderToast(c: Campaign): string {
  if (c.status !== 'done' || !c.completedAt) return '';
  const ago = Date.now() - new Date(c.completedAt).getTime();
  if (ago > 5 * 60 * 1000) return '';
  const duration = c.startedAt ? fmtDuration(c.startedAt, c.completedAt) : '';
  const safe = c.plan.filter((b) => b.verdict === 'safe').length;
  const risky = c.plan.filter((b) => b.verdict === 'risky').length;
  const prs = c.plan.filter((b) => b.prNumber).length;
  return `<div class="toast" id="toast">
  <span class="toast-icon">&#10003;</span>
  <span class="toast-text">Pipeline completed${duration ? ` in <strong>${duration}</strong>` : ''} &mdash; ${safe} safe, ${risky} risky, ${prs} PRs opened</span>
  <button class="toast-close" onclick="document.getElementById('toast').remove()">&times;</button>
</div>`;
}

function renderPage(campaigns: Campaign[], latest: Campaign | null, repo: { owner: string; name: string }): string {
  const active = !!latest && !['done', 'failed'].includes(latest.status);
  const stuck = !!latest && isStuck(latest);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>depbot-triage</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400&family=Manrope:wght@600;700;800&family=Source+Sans+3:wght@400;600&display=swap" rel="stylesheet">
<style>${STYLES}</style>
</head>
<body>
<div id="live-root">
${renderTopbar(repo, active, stuck, latest)}
<main>
${latest ? renderToast(latest) : ''}
${latest ? renderRunCard(latest, stuck) : renderEmpty()}
${campaigns.length > 1 ? renderHistory(campaigns.slice(1)) : ''}
</main>
</div>
<script>${clientScript(active, repo)}</script>
</body>
</html>`;
}

const installUrl = config.githubAppSlug
  ? `https://github.com/apps/${config.githubAppSlug}/installations/new`
  : '';

function renderTopbar(repo: { owner: string; name: string }, active: boolean, stuck: boolean, latest?: Campaign | null): string {
  const connectBtn = installUrl
    ? `<a class="connect-btn" href="${installUrl}" target="_blank" title="Connect a repository">+</a>`
    : '';

  return `<div class="topbar">
  <div class="topbar-inner">
    <div class="brand">
      <span class="brand-name">depbot-triage</span>
      <select class="repo-select" id="repo-select" onchange="switchRepo(this.value)">
        <option value="${esc(repo.owner)}/${esc(repo.name)}" selected>${esc(repo.owner)}/${esc(repo.name)}</option>
      </select>
      <a class="repo-gh" href="https://github.com/${esc(repo.owner)}/${esc(repo.name)}" target="_blank" title="Open on GitHub"><svg viewBox="0 0 12 12" width="12" height="12"><path d="M3.5 3v1h4.29L2.15 9.64l.7.71L8.5 4.71V9h1V3z" fill="currentColor"/></svg></a>
      ${connectBtn}
    </div>
    <div class="topbar-spacer"></div>
    <div class="schedule">
      <div class="schedule-dot"></div>
      <span>Next run</span>
      <span class="schedule-time" id="countdown">—</span>
    </div>
    ${stuck ? `<button class="run-btn" onclick="triggerRun(false)"><svg viewBox="0 0 12 14"><polygon points="2,0 12,7 2,14"/></svg> Resume</button>
    <button class="run-btn run-btn-secondary" onclick="triggerRun(true)">Start fresh</button>`
    : `<button class="run-btn" id="run-btn" onclick="triggerRun()" ${active ? 'disabled' : ''}>
      ${active ? `<span class="spinner"></span> ${latest ? stageProgressLabel(latest) : 'Running'}…` : '<svg viewBox="0 0 12 14"><polygon points="2,0 12,7 2,14"/></svg> Run now'}
    </button>`}
  </div>
</div>`;
}

function stageProgressLabel(c: Campaign): string {
  if (c.status === 'analysing') {
    const done = c.plan.filter((b) => b.verdict).length;
    return `Analysing ${done}/${c.plan.length}`;
  }
  if (c.status === 'executing') {
    const done = c.plan.filter((b) => b.prNumber).length;
    const eligible = c.plan.filter((b) => b.verdict).length;
    return `Executing ${done}/${eligible}`;
  }
  if (c.status === 'monitoring') {
    const resolved = c.plan.filter((b) => b.ciStatus === 'success' || b.ciStatus === 'failure').length;
    const withPRs = c.plan.filter((b) => b.prNumber).length;
    return `Monitoring ${resolved}/${withPRs}`;
  }
  return 'Running';
}

function renderRunCard(c: Campaign, stuck: boolean): string {
  const statusLabel = c.status === 'done' ? 'Done' : c.status === 'failed' ? 'Failed' : stuck ? 'Interrupted' : stageProgressLabel(c);
  const statusCls = c.status === 'done' ? 'done' : c.status === 'failed' ? 'failed' : stuck ? 'stuck' : 'active';

  const durationTag = c.startedAt && c.completedAt
    ? `<span class="run-sep">&middot;</span><span class="run-duration">${fmtDuration(c.startedAt, c.completedAt)}</span>`
    : '';

  return `<div class="run-card">
  <div class="run-header">
    <span class="run-label">Latest run</span>
    <span class="run-sep">&middot;</span>
    <span class="run-time">${fmtDate(c.createdAt)}</span>
    <span class="run-sep">&middot;</span>
    <span class="run-status ${statusCls}"><span class="run-status-dot"></span> ${statusLabel}</span>
    ${durationTag}
  </div>
  <div class="run-body">
    ${renderPipeline(c)}
    ${renderStats(c)}
    ${renderBumps(c)}
  </div>
</div>`;
}

function renderPipeline(c: Campaign): string {
  const status = c.status;
  const idx = stageKeys.indexOf(status);
  const isFailed = status === 'failed';
  const parts: string[] = [];

  for (let i = 0; i < stageLabels.length; i++) {
    let cls = 'step';
    if (isFailed) {
      // all steps neutral on failure
    } else if (status === 'done' || i < idx) {
      cls += ' done';
    } else if (i === idx) {
      cls += ' active';
    }

    let label = stageLabels[i];
    if (stageKeys[i] === 'analysing' && status === 'analysing') {
      const done = c.plan.filter((b) => b.verdict).length;
      label = `Analyse (${done}/${c.plan.length})`;
    } else if (stageKeys[i] === 'executing' && status === 'executing') {
      const done = c.plan.filter((b) => b.prNumber).length;
      const eligible = c.plan.filter((b) => b.verdict).length;
      label = `Execute (${done}/${eligible})`;
    } else if (stageKeys[i] === 'monitoring' && status === 'monitoring') {
      const resolved = c.plan.filter((b) => b.ciStatus === 'success' || b.ciStatus === 'failure').length;
      const withPRs = c.plan.filter((b) => b.prNumber).length;
      label = `Monitor (${resolved}/${withPRs})`;
    }

    parts.push(
      `<div class="${cls}"><div class="step-dot"></div><span class="step-label">${label}</span></div>`,
    );

    if (i < stageLabels.length - 1) {
      let lineCls = 'step-line';
      if (!isFailed && (status === 'done' || i < idx)) lineCls += ' done';
      parts.push(`<div class="${lineCls}"></div>`);
    }
  }

  return `<div class="pipeline">${parts.join('')}</div>`;
}

function renderStats(c: Campaign): string {
  const safe = c.plan.filter((b) => b.verdict === 'safe').length;
  const risky = c.plan.filter((b) => b.verdict === 'risky').length;
  const prs = c.plan.filter((b) => b.prNumber).length;
  const ciOk = c.plan.filter((b) => b.ciStatus === 'success').length;
  const totalAlerts = c.plan.reduce((sum, b) => sum + b.alertsClosed, 0);

  return `<div class="stats">
  <div class="stat-group">
    <div class="stat-group-label">Scope</div>
    <div class="stat-pair">
      <div class="stat"><div class="stat-val">${totalAlerts}</div><div class="stat-lbl">Alerts</div></div>
      <div class="stat"><div class="stat-val">${c.plan.length}</div><div class="stat-lbl">Bumps</div></div>
    </div>
  </div>
  <div class="stat-group">
    <div class="stat-group-label">Verdict</div>
    <div class="stat-pair">
      <div class="stat"><div class="stat-val safe">${safe}</div><div class="stat-lbl">Safe</div></div>
      <div class="stat"><div class="stat-val risk">${risky}</div><div class="stat-lbl">Risky</div></div>
    </div>
  </div>
  <div class="stat-group">
    <div class="stat-group-label">Execution</div>
    <div class="stat-pair">
      <div class="stat"><div class="stat-val">${prs}</div><div class="stat-lbl">PRs</div></div>
      <div class="stat"><div class="stat-val safe">${ciOk}</div><div class="stat-lbl">CI pass</div></div>
    </div>
  </div>
</div>`;
}

function renderBumps(c: Campaign): string {
  return `<div class="bumps-header">
  <span class="bumps-title">Dependency bumps</span>
  <span class="bumps-count">${c.plan.length} packages</span>
</div>
<div class="bump-list">
  <div class="bump-cols bump-list-head">
    <span></span><span>Package</span><span>Version</span><span>Alerts</span><span>Verdict</span><span>PR</span><span>CI</span>
  </div>
  ${c.plan.map((b, i) => renderBumpRow(c, b, i)).join('\n  ')}
</div>`;
}

function renderBumpRow(c: Campaign, b: PlannedBump, i: number): string {
  const verdict = b.verdict ?? 'pending';
  const hasDetail = !!(b.verdictReason || b.breakingChanges?.length || b.findings?.length);

  const prUrl = b.prNumber
    ? `https://github.com/${esc(c.repoOwner)}/${esc(c.repoName)}/pull/${b.prNumber}`
    : '';
  const prCell = prUrl
    ? `<a class="pr-link" href="${prUrl}" target="_blank" onclick="event.stopPropagation()">PR #${b.prNumber} <svg viewBox="0 0 12 12"><path d="M3.5 3v1h4.29L2.15 9.64l.7.71L8.5 4.71V9h1V3z" fill="currentColor"/></svg></a>`
    : '<span class="ci none">&mdash;</span>';

  let ciCell: string;
  if (b.ciStatus === 'success') ciCell = '<span class="ci pass">Passed</span>';
  else if (b.ciStatus === 'failure') ciCell = '<span class="ci fail">Failed</span>';
  else if (b.ciStatus === 'pending') ciCell = '<span class="ci wait">Pending</span>';
  else ciCell = '<span class="ci none">&mdash;</span>';

  const reanalyseBtn = `<button class="reanalyse-btn" onclick="event.stopPropagation(); reanalyse(this, '${esc(c.id)}', '${esc(b.packageName)}')" title="Re-run safety analysis">Re-analyse</button>`;

  return `<div class="bump-row v-${verdict}" data-pkg="${esc(b.packageName)}" onclick="toggle(this)">
    <div class="bump-cols">
      <span class="bump-arrow">&#9654;</span>
      <span class="bump-pkg">${esc(b.packageName)}</span>
      <span class="bump-ver">${esc(b.currentVersion)} &rarr; ${esc(b.targetVersion)}</span>
      <span class="bump-alerts">${b.alertsClosed}</span>
      <span><span class="verdict ${verdict}">${verdict}</span></span>
      <span>${prCell}</span>
      <span>${ciCell}</span>
    </div>
  </div>
  <div class="bump-detail" id="d${i}">
    <div class="detail-inner">
      ${hasDetail ? renderDetail(c, b) : ''}
      <div class="detail-actions">${reanalyseBtn}</div>
    </div>
  </div>`;
}

const EXT_LANG: Record<string, string> = {
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript',
  '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust',
  '.java': 'java', '.json': 'json', '.yml': 'yaml', '.yaml': 'yaml',
  '.sh': 'bash', '.css': 'css', '.html': 'xml', '.xml': 'xml',
  '.sql': 'sql', '.php': 'php',
};

function highlightCode(code: string, filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  const lang = dot !== -1 ? EXT_LANG[filePath.slice(dot)] : undefined;
  if (lang) {
    return hljs.highlight(code, { language: lang }).value;
  }
  return hljs.highlightAuto(code).value;
}

function renderDetail(c: Campaign, b: PlannedBump): string {
  let html = '';

  if (b.verdictReason) {
    html += `<div class="detail-section">
      <div class="detail-label">Analysis</div>
      <p class="detail-text">${esc(b.verdictReason)}</p>
    </div>`;
  }

  if (b.breakingChanges?.length) {
    const items = b.breakingChanges
      .map((bc) => {
        let li = `<li><span class="bc-kind">${esc(bc.kind)}</span> <span class="bc-api">${esc(bc.api)}</span> <span class="bc-desc">&mdash; ${esc(bc.description)}</span>`;
        if (bc.migrationHint) li += ` <span class="bc-hint">${esc(bc.migrationHint)}</span>`;
        return li + '</li>';
      })
      .join('\n      ');
    html += `<div class="detail-section">
      <div class="detail-label">Breaking changes</div>
      <ul class="bc-list">${items}</ul>
    </div>`;
  }

  if (b.findings?.length) {
    const affected = b.findings.filter((f) => f.isAffected);
    const ok = b.findings.filter((f) => !f.isAffected);
    html += '<div class="detail-section"><div class="detail-label">Code review</div>';
    for (const f of affected) {
      const findingIdx = b.findings!.indexOf(f);
      const hasApply = f.suggestedFix && b.prNumber;
      const hasFix = !!(f.originalCode || f.suggestedFix);
      html += `<div class="finding affected">
        <div class="finding-loc">${esc(f.file)}:${f.line}</div>
        <p>${esc(f.analysis)}</p>
        ${hasFix ? `<div class="fix-row"><div class="fix-label">${f.originalCode && f.suggestedFix ? 'Before → After' : 'Suggested fix'}</div>${hasApply ? `<button class="apply-fix-btn" onclick="event.stopPropagation(); applyFix(this, '${esc(c.id)}', '${esc(b.packageName)}', ${findingIdx})">Apply fix</button>` : ''}</div><div class="code-diff">${f.originalCode ? `<pre class="code-block code-before">${highlightCode(dedent(f.originalCode), f.file)}</pre>` : ''}${f.originalCode && f.suggestedFix ? '<div class="diff-arrow">→</div>' : ''}${f.suggestedFix ? `<pre class="code-block code-after">${highlightCode(dedent(f.suggestedFix), f.file)}</pre>` : ''}</div>` : ''}
      </div>`;
    }
    if (ok.length > 0) {
      html += `<button class="fp-toggle" onclick="event.stopPropagation(); var t=this.nextElementSibling; var open=t.classList.toggle('open'); this.textContent=open ? 'Hide checked but not affected (${ok.length})' : 'Checked but not affected (${ok.length})';">Checked but not affected (${ok.length})</button>`;
      html += '<div class="fp-group">';
      for (const f of ok) {
        html += `<div class="finding ok">
          <div class="finding-loc">${esc(f.file)}:${f.line}</div>
          <p>${esc(f.analysis)}</p>
        </div>`;
      }
      html += '</div>';
    }
    html += '</div>';
  }

  return html;
}

function renderEmpty(): string {
  const installLink = installUrl
    ? `<a class="empty-connect" href="${installUrl}" target="_blank">Install the GitHub App</a> on a repository, then click <strong>Run now</strong>.`
    : `Click <strong>Run now</strong> to scan for Dependabot alerts and start triaging.`;

  return `<div class="empty">
  <div class="empty-icon">&#x1F4E6;</div>
  <h2>No campaigns yet</h2>
  <p>${installLink}</p>
</div>`;
}

function renderHistory(campaigns: Campaign[]): string {
  const rows = campaigns
    .map((c) => {
      const cls = c.status === 'failed' ? ' failed' : '';
      const label = c.status === 'done' ? 'Done' : c.status === 'failed' ? 'Failed' : c.status;
      const dur = c.startedAt && c.completedAt ? fmtDuration(c.startedAt, c.completedAt) : '—';
      const safe = c.plan.filter((b) => b.verdict === 'safe').length;
      const risky = c.plan.filter((b) => b.verdict === 'risky').length;
      const prs = c.plan.filter((b) => b.prNumber).length;
      return `<div class="history-row">
      <span class="history-repo">${esc(c.repoOwner)}/${esc(c.repoName)}</span>
      <span><span class="history-status${cls}">${label}</span></span>
      <span>${c.plan.length}</span>
      <span class="history-stats"><span class="mini-safe">${safe}</span><span class="mini-sep">/</span><span class="mini-risky">${risky}</span><span class="mini-sep">/</span><span class="mini-prs">${prs}</span></span>
      <span class="run-duration">${dur}</span>
      <span style="color:var(--text-dim)">${fmtDate(c.createdAt)}</span>
    </div>`;
    })
    .join('\n    ');

  return `<div class="history">
  <div class="history-title">Previous runs</div>
  <div class="history-list">
    <div class="history-row head">
      <span>Repository</span><span>Status</span><span>Bumps</span><span title="Safe / Risky / PRs">S / R / PR</span><span>Duration</span><span>Date</span>
    </div>
    ${rows}
  </div>
</div>`;
}

function clientScript(_active: boolean, repo: { owner: string; name: string }): string {
  return `
var _lastUpdate = '';

function toggle(row) {
  var detail = row.nextElementSibling;
  var isOpen = row.classList.toggle('open');
  if (isOpen) detail.classList.add('open');
  else detail.classList.remove('open');
}

function getOpenPackages() {
  var open = [];
  document.querySelectorAll('.bump-row.open[data-pkg]').forEach(function(r) {
    open.push(r.getAttribute('data-pkg'));
  });
  return open;
}

function restoreOpenPackages(pkgs) {
  pkgs.forEach(function(pkg) {
    var rows = document.querySelectorAll('.bump-row[data-pkg]');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute('data-pkg') === pkg) {
        rows[i].classList.add('open');
        rows[i].nextElementSibling.classList.add('open');
        break;
      }
    }
  });
}

function refreshContent() {
  var repoParam = encodeURIComponent('${repo.owner}/${repo.name}');
  fetch('/api/partial?repo=' + repoParam).then(function(res) {
    return res.text();
  }).then(function(html) {
    var open = getOpenPackages();
    var scroll = window.scrollY;
    var wrapper = document.getElementById('live-root');
    if (wrapper) wrapper.innerHTML = html;
    restoreOpenPackages(open);
    window.scrollTo(0, scroll);
    openFromHash();
  }).catch(function(e) { console.error('Refresh failed:', e); });
}

function connectStream() {
  var src = new EventSource('/api/stream?repo=' + encodeURIComponent('${repo.owner}/${repo.name}'));
  src.onmessage = function(e) {
    try {
      var data = JSON.parse(e.data);
      var key = data ? data.updatedAt + data.status : 'null';
      if (key !== _lastUpdate) {
        _lastUpdate = key;
        refreshContent();
      }
    } catch (err) { console.error('SSE parse error:', err); }
  };
  src.onerror = function() {
    src.close();
    setTimeout(connectStream, 5000);
  };
}
connectStream();

async function triggerRun(fresh) {
  var btns = document.querySelectorAll('.run-btn');
  btns.forEach(function(b) { b.disabled = true; });
  event.target.innerHTML = '<span class="spinner"></span> Starting\\u2026';
  try {
    await fetch('/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: '${repo.owner}', repo: '${repo.name}', fresh: !!fresh })
    });
  } catch (e) { console.error(e); }
}

async function reanalyse(btn, campaignId, packageName) {
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Re-analysing\\u2026';
  location.hash = 'pkg-' + packageName;
  try {
    await fetch('/reanalyse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaignId: campaignId, packageName: packageName })
    });
  } catch (e) {
    console.error(e);
    btn.disabled = false;
    btn.textContent = 'Re-analyse';
  }
}

async function applyFix(btn, campaignId, packageName, findingIndex) {
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner spinner-sm"></span> Applying\\u2026';
  try {
    var res = await fetch('/api/apply-fix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaignId: campaignId, packageName: packageName, findingIndex: findingIndex })
    });
    var data = await res.json();
    if (!data.started) {
      btn.textContent = 'Error';
    }
  } catch (e) {
    console.error(e);
    btn.disabled = false;
    btn.textContent = 'Apply fix';
  }
}

function switchRepo(value) {
  window.location.href = '/?repo=' + encodeURIComponent(value);
}

(async function loadRepos() {
  var sel = document.getElementById('repo-select');
  if (!sel) return;
  try {
    var res = await fetch('/api/repos');
    var repos = await res.json();
    var current = sel.value;
    repos.forEach(function(r) {
      var val = r.owner + '/' + r.name;
      if (val === current) return;
      var opt = document.createElement('option');
      opt.value = val;
      opt.textContent = val;
      sel.appendChild(opt);
    });
  } catch (e) { console.error('Failed to load repos:', e); }
})();

function updateCountdown() {
  var el = document.getElementById('countdown');
  if (!el) return;
  var now = new Date();
  var local = new Date(now.toLocaleString('en-US', { timeZone: '${SCHEDULE_TZ}' }));
  var next = new Date(local);
  next.setHours(${SCHEDULE_HOUR}, 0, 0, 0);
  if (next <= local) next.setDate(next.getDate() + 1);
  var diff = next.getTime() - local.getTime();
  var h = Math.floor(diff / 3600000);
  var m = Math.floor((diff % 3600000) / 60000);
  el.textContent = 'in ' + h + 'h ' + m + 'm';
}
updateCountdown();
setInterval(updateCountdown, 60000);

function openFromHash() {
  var hash = location.hash;
  if (!hash || !hash.startsWith('#pkg-')) return;
  var pkg = decodeURIComponent(hash.slice(5));
  var rows = document.querySelectorAll('.bump-row[data-pkg]');
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].getAttribute('data-pkg') === pkg) {
      rows[i].classList.add('open');
      rows[i].nextElementSibling.classList.add('open');
      rows[i].scrollIntoView({ block: 'center', behavior: 'smooth' });
      break;
    }
  }
}
openFromHash();
`;
}

const STYLES = `
:root {
  --ground: #f4f2f7;
  --surface: #ffffff;
  --surface-alt: #f9f7fc;
  --edge: #ddd8e8;
  --edge-strong: #c4bdd4;
  --text: #1a1726;
  --text-dim: #5e5875;
  --text-faint: #8882a0;
  --accent: #7c3aed;
  --accent-dim: rgba(124, 58, 237, 0.06);
  --safe: #059669;
  --safe-bg: rgba(5, 150, 105, 0.07);
  --safe-text: #065f46;
  --risk: #e11d48;
  --risk-bg: rgba(225, 29, 72, 0.06);
  --risk-text: #9f1239;
  --warn: #d97706;
  --warn-bg: rgba(217, 119, 6, 0.07);
  --warn-text: #92400e;
  --pending-bg: rgba(94, 88, 117, 0.06);
  --shadow: 0 1px 3px rgba(26, 23, 38, 0.06), 0 1px 2px rgba(26, 23, 38, 0.04);
  --shadow-md: 0 4px 12px rgba(26, 23, 38, 0.08), 0 1px 3px rgba(26, 23, 38, 0.04);
  --radius: 8px;
  --radius-sm: 5px;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --ground: #0e0d12;
    --surface: #17161c;
    --surface-alt: #131218;
    --edge: #26242e;
    --edge-strong: #37343f;
    --text: #e6e3ee;
    --text-dim: #9490a4;
    --text-faint: #7a7690;
    --accent: #a78bfa;
    --accent-dim: rgba(167, 139, 250, 0.08);
    --safe: #34d399;
    --safe-bg: rgba(52, 211, 153, 0.1);
    --safe-text: #6ee7b7;
    --risk: #fb7185;
    --risk-bg: rgba(251, 113, 133, 0.08);
    --risk-text: #fda4af;
    --warn: #fcd34d;
    --warn-bg: rgba(252, 211, 77, 0.08);
    --warn-text: #fde68a;
    --pending-bg: rgba(102, 98, 122, 0.08);
    --shadow: none;
    --shadow-md: none;
  }
}
:root[data-theme="dark"] {
  --ground: #0e0d12;
  --surface: #17161c;
  --surface-alt: #131218;
  --edge: #26242e;
  --edge-strong: #37343f;
  --text: #e6e3ee;
  --text-dim: #9490a4;
  --text-faint: #7a7690;
  --accent: #a78bfa;
  --accent-dim: rgba(167, 139, 250, 0.08);
  --safe: #34d399;
  --safe-bg: rgba(52, 211, 153, 0.1);
  --safe-text: #6ee7b7;
  --risk: #fb7185;
  --risk-bg: rgba(251, 113, 133, 0.08);
  --risk-text: #fda4af;
  --warn: #fcd34d;
  --warn-bg: rgba(252, 211, 77, 0.08);
  --warn-text: #fde68a;
  --pending-bg: rgba(102, 98, 122, 0.08);
  --shadow: none;
  --shadow-md: none;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: 'Source Sans 3', 'Segoe UI', system-ui, sans-serif;
  background: var(--ground);
  color: var(--text);
  min-height: 100vh;
  -webkit-font-smoothing: antialiased;
}

.topbar { border-bottom: 1px solid var(--edge); background: var(--surface); }
.topbar-inner {
  max-width: 1020px; margin: 0 auto; padding: 0.875rem 1.5rem;
  display: flex; align-items: center; gap: 1rem;
}
.brand { display: flex; align-items: baseline; gap: 0.625rem; flex-shrink: 0; }
.brand-name {
  font-family: 'Manrope', sans-serif; font-weight: 800; font-size: 1.125rem;
  color: var(--text); letter-spacing: -0.02em;
}
.repo-select {
  font-family: 'Source Sans 3', sans-serif; font-size: 0.8125rem; font-weight: 400;
  color: var(--text-dim); background: transparent; border: 1px solid var(--edge);
  border-radius: var(--radius-sm); padding: 0.25rem 0.5rem;
  cursor: pointer; appearance: auto; max-width: 260px;
}
.repo-select:hover { border-color: var(--accent); color: var(--text); }
.repo-select:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
.repo-gh {
  color: var(--text-faint); display: flex; align-items: center;
  transition: color 0.15s; flex-shrink: 0;
}
.repo-gh:hover { color: var(--accent); text-decoration: none; }
.connect-btn {
  display: flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; border-radius: var(--radius-sm);
  border: 1px dashed var(--edge-strong); color: var(--text-faint);
  font-size: 0.875rem; font-weight: 600; text-decoration: none;
  transition: border-color 0.15s, color 0.15s; flex-shrink: 0;
}
.connect-btn:hover { border-color: var(--accent); color: var(--accent); text-decoration: none; }
.topbar-spacer { flex: 1; }

.schedule {
  display: flex; align-items: center; gap: 0.5rem;
  font-size: 0.8125rem; color: var(--text-dim);
  padding: 0.375rem 0.75rem; background: var(--surface-alt);
  border: 1px solid var(--edge); border-radius: var(--radius-sm);
}
.schedule-dot {
  width: 6px; height: 6px; background: var(--safe);
  border-radius: 50%; animation: blink 3s ease-in-out infinite;
}
@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
.schedule-time { font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums; }

.run-btn {
  display: inline-flex; align-items: center; gap: 0.375rem;
  padding: 0.4375rem 1rem; background: var(--accent); color: #fff; border: none;
  border-radius: var(--radius-sm); font-family: 'Source Sans 3', sans-serif;
  font-size: 0.8125rem; font-weight: 600; cursor: pointer;
  transition: opacity 0.15s; letter-spacing: 0.01em;
}
.run-btn:hover { opacity: 0.88; }
.run-btn:disabled { opacity: 0.5; cursor: default; }
.run-btn svg { width: 12px; height: 12px; fill: currentColor; }
.run-btn-secondary { background: var(--bg-card); color: var(--text); border: 1px solid var(--edge); }

.spinner {
  display: inline-block; width: 12px; height: 12px;
  border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff;
  border-radius: 50%; animation: spin 0.6s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

main { max-width: 1020px; margin: 0 auto; padding: 1.75rem 1.5rem 3rem; }

.run-card {
  background: var(--surface); border: 1px solid var(--edge);
  border-radius: var(--radius); box-shadow: var(--shadow-md); overflow: hidden;
}
.run-header {
  display: flex; align-items: center; gap: 0.75rem;
  padding: 0.875rem 1.25rem; border-bottom: 1px solid var(--edge); font-size: 0.8125rem;
}
.run-label {
  font-family: 'Manrope', sans-serif; font-weight: 700; font-size: 0.8125rem;
  text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-dim);
}
.run-time { color: var(--text-dim); }
.run-sep { color: var(--edge-strong); }
.run-status {
  display: inline-flex; align-items: center; gap: 0.3rem;
  padding: 0.2rem 0.5rem; border-radius: 3px;
  font-size: 0.75rem; font-weight: 600; letter-spacing: 0.02em;
}
.run-status.done { background: var(--safe-bg); color: var(--safe); }
.run-status.failed { background: var(--risk-bg); color: var(--risk); }
.run-status.active { background: var(--accent-dim); color: var(--accent); }
.run-status.stuck { background: var(--risk-bg); color: var(--risk); }
.run-status-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.run-duration {
  font-family: 'JetBrains Mono', monospace; font-size: 0.75rem;
  color: var(--text-dim); letter-spacing: 0.02em;
}

.toast {
  display: flex; align-items: center; gap: 0.625rem;
  background: var(--safe-bg); border: 1px solid var(--safe);
  border-radius: var(--radius); padding: 0.625rem 1rem; margin-bottom: 1rem;
  animation: toast-in 0.3s ease-out;
}
.toast-icon { color: var(--safe); font-weight: 700; font-size: 0.875rem; }
.toast-text { flex: 1; font-size: 0.8125rem; color: var(--text); }
.toast-close {
  background: none; border: none; color: var(--text-dim); cursor: pointer;
  font-size: 1rem; padding: 0 0.25rem; line-height: 1;
}
.toast-close:hover { color: var(--text); }
@keyframes toast-in { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }

.run-body { padding: 1.5rem 1.25rem; }

.pipeline { display: flex; align-items: center; padding: 0.5rem 0 1.75rem; }
.step { display: flex; align-items: center; gap: 0.375rem; white-space: nowrap; }
.step-dot {
  width: 9px; height: 9px; border-radius: 50%;
  border: 2px solid var(--edge-strong); background: transparent;
  flex-shrink: 0; transition: all 0.2s;
}
.step-label {
  font-family: 'Source Sans 3', sans-serif; font-size: 0.75rem; font-weight: 600;
  color: var(--text-faint); text-transform: uppercase; letter-spacing: 0.05em;
}
.step.done .step-dot { background: var(--safe); border-color: var(--safe); }
.step.done .step-label { color: var(--safe); }
.step.active .step-dot {
  background: var(--accent); border-color: var(--accent);
  animation: pulse 1.8s ease-in-out infinite;
}
.step.active .step-label { color: var(--accent); }
@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(167, 139, 250, 0.3); }
  50% { box-shadow: 0 0 0 4px rgba(167, 139, 250, 0); }
}
.step-line { flex: 1; height: 2px; background: var(--edge); margin: 0 0.375rem; min-width: 16px; }
.step-line.done { background: var(--safe); }

.stats { display: flex; gap: 1.25rem; margin-bottom: 2rem; }
@media (max-width: 720px) {
  .stats { flex-wrap: wrap; }
  .stat-group { min-width: calc(50% - 0.75rem); }
}
.stat-group { flex: 1; display: flex; flex-direction: column; gap: 0.375rem; }
.stat-group + .stat-group { border-left: 1px solid var(--edge); padding-left: 1.25rem; }
.stat-group-label {
  font-size: 0.5625rem; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.08em; color: var(--text-faint); padding-left: 0.125rem;
}
.stat-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; }
.stat {
  padding: 0.75rem 0.625rem; background: var(--surface-alt);
  border: 1px solid var(--edge); border-radius: var(--radius-sm); text-align: center;
}
.stat-val {
  font-family: 'Manrope', sans-serif; font-size: 1.625rem; font-weight: 700;
  color: var(--text); line-height: 1.1; font-variant-numeric: tabular-nums;
}
.stat-val.safe { color: var(--safe); }
.stat-val.risk { color: var(--risk); }
.stat-lbl {
  font-size: 0.6875rem; font-weight: 600; color: var(--text-faint);
  text-transform: uppercase; letter-spacing: 0.06em; margin-top: 0.25rem;
}

.bumps-header { display: flex; align-items: baseline; gap: 0.5rem; margin-bottom: 0.5rem; }
.bumps-title { font-family: 'Manrope', sans-serif; font-weight: 700; font-size: 0.875rem; color: var(--text); }
.bumps-count { font-size: 0.75rem; color: var(--text-faint); }

.bump-list { border: 1px solid var(--edge); border-radius: var(--radius-sm); overflow-x: auto; }
.bump-cols {
  display: grid; grid-template-columns: 24px 1.8fr 1.2fr 0.5fr 0.7fr 1.1fr 0.9fr;
  gap: 0.5rem; align-items: center; padding: 0 0.875rem; min-width: 640px;
}
.bump-list-head {
  background: var(--surface-alt); border-bottom: 1px solid var(--edge);
  padding-top: 0.5rem; padding-bottom: 0.5rem;
  font-size: 0.6875rem; font-weight: 600; color: var(--text-faint);
  text-transform: uppercase; letter-spacing: 0.06em;
}

.bump-row { border-bottom: 1px solid var(--edge); transition: background 0.1s; position: relative; }
.bump-row:last-of-type { border-bottom: none; }
.bump-row[onclick] { cursor: pointer; }
.bump-row[onclick]:hover { background: var(--accent-dim); }
.bump-row .bump-cols { min-height: 44px; font-size: 0.8125rem; }

.bump-row::before {
  content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
}
.bump-row.v-safe::before { background: var(--safe); }
.bump-row.v-risky::before { background: var(--risk); }
.bump-row.v-unknown::before { background: var(--warn); }
.bump-row.v-pending::before { background: var(--edge); }

.bump-arrow {
  color: var(--text-faint); font-size: 0.75rem; text-align: center;
  transition: transform 0.15s; user-select: none;
}
.bump-row.open .bump-arrow { transform: rotate(90deg); }

.bump-pkg {
  font-family: 'JetBrains Mono', monospace; font-size: 0.8125rem; font-weight: 400;
  color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.bump-ver {
  font-family: 'JetBrains Mono', monospace; font-size: 0.75rem;
  color: var(--text-dim); white-space: nowrap;
}
.bump-alerts { font-variant-numeric: tabular-nums; text-align: center; color: var(--text-dim); font-size: 0.8125rem; }

.verdict {
  display: inline-flex; align-items: center; gap: 0.25rem;
  padding: 0.15rem 0.5rem; border-radius: 3px;
  font-size: 0.6875rem; font-weight: 600; letter-spacing: 0.02em; text-transform: uppercase;
}
.verdict.safe { background: var(--safe-bg); color: var(--safe-text); }
.verdict.risky { background: var(--risk-bg); color: var(--risk-text); }
.verdict.unknown { background: var(--warn-bg); color: var(--warn-text); }
.verdict.pending { background: var(--pending-bg); color: var(--text-faint); }

.pr-link {
  font-size: 0.6875rem; color: var(--accent); text-decoration: none;
  display: inline-flex; align-items: center; justify-content: center; gap: 0.2rem;
  padding: 0.25rem 0.55rem; border: 1px solid var(--edge); border-radius: 3px;
  transition: border-color 0.15s; white-space: nowrap; width: fit-content;
}
.pr-link:hover { border-color: var(--accent); text-decoration: none; }
.pr-link svg { width: 10px; height: 10px; }

.ci { font-size: 0.75rem; font-weight: 600; display: flex; align-items: center; gap: 0.25rem; }
.ci.pass { color: var(--safe); }
.ci.fail { color: var(--risk); }
.ci.wait { color: var(--warn); }
.ci.none { color: var(--text-faint); }

.bump-detail { display: none; border-bottom: 1px solid var(--edge); background: var(--surface-alt); }
.bump-detail.open { display: block; }
.detail-inner { padding: 1rem 1rem 1rem 2.25rem; display: flex; flex-direction: column; gap: 0.875rem; }
.detail-label {
  font-size: 0.6875rem; font-weight: 600; color: var(--text-faint);
  text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 0.375rem;
}
.detail-text { font-size: 0.8125rem; line-height: 1.55; color: var(--text); }

.bc-list { list-style: none; display: flex; flex-direction: column; gap: 0.375rem; font-size: 0.8125rem; }
.bc-list li { display: flex; align-items: baseline; gap: 0.375rem; line-height: 1.4; }
.bc-kind {
  font-size: 0.625rem; font-weight: 600; padding: 0.1rem 0.35rem; border-radius: 2px;
  background: var(--edge); color: var(--text-dim); text-transform: uppercase;
  letter-spacing: 0.03em; flex-shrink: 0; white-space: nowrap;
}
.bc-api { font-family: 'JetBrains Mono', monospace; font-size: 0.75rem; color: var(--accent); }
.bc-desc { color: var(--text-dim); }
.bc-hint { font-size: 0.75rem; color: var(--text-faint); font-style: italic; margin-left: 0.25rem; }

.finding { padding: 0.625rem 0.75rem; border-radius: var(--radius-sm); font-size: 0.8125rem; margin-bottom: 0.375rem; }
.finding:last-child { margin-bottom: 0; }
.finding.affected { background: var(--risk-bg); border-left: 3px solid var(--risk); }
.finding.ok { background: var(--pending-bg); border-left: 3px solid var(--edge); }
.finding-loc { font-family: 'JetBrains Mono', monospace; font-size: 0.75rem; font-weight: 400; margin-bottom: 0.25rem; }
.finding.affected .finding-loc { color: var(--risk); }
.finding.ok .finding-loc { color: var(--text-faint); }
.finding p { line-height: 1.45; }
.fix-row { display: flex; align-items: center; justify-content: space-between; margin-top: 0.5rem; margin-bottom: 0.25rem; }
.fix-label { font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--safe); }
.apply-fix-btn {
  display: inline-flex; align-items: center; gap: 0.25rem;
  padding: 0.25rem 0.625rem; background: var(--safe-bg); color: var(--safe);
  border: 1px solid var(--safe); border-radius: var(--radius-sm);
  font-family: 'Source Sans 3', sans-serif; font-size: 0.6875rem; font-weight: 600;
  cursor: pointer; transition: background 0.15s, opacity 0.15s;
}
.apply-fix-btn:hover { background: var(--safe); color: #fff; }
.apply-fix-btn:disabled { opacity: 0.6; cursor: default; }
.apply-fix-btn.apply-done { background: var(--safe-bg); color: var(--safe); border-color: var(--safe); opacity: 0.8; }
.spinner-sm { width: 10px; height: 10px; border-width: 1.5px; }
.fp-toggle {
  background: none; border: none; cursor: pointer; padding: 0; margin-top: 0.25rem;
  font-family: 'Source Sans 3', sans-serif; font-size: 0.75rem; font-weight: 600;
  color: var(--text-faint); transition: color 0.15s;
}
.fp-toggle:hover { color: var(--accent); }
.fp-group { display: none; margin-top: 0.375rem; }
.fp-group.open { display: block; }
.detail-actions { display: flex; justify-content: flex-end; padding-top: 0.25rem; }
.reanalyse-btn {
  display: inline-flex; align-items: center; gap: 0.25rem;
  padding: 0.3rem 0.75rem; background: transparent; color: var(--accent);
  border: 1px solid var(--edge); border-radius: var(--radius-sm);
  font-family: 'Source Sans 3', sans-serif; font-size: 0.75rem; font-weight: 600;
  cursor: pointer; transition: border-color 0.15s, background 0.15s;
}
.reanalyse-btn:hover { border-color: var(--accent); background: var(--accent-dim); }
.reanalyse-btn:disabled { opacity: 0.5; cursor: default; }
.code-block {
  font-family: 'JetBrains Mono', monospace; font-size: 0.75rem;
  background: var(--surface); border: 1px solid var(--edge); border-radius: 3px;
  padding: 0.5rem 0.75rem; overflow-x: auto; white-space: pre;
  color: var(--text); flex: 1; min-width: 0; margin: 0;
}
.code-diff { display: flex; gap: 0.5rem; align-items: stretch; margin-top: 0.375rem; }
.diff-arrow { display: flex; align-items: center; font-size: 1rem; color: var(--text-faint); flex-shrink: 0; }
.code-before { border-color: var(--risk); border-left: 3px solid var(--risk); }
.code-after { border-color: var(--safe-text); border-left: 3px solid var(--safe-text); }
.code-block .hljs-doctag, .code-block .hljs-keyword, .code-block .hljs-meta .hljs-keyword,
.code-block .hljs-template-tag, .code-block .hljs-template-variable,
.code-block .hljs-type, .code-block .hljs-variable.language_ { color: #d73a49; }
.code-block .hljs-title, .code-block .hljs-title.class_,
.code-block .hljs-title.class_.inherited__, .code-block .hljs-title.function_ { color: #6f42c1; }
.code-block .hljs-attr, .code-block .hljs-attribute, .code-block .hljs-literal,
.code-block .hljs-meta, .code-block .hljs-number, .code-block .hljs-operator,
.code-block .hljs-selector-attr, .code-block .hljs-selector-class,
.code-block .hljs-selector-id, .code-block .hljs-variable { color: #005cc5; }
.code-block .hljs-meta .hljs-string, .code-block .hljs-regexp,
.code-block .hljs-string { color: #032f62; }
.code-block .hljs-built_in, .code-block .hljs-symbol { color: #e36209; }
.code-block .hljs-code, .code-block .hljs-comment, .code-block .hljs-formula { color: #6a737d; }
.code-block .hljs-name, .code-block .hljs-quote,
.code-block .hljs-selector-pseudo, .code-block .hljs-selector-tag { color: #22863a; }
.code-block .hljs-subst { color: #24292e; }
.code-block .hljs-section { color: #005cc5; font-weight: 700; }
.code-block .hljs-emphasis { font-style: italic; }
.code-block .hljs-strong { font-weight: 700; }

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .code-block .hljs-doctag,
  :root:not([data-theme="light"]) .code-block .hljs-keyword,
  :root:not([data-theme="light"]) .code-block .hljs-meta .hljs-keyword,
  :root:not([data-theme="light"]) .code-block .hljs-template-tag,
  :root:not([data-theme="light"]) .code-block .hljs-template-variable,
  :root:not([data-theme="light"]) .code-block .hljs-type,
  :root:not([data-theme="light"]) .code-block .hljs-variable.language_ { color: #ff7b72; }
  :root:not([data-theme="light"]) .code-block .hljs-title,
  :root:not([data-theme="light"]) .code-block .hljs-title.class_,
  :root:not([data-theme="light"]) .code-block .hljs-title.class_.inherited__,
  :root:not([data-theme="light"]) .code-block .hljs-title.function_ { color: #d2a8ff; }
  :root:not([data-theme="light"]) .code-block .hljs-attr,
  :root:not([data-theme="light"]) .code-block .hljs-attribute,
  :root:not([data-theme="light"]) .code-block .hljs-literal,
  :root:not([data-theme="light"]) .code-block .hljs-meta,
  :root:not([data-theme="light"]) .code-block .hljs-number,
  :root:not([data-theme="light"]) .code-block .hljs-operator,
  :root:not([data-theme="light"]) .code-block .hljs-selector-attr,
  :root:not([data-theme="light"]) .code-block .hljs-selector-class,
  :root:not([data-theme="light"]) .code-block .hljs-selector-id,
  :root:not([data-theme="light"]) .code-block .hljs-variable { color: #79c0ff; }
  :root:not([data-theme="light"]) .code-block .hljs-meta .hljs-string,
  :root:not([data-theme="light"]) .code-block .hljs-regexp,
  :root:not([data-theme="light"]) .code-block .hljs-string { color: #a5d6ff; }
  :root:not([data-theme="light"]) .code-block .hljs-built_in,
  :root:not([data-theme="light"]) .code-block .hljs-symbol { color: #ffa657; }
  :root:not([data-theme="light"]) .code-block .hljs-code,
  :root:not([data-theme="light"]) .code-block .hljs-comment,
  :root:not([data-theme="light"]) .code-block .hljs-formula { color: #8b949e; }
  :root:not([data-theme="light"]) .code-block .hljs-name,
  :root:not([data-theme="light"]) .code-block .hljs-quote,
  :root:not([data-theme="light"]) .code-block .hljs-selector-pseudo,
  :root:not([data-theme="light"]) .code-block .hljs-selector-tag { color: #7ee787; }
  :root:not([data-theme="light"]) .code-block .hljs-subst { color: #c9d1d9; }
  :root:not([data-theme="light"]) .code-block .hljs-section { color: #1f6feb; font-weight: 700; }
}
:root[data-theme="dark"] .code-block .hljs-doctag,
:root[data-theme="dark"] .code-block .hljs-keyword,
:root[data-theme="dark"] .code-block .hljs-meta .hljs-keyword,
:root[data-theme="dark"] .code-block .hljs-template-tag,
:root[data-theme="dark"] .code-block .hljs-template-variable,
:root[data-theme="dark"] .code-block .hljs-type,
:root[data-theme="dark"] .code-block .hljs-variable.language_ { color: #ff7b72; }
:root[data-theme="dark"] .code-block .hljs-title,
:root[data-theme="dark"] .code-block .hljs-title.class_,
:root[data-theme="dark"] .code-block .hljs-title.class_.inherited__,
:root[data-theme="dark"] .code-block .hljs-title.function_ { color: #d2a8ff; }
:root[data-theme="dark"] .code-block .hljs-attr,
:root[data-theme="dark"] .code-block .hljs-attribute,
:root[data-theme="dark"] .code-block .hljs-literal,
:root[data-theme="dark"] .code-block .hljs-meta,
:root[data-theme="dark"] .code-block .hljs-number,
:root[data-theme="dark"] .code-block .hljs-operator,
:root[data-theme="dark"] .code-block .hljs-selector-attr,
:root[data-theme="dark"] .code-block .hljs-selector-class,
:root[data-theme="dark"] .code-block .hljs-selector-id,
:root[data-theme="dark"] .code-block .hljs-variable { color: #79c0ff; }
:root[data-theme="dark"] .code-block .hljs-meta .hljs-string,
:root[data-theme="dark"] .code-block .hljs-regexp,
:root[data-theme="dark"] .code-block .hljs-string { color: #a5d6ff; }
:root[data-theme="dark"] .code-block .hljs-built_in,
:root[data-theme="dark"] .code-block .hljs-symbol { color: #ffa657; }
:root[data-theme="dark"] .code-block .hljs-code,
:root[data-theme="dark"] .code-block .hljs-comment,
:root[data-theme="dark"] .code-block .hljs-formula { color: #8b949e; }
:root[data-theme="dark"] .code-block .hljs-name,
:root[data-theme="dark"] .code-block .hljs-quote,
:root[data-theme="dark"] .code-block .hljs-selector-pseudo,
:root[data-theme="dark"] .code-block .hljs-selector-tag { color: #7ee787; }
:root[data-theme="dark"] .code-block .hljs-subst { color: #c9d1d9; }
:root[data-theme="dark"] .code-block .hljs-section { color: #1f6feb; font-weight: 700; }

.history { margin-top: 2.25rem; }
.history-title {
  font-family: 'Manrope', sans-serif; font-weight: 700; font-size: 0.8125rem;
  color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 0.5rem;
}
.history-list {
  border: 1px solid var(--edge); border-radius: var(--radius-sm);
  overflow: hidden; background: var(--surface);
}
.history-row {
  display: grid; grid-template-columns: 2fr 0.8fr 0.5fr 0.8fr 0.7fr 1.2fr; gap: 0.5rem;
  padding: 0.5rem 0.875rem; font-size: 0.8125rem; align-items: center;
  border-bottom: 1px solid var(--edge);
}
.history-row:last-child { border-bottom: none; }
.history-row.head {
  font-size: 0.6875rem; font-weight: 600; color: var(--text-faint);
  text-transform: uppercase; letter-spacing: 0.06em; background: var(--surface-alt);
}
.history-repo { color: var(--text-dim); }
.history-status {
  display: inline-flex; align-items: center; gap: 0.25rem;
  padding: 0.15rem 0.5rem; border-radius: 3px;
  font-size: 0.625rem; font-weight: 600; letter-spacing: 0.02em; text-transform: uppercase;
  background: var(--accent-dim); color: var(--accent);
}
.history-status.failed { background: var(--risk-bg); color: var(--risk); }
.history-stats { font-family: 'JetBrains Mono', monospace; font-size: 0.75rem; }
.mini-safe { color: var(--safe); }
.mini-risky { color: var(--risk); }
.mini-prs { color: var(--accent); }
.mini-sep { color: var(--text-faint); margin: 0 0.125rem; }

.empty { text-align: center; padding: 4rem 1.5rem; }
.empty-icon {
  width: 48px; height: 48px; margin: 0 auto 1rem; border-radius: 50%;
  background: var(--accent-dim); display: flex; align-items: center; justify-content: center;
  color: var(--accent); font-size: 1.25rem;
}
.empty h2 { font-family: 'Manrope', sans-serif; font-weight: 700; font-size: 1rem; margin-bottom: 0.375rem; }
.empty p { font-size: 0.875rem; color: var(--text-dim); max-width: 380px; margin: 0 auto; line-height: 1.5; }
.empty-connect { color: var(--accent); font-weight: 600; }

a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
`;
