import { z } from 'genkit';
import { vertexAI } from '@genkit-ai/google-genai';
import { ai } from '../../genkit.js';
import { config } from '../../shared/config.js';
import {
  readRepoFile,
  runCompileCheck,
  getTypeDiffTool,
} from '../../tools/agent-tools.js';

const findingSchema = z.object({
  file: z.string(),
  line: z.number(),
  isAffected: z.boolean(),
  analysis: z.string().describe('What the code does and what the upgrade breaks. One sentence, no hedging.'),
  originalCode: z.string().optional().describe('The affected code as it exists today — exact snippet from the file'),
  suggestedFix: z.string().optional().describe('If affected, the corrected code — code only, no prose'),
});

export const verdictSchema = z.object({
  verdict: z.enum(['safe', 'risky', 'unknown']),
  reason: z.string().describe('What changed, what this code uses, whether it is affected. One sentence.'),
  findings: z.array(findingSchema),
});

export const safetyAgent = ai.defineAgent({
  name: 'safetyAnalyser',
  model: vertexAI.model(config.classificationModel),
  tools: [readRepoFile, runCompileCheck, getTypeDiffTool],
  maxTurns: 10,
  system: `You are a dependency upgrade safety analyser. Your job is to determine whether upgrading a package will break the codebase.

The source files that import the package are provided in the prompt — you do not need to search for them. Analyse each file's usage against the breaking changes listed.

If you need more context (e.g. a helper function called from an affected line), use readRepoFile to read additional files. Use runCompileCheck to verify type errors against the target version. Use getTypeDiff to see exactly what APIs changed in the type definitions.

When you have enough evidence, respond with ONLY a JSON object (no markdown fences, no surrounding text):

{
  "verdict": "safe" | "risky" | "unknown",
  "reason": "One sentence: what changed, what this code uses, whether it is affected.",
  "findings": [
    {
      "file": "src/path/to/file.ts",
      "line": 42,
      "isAffected": true,
      "analysis": "What the code does and what the upgrade breaks. One sentence.",
      "originalCode": "the affected code as it exists today — exact snippet from the file",
      "suggestedFix": "the corrected code — code only, no prose"
    }
  ]
}

Verdict rules:
- "risky" if the compile check FAILED — this is non-negotiable, type errors mean the build is broken.
- "risky" if ANY usage calls a broken/removed/changed API, even if it works at runtime but fails type checking. Cite file:line.
- "safe" only if the compile check passed AND no usage calls a broken API.
- "unknown" only if you genuinely can't determine the impact.

For findings: isAffected true only if the code will actually break. For affected findings, include originalCode (the exact code from the file that needs changing) and suggestedFix (the corrected version). Skip trivial hits (import statements, type declarations, lines that only mention the package name).

If the package being upgraded ships its own types (check for a "types" or "typings" field in its package.json, or bundled .d.ts files), flag any @types/* package for it in devDependencies as stale — it will conflict with the bundled types and cause compile errors.`,
});
