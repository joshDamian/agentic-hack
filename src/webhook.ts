import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from './shared/config.js';
import { listCampaigns, updateCampaign } from './tools/firestore/client.js';
import { getPRCIStatus, commentOnPR, getCIFailureLogs } from './tools/github/ci.js';
import { reanalyseWithCIErrors } from './agents/safety/index.js';
import type { Campaign } from './shared/types.js';

export async function webhookHandler(req: Request, res: Response): Promise<void> {
  const event = req.headers['x-github-event'] as string;
  console.log(`Webhook received: ${event} / ${req.body?.action ?? 'no action'}`);

  if (!verifySignature(req)) {
    res.status(401).send('Invalid signature');
    return;
  }

  const event = req.headers['x-github-event'] as string;
  if (event !== 'check_suite' && event !== 'check_run') {
    res.status(200).send('Ignored');
    return;
  }

  const payload = req.body;
  if (payload.action !== 'completed') {
    res.status(200).send('Ignored');
    return;
  }

  const repo = payload.repository;
  const owner = repo.owner.login as string;
  const repoName = repo.name as string;

  const branches: string[] = event === 'check_suite'
    ? (payload.check_suite.pull_requests ?? []).map((pr: any) => pr.head.ref as string)
    : (payload.check_run.pull_requests ?? []).map((pr: any) => pr.head.ref as string);

  if (branches.length === 0) {
    res.status(200).send('No PR branches');
    return;
  }

  res.status(200).send('Processing');

  // Fire and forget — don't block the webhook response
  handleCICompletion(owner, repoName, branches).catch((err) =>
    console.error('Webhook handler error:', err),
  );
}

async function handleCICompletion(owner: string, repoName: string, branches: string[]): Promise<void> {
  const campaigns = await listCampaigns();
  const active = campaigns.find(
    (c) => c.repoOwner === owner && c.repoName === repoName && c.status === 'monitoring',
  );
  if (!active) return;

  const matchedBumps = active.plan.filter((b) => {
    const branchName = `depbot-triage/${b.packageName}-${b.targetVersion}`;
    return branches.includes(branchName) && b.prNumber && b.ciStatus === 'pending';
  });

  if (matchedBumps.length === 0) return;

  for (const bump of matchedBumps) {
    console.log(`  Webhook: CI completed for ${bump.packageName}, checking status...`);
    const { status, details } = await getPRCIStatus(owner, repoName, bump.prNumber!);
    bump.ciStatus = status;

    if (status === 'success' && bump.verdict === 'safe') {
      await commentOnPR(owner, repoName, bump.prNumber!,
        '✅ **CI passed** and safety analysis says this bump is safe.\n\n**Ready to merge.**');
    }

    if (status === 'failure') {
      console.log(`  Webhook: CI failed for ${bump.packageName}, pulling logs...`);
      const ciErrors = await getCIFailureLogs(owner, repoName, bump.prNumber!);
      if (ciErrors) {
        console.log(`  Webhook: Re-analysing ${bump.packageName} with CI errors...`);
        const result = await reanalyseWithCIErrors(owner, repoName, bump, ciErrors);
        bump.verdict = result.verdict;
        bump.verdictReason = result.reason;
        bump.findings = result.findings;
        await commentOnPR(owner, repoName, bump.prNumber!,
          `❌ **CI failed.** Re-analysed with CI errors — verdict updated to **${result.verdict}**.\n\nDetails: ${details}`);
      } else {
        await commentOnPR(owner, repoName, bump.prNumber!,
          `❌ **CI failed.** Details: ${details}\n\nThis bump may need manual investigation.`);
      }
    }
  }

  await updateCampaign(active.id, { plan: active.plan });

  const allResolved = active.plan.every(
    (b) => !b.prNumber || /^(success|failure|no-checks)$/.test(b.ciStatus ?? ''),
  );
  if (allResolved) {
    console.log(`  Webhook: All CI resolved for campaign ${active.id}, marking done.`);
    await updateCampaign(active.id, { status: 'done', completedAt: new Date().toISOString() });
  }
}

function verifySignature(req: Request): boolean {
  if (!config.githubWebhookSecret) return true;
  const sig = req.headers['x-hub-signature-256'] as string | undefined;
  if (!sig) return false;
  const hmac = crypto.createHmac('sha256', config.githubWebhookSecret);
  hmac.update(JSON.stringify(req.body));
  const expected = `sha256=${hmac.digest('hex')}`;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}
