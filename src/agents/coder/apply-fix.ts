import { z } from 'genkit';
import { ai } from '../../genkit.js';
import { coderAgent } from './agent.js';
import { getCampaign, updateCampaign, updateFinding, updateBumps } from '../../tools/firestore/client.js';

export const applyFixFlow = ai.defineFlow(
  {
    name: 'applyFixFlow',
    inputSchema: z.object({
      campaignId: z.string(),
      packageName: z.string(),
      findingIndices: z.array(z.number()),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      message: z.string(),
      applied: z.number(),
      total: z.number(),
    }),
  },
  async ({ campaignId, packageName, findingIndices }) => {
    const campaign = await getCampaign(campaignId);
    if (!campaign) return { success: false, message: 'Campaign not found', applied: 0, total: 0 };

    const bump = campaign.plan.find((b) => b.packageName === packageName);
    if (!bump) return { success: false, message: 'Package not in campaign', applied: 0, total: 0 };
    if (!bump.prNumber) return { success: false, message: 'No PR exists for this package', applied: 0, total: 0 };

    const targets = findingIndices
      .map((i) => ({ index: i, finding: bump.findings?.[i] }))
      .filter((t) => t.finding?.isAffected);

    if (targets.length === 0) return { success: false, message: 'No applicable findings', applied: 0, total: 0 };

    const { repoOwner: owner, repoName: repo } = campaign;
    const branchName = `depbot-triage/${bump.packageName}-${bump.targetVersion}`;

    const findingDescriptions = targets.map(({ finding }, i) => {
      const f = finding!;
      let desc = `### Fix ${i + 1}: ${f.file}:${f.line}\n**Analysis:** ${f.analysis}`;
      if (f.fixKind === 'remove') {
        desc += `\n**Action:** Remove the code entirely.\n\`\`\`\n${f.originalCode}\n\`\`\``;
      } else if (f.suggestedFix) {
        desc += `\n**Suggested fix:**\n\`\`\`\n${f.suggestedFix}\n\`\`\``;
      } else {
        desc += '\nNo suggested fix — use your judgment based on the analysis.';
      }
      return desc;
    }).join('\n\n');

    const prompt = `Apply ${targets.length} fix${targets.length > 1 ? 'es' : ''} to **${owner}/${repo}** on branch **${branchName}**.

**Package upgrade:** ${bump.packageName} ${bump.currentVersion} → ${bump.targetVersion}

${findingDescriptions}

Read each affected file, apply all fixes, then commit. You can make multiple commitFix calls if needed (one per file, or group related changes). Use owner="${owner}", repo="${repo}", branch="${branchName}".`;

    for (const { index } of targets) {
      await updateFinding(campaignId, packageName, index, { fixStatus: 'coding' });
    }

    let appliedCount = 0;
    let message = '';
    try {
      const chat = coderAgent.chat();
      const response = await chat.send(prompt);
      message = response.text;

      const commitCount = response.messages.filter((m) =>
        m.role === 'tool' &&
        m.content.some(
          (p) =>
            p.toolResponse?.name === 'commitFix' &&
            (p.toolResponse.output as { success?: boolean })?.success === true,
        ),
      ).length;

      appliedCount = commitCount > 0 ? targets.length : 0;
    } catch (err) {
      message = `Agent error: ${err instanceof Error ? err.message : err}`;
    }

    if (appliedCount > 0) {
      for (const { index, finding } of targets) {
        await updateFinding(campaignId, packageName, index, {
          fixStatus: 'applied',
          analysis: `[Fixed] ${finding!.analysis}`,
          suggestedFix: undefined,
        });
      }
      await updateBumps(campaignId, [{
        packageName,
        fields: { ciStatus: 'pending', fixAttempts: (bump.fixAttempts ?? 0) + 1 },
      }]);
      const latest = await getCampaign(campaignId);
      if (latest && latest.status === 'done') {
        await updateCampaign(campaignId, { status: 'iterating' });
      }
    } else {
      for (const { index } of targets) {
        await updateFinding(campaignId, packageName, index, {
          fixStatus: undefined,
        });
      }
    }

    return { success: appliedCount > 0, message, applied: appliedCount, total: targets.length };
  },
);
