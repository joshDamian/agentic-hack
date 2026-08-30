import { Firestore } from '@google-cloud/firestore';
import { config } from '../../shared/config.js';
import type { BumpVerdict, Campaign, PlannedBump } from '../../shared/types.js';
import { mergeFixStatus } from '../../shared/findings.js';

const db = new Firestore({
  projectId: config.gcpProject,
  databaseId: '(default)',
});

const campaigns = db.collection('campaigns');

export async function createCampaign(campaign: Campaign): Promise<void> {
  await campaigns.doc(campaign.id).set(campaign);
}

export async function getCampaign(id: string): Promise<Campaign | null> {
  const doc = await campaigns.doc(id).get();
  return doc.exists ? (doc.data() as Campaign) : null;
}

export async function updateCampaign(
  id: string,
  fields: Partial<Campaign>,
): Promise<void> {
  await campaigns.doc(id).update({
    ...fields,
    updatedAt: new Date().toISOString(),
  });
}

export async function listCampaigns(): Promise<Campaign[]> {
  const snapshot = await campaigns.orderBy('createdAt', 'desc').get();
  return snapshot.docs.map((d) => d.data() as Campaign);
}

export async function findStuckCampaign(owner: string, repo: string): Promise<Campaign | null> {
  const all = await listCampaigns();
  const match = all.find((c) => c.repoOwner === owner && c.repoName === repo);
  if (!match || ['done', 'failed'].includes(match.status)) return null;
  return match;
}

export function subscribeCampaigns(
  onUpdate: (campaigns: Campaign[]) => void,
): () => void {
  return campaigns.orderBy('createdAt', 'desc').onSnapshot(
    (snapshot) => {
      onUpdate(snapshot.docs.map((d) => d.data() as Campaign));
    },
    (err) => {
      console.error('Firestore snapshot error:', err);
    },
  );
}

export async function updateBumps(
  campaignId: string,
  updates: Array<{
    packageName: string;
    fields: Partial<PlannedBump>;
    mergeNewFindings?: boolean;
  }>,
): Promise<Campaign | null> {
  const ref = campaigns.doc(campaignId);
  return db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (!doc.exists) return null;
    const campaign = doc.data() as Campaign;
    for (const { packageName, fields, mergeNewFindings } of updates) {
      const bump = campaign.plan.find((b) => b.packageName === packageName);
      if (!bump) continue;
      if (mergeNewFindings && fields.findings) {
        fields.findings = mergeFixStatus(bump.findings, fields.findings) ?? fields.findings;
      }
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined) (bump as any)[k] = v;
      }
    }
    tx.update(ref, { plan: campaign.plan, updatedAt: new Date().toISOString() });
    return campaign;
  });
}

const REANALYSING_TIMEOUT = 10 * 60_000;

/**
 * Lease acquire: atomically set verdict to 'reanalysing' if no other actor owns the bump.
 * Returns the previous verdict on success, null if blocked.
 */
export async function setReanalysing(
  campaignId: string,
  packageName: string,
): Promise<BumpVerdict | null> {
  const ref = campaigns.doc(campaignId);
  return db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (!doc.exists) return null;
    const campaign = doc.data() as Campaign;
    const bump = campaign.plan.find((b) => b.packageName === packageName);
    if (!bump) return null;
    if (bump.findings?.some((f) => f.fixStatus === 'coding')) return null;
    if (bump.verdict === 'reanalysing') {
      const stale = bump.reanalysingAt && Date.now() - new Date(bump.reanalysingAt).getTime() > REANALYSING_TIMEOUT;
      if (!stale) return null;
    }
    const prev = bump.verdict ?? 'unknown';
    bump.verdict = 'reanalysing';
    bump.reanalysingAt = new Date().toISOString();
    tx.update(ref, { plan: campaign.plan, updatedAt: new Date().toISOString() });
    return prev;
  });
}

/**
 * Lease release: restore verdict only if the bump is still 'reanalysing'.
 */
export async function clearReanalysing(
  campaignId: string,
  packageName: string,
  fallbackVerdict: BumpVerdict,
): Promise<void> {
  const ref = campaigns.doc(campaignId);
  await db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (!doc.exists) return;
    const campaign = doc.data() as Campaign;
    const bump = campaign.plan.find((b) => b.packageName === packageName);
    if (!bump || bump.verdict !== 'reanalysing') return;
    bump.verdict = fallbackVerdict;
    bump.reanalysingAt = undefined;
    tx.update(ref, { plan: campaign.plan, updatedAt: new Date().toISOString() });
  });
}

export async function updateFinding(
  campaignId: string,
  packageName: string,
  findingIndex: number,
  fields: Partial<NonNullable<Campaign['plan'][number]['findings']>[number]>,
): Promise<void> {
  const ref = campaigns.doc(campaignId);
  await db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (!doc.exists) return;
    const campaign = doc.data() as Campaign;
    const bump = campaign.plan.find((b) => b.packageName === packageName);
    const finding = bump?.findings?.[findingIndex];
    if (!finding) return;
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) (finding as any)[k] = v;
      else delete (finding as any)[k];
    }
    tx.update(ref, { plan: campaign.plan, updatedAt: new Date().toISOString() });
  });
}

export { db };
