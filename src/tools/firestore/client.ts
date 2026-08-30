import { Firestore } from '@google-cloud/firestore';
import { config } from '../../shared/config.js';
import type { Campaign } from '../../shared/types.js';

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
  updates: Array<{ packageName: string; fields: Partial<Campaign['plan'][number]> }>,
): Promise<Campaign | null> {
  const ref = campaigns.doc(campaignId);
  return db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (!doc.exists) return null;
    const campaign = doc.data() as Campaign;
    for (const { packageName, fields } of updates) {
      const bump = campaign.plan.find((b) => b.packageName === packageName);
      if (!bump) continue;
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined) (bump as any)[k] = v;
      }
    }
    tx.update(ref, { plan: campaign.plan, updatedAt: new Date().toISOString() });
    return campaign;
  });
}

export { db };
