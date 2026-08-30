import { z } from 'genkit';
import { ai } from '../../genkit.js';
import { coderAgent } from './agent.js';
import { getCampaign, updateCampaign } from '../../tools/firestore/client.js';

export const applyFixFlow = ai.defineFlow(
  {
    name: 'applyFixFlow',
    inputSchema: z.object({
      campaignId: z.string(),
      packageName: z.string(),
      findingIndex: z.number(),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      message: z.string(),
    }),
  },
  async ({ campaignId, packageName, findingIndex }) => {
    const campaign = await getCampaign(campaignId);
    if (!campaign) return { success: false, message: 'Campaign not found' };

    const bump = campaign.plan.find((b) => b.packageName === packageName);
    if (!bump) return { success: false, message: 'Package not in campaign' };
    if (!bump.prNumber) return { success: false, message: 'No PR exists for this package' };

    const finding = bump.findings?.[findingIndex];
    if (!finding) return { success: false, message: 'Finding not found' };
    if (!finding.isAffected) return { success: false, message: 'Finding is not affected' };

    const { repoOwner: owner, repoName: repo } = campaign;
    const branchName = `depbot-triage/${bump.packageName}-${bump.targetVersion}`;

    const prompt = `Apply a fix to the repository **${owner}/${repo}** on branch **${branchName}**.

**Package upgrade:** ${bump.packageName} ${bump.currentVersion} → ${bump.targetVersion}

**Affected file:** ${finding.file} at line ${finding.line}
**Analysis:** ${finding.analysis}
${finding.suggestedFix ? `**Suggested fix:**\n\`\`\`\n${finding.suggestedFix}\n\`\`\`` : 'No suggested fix available — use your judgment based on the analysis.'}

Read the file first, understand the context around line ${finding.line}, then apply the fix using commitFix.
Use owner="${owner}", repo="${repo}", branch="${branchName}".`;

    const chat = coderAgent.chat();
    const response = await chat.send(prompt);

    const applied = response.text.toLowerCase().includes('commit') &&
      !response.text.toLowerCase().includes('could not') &&
      !response.text.toLowerCase().includes('failed');

    if (applied && finding.suggestedFix) {
      finding.suggestedFix = undefined;
      finding.analysis = `[Fixed] ${finding.analysis}`;
      await updateCampaign(campaignId, { plan: campaign.plan });
    }

    return { success: applied, message: response.text };
  },
);
