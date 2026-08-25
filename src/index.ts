import 'dotenv/config';
import express from 'express';
import { expressHandler } from '@genkit-ai/express';
import { listAlertsFlow } from './agents/prioritiser/list-alerts.js';
import { prioritiseFlow } from './agents/prioritiser/index.js';
import { safetyAnalyserFlow } from './agents/safety/index.js';
import { executorFlow } from './agents/executor/index.js';
import { monitorFlow } from './agents/monitor/index.js';

const app = express();
app.use(express.json());
app.post('/listAlerts', expressHandler(listAlertsFlow));
app.post('/prioritise', expressHandler(prioritiseFlow));
app.post('/analyse', expressHandler(safetyAnalyserFlow));
app.post('/execute', expressHandler(executorFlow));
app.post('/monitor', expressHandler(monitorFlow));
app.get('/healthz', (_req, res) => { res.send('ok'); });

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => console.log(`listening on ${port}`));
