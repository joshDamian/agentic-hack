import { z } from 'genkit';
import { ai } from '../../genkit.js';
import { coderAgent } from './agent.js';
import { getCampaign, updateFinding } from '../../tools/firestore/client.js';

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

    await updateFinding(campaignId, packageName, findingIndex, { fixStatus: 'coding' });

    let applied = false;
    let message = '';
    try {
      const chat = coderAgent.chat();
      const response = await chat.send(prompt);
      message = response.text;

      applied = response.messages.some((m) =>
        m.role === 'tool' &&
        m.content.some(
          (p) =>
            p.toolResponse?.name === 'commitFix' &&
            (p.toolResponse.output as { success?: boolean })?.success === true,
        ),
      );
    } catch (err) {
      message = `Agent error: ${err instanceof Error ? err.message : err}`;
    }

    if (applied) {
      await updateFinding(campaignId, packageName, findingIndex, {
        fixStatus: 'applied',
        analysis: `[Fixed] ${finding.analysis}`,
        suggestedFix: undefined,
      });
    } else {
      await updateFinding(campaignId, packageName, findingIndex, {
        fixStatus: undefined,
      });
    }

    return { success: applied, message };
  },
);
