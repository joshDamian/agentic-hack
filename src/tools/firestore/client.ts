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

export { db };
