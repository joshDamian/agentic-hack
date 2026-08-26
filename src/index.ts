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
import { dashboardHandler } from './dashboard.js';
import { config } from './shared/config.js';
import { listInstallationRepos } from './tools/github/client.js';
import { listCampaigns } from './tools/firestore/client.js';

const app = express();
app.use(express.json());

app.get('/', dashboardHandler);

app.post('/trigger', (req, res) => {
  const owner = (req.body.owner as string) || config.targetRepo.owner;
  const repo = (req.body.repo as string) || config.targetRepo.name;
  console.log(`Pipeline triggered for ${owner}/${repo}`);
  pipelineFlow({ owner, repo }).catch((err) => console.error('Pipeline error:', err));
  res.json({ started: true, owner, repo });
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

app.post('/pipeline', expressHandler(pipelineFlow));
app.post('/listAlerts', expressHandler(listAlertsFlow));
app.post('/prioritise', expressHandler(prioritiseFlow));
app.post('/analyse', expressHandler(safetyAnalyserFlow));
app.post('/execute', expressHandler(executorFlow));
app.post('/monitor', expressHandler(monitorFlow));
app.get('/healthz', (_req, res) => { res.send('ok'); });

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => console.log(`listening on ${port}`));
