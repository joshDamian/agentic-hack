import { z } from 'genkit';
import { ai } from '../../genkit.js';
import { coderAgent } from './agent.js';
import { getCampaign, updateCampaign, updateFinding, updateBumps } from '../../tools/firestore/client.js';
import { getFileContent } from '../../tools/github/client.js';

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
    let commitCount = 0;
    let message = '';
    try {
      const chat = coderAgent.chat();
      const response = await chat.send(prompt);
      message = response.text;

      commitCount = response.messages.filter((m) =>
        m.role === 'tool' &&
        m.content.some(
          (p) =>
            p.toolResponse?.name === 'commitFix' &&
            (p.toolResponse.output as { success?: boolean })?.success === true,
        ),
      ).length;
    } catch (err) {
      message = `Agent error: ${err instanceof Error ? err.message : err}`;
    }

    if (commitCount > 0) {
      for (const { index, finding } of targets) {
        const f = finding!;
        let verified = false;
        if (f.originalCode) {
          try {
            const content = await getFileContent(owner, repo, f.file, branchName);
            verified = !content.includes(f.originalCode);
          } catch {
            verified = true;
          }
        } else {
          verified = true;
        }
        if (verified) {
          appliedCount++;
          await updateFinding(campaignId, packageName, index, {
            fixStatus: 'applied',
            analysis: `[Fixed] ${f.analysis}`,
            suggestedFix: undefined,
          });
        } else {
          await updateFinding(campaignId, packageName, index, { fixStatus: undefined });
        }
      }
    } else {
      for (const { index } of targets) {
        await updateFinding(campaignId, packageName, index, { fixStatus: undefined });
      }
    }

    if (appliedCount > 0) {
      await updateBumps(campaignId, [{
        packageName,
        fields: { ciStatus: 'pending', fixAttempts: (bump.fixAttempts ?? 0) + 1 },
      }]);
      const latest = await getCampaign(campaignId);
      if (latest && latest.status === 'done') {
        await updateCampaign(campaignId, { status: 'iterating' });
      }
    }

    return { success: appliedCount > 0, message, applied: appliedCount, total: targets.length };
  },
);
