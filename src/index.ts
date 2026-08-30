import 'dotenv/config';
import express from 'express';
import { expressHandler } from '@genkit-ai/express';
import { listAlertsFlow } from './agents/prioritiser/list-alerts.js';
import { prioritiseFlow } from './agents/prioritiser/index.js';
import { safetyAnalyserFlow } from './agents/safety/index.js';
import { executorFlow } from './agents/executor/index.js';
import { monitorFlow } from './agents/monitor/index.js';
import { pipelineFlow } from './pipeline.js';
import { reanalyseFlow } from './reanalyse.js';
import { applyFixFlow } from './agents/coder/apply-fix.js';
import { dashboardHandler, dashboardPartialHandler } from './dashboard.js';
import { webhookHandler } from './webhook.js';
import { config } from './shared/config.js';
import { listInstallationRepos } from './tools/github/client.js';
import { listCampaigns, getCampaign, subscribeCampaigns } from './tools/firestore/client.js';

const app = express();
app.use(express.json());

app.get('/', dashboardHandler);

app.post('/trigger', (req, res) => {
  const owner = (req.body.owner as string) || config.targetRepo.owner;
  const repo = (req.body.repo as string) || config.targetRepo.name;
  const fresh = req.body.fresh === true;
  console.log(`Pipeline triggered for ${owner}/${repo}${fresh ? ' (fresh)' : ''}`);
  pipelineFlow({ owner, repo, fresh }).catch((err) => console.error('Pipeline error:', err));
  res.json({ started: true, owner, repo, fresh });
});

app.post('/reanalyse', (req, res) => {
  const { campaignId, packageName } = req.body as { campaignId: string; packageName: string };
  if (!campaignId || !packageName) {
    res.status(400).json({ error: 'campaignId and packageName are required' });
    return;
  }
  console.log(`Re-analysis triggered for ${packageName} in campaign ${campaignId}`);
  reanalyseFlow({ campaignId, packageName }).catch((err) => console.error('Re-analysis error:', err));
  res.json({ started: true, campaignId, packageName });
});

app.get('/api/partial', dashboardPartialHandler);

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(':\n\n');

  const unsubscribe = subscribeCampaigns((campaigns) => {
    const repoParam = req.query.repo as string | undefined;
    const match = repoParam
      ? campaigns.find((c) => `${c.repoOwner}/${c.repoName}` === repoParam)
      : campaigns[0];
    const summary = match
      ? { status: match.status, updatedAt: match.updatedAt, id: match.id }
      : null;
    res.write(`data: ${JSON.stringify(summary)}\n\n`);
  });

  req.on('close', () => unsubscribe());
});

app.get('/api/repos', async (_req, res) => {
  try {
    const repos = await listInstallationRepos();
    res.json(repos);
  } catch (err) {
    console.error('Failed to list repos:', err);
    res.status(500).json({ error: 'Failed to list repos' });
  }
});

app.get('/api/status', async (req, res) => {
  const repoParam = req.query.repo as string | undefined;
  const campaigns = await listCampaigns();
  const match = repoParam
    ? campaigns.find((c) => `${c.repoOwner}/${c.repoName}` === repoParam)
    : campaigns[0];
  const active = !!match && !['done', 'failed'].includes(match.status);
  res.json({ active, status: match?.status ?? null });
});

app.get('/api/bump', async (req, res) => {
  const { campaignId, package: pkg } = req.query as { campaignId?: string; package?: string };
  if (!campaignId || !pkg) {
    res.status(400).json({ error: 'campaignId and package are required' });
    return;
  }
  const campaign = await getCampaign(campaignId);
  if (!campaign) { res.status(404).json({ error: 'Campaign not found' }); return; }
  const bump = campaign.plan.find((b) => b.packageName === pkg);
  if (!bump) { res.status(404).json({ error: 'Package not in campaign' }); return; }
  res.json({ verdict: bump.verdict ?? null, updatedAt: campaign.updatedAt });
});

app.post('/api/apply-fix', (req, res) => {
  const { campaignId, packageName, findingIndex } = req.body as {
    campaignId: string; packageName: string; findingIndex: number;
  };
  if (!campaignId || !packageName || findingIndex === undefined) {
    res.status(400).json({ error: 'campaignId, packageName, and findingIndex are required' });
    return;
  }
  console.log(`Apply fix triggered: ${packageName} finding #${findingIndex}`);
  applyFixFlow({ campaignId, packageName, findingIndex })
    .then((result) => console.log(`Apply fix result: ${result.message}`))
    .catch((err) => console.error('Apply fix error:', err));
  res.json({ started: true, campaignId, packageName, findingIndex });
});

app.post('/pipeline', expressHandler(pipelineFlow));
app.post('/listAlerts', expressHandler(listAlertsFlow));
app.post('/prioritise', expressHandler(prioritiseFlow));
app.post('/analyse', expressHandler(safetyAnalyserFlow));
app.post('/execute', expressHandler(executorFlow));
app.post('/monitor', expressHandler(monitorFlow));
app.post('/webhook', webhookHandler);
app.get('/healthz', (_req, res) => { res.send('ok'); });

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => console.log(`listening on ${port}`));
