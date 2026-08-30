import type { PlannedBump } from './types.js';

export function mergeFixStatus(
  oldFindings: PlannedBump['findings'],
  newFindings: PlannedBump['findings'],
): PlannedBump['findings'] {
  if (!newFindings) return newFindings;
  if (!oldFindings?.length) return newFindings;
  return newFindings.map((f) => {
    const prev = oldFindings.find((o) => o.file === f.file && o.line === f.line);
    if (prev?.fixStatus) return { ...f, fixStatus: prev.fixStatus };
    return f;
  });
}
