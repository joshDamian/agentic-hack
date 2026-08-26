export function dedent(text: string): string {
  const lines = text.split('\n');
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 0) return text;
  const indent = Math.min(...nonEmpty.map((l) => l.match(/^(\s*)/)?.[1].length ?? 0));
  if (indent === 0) return text;
  return lines.map((l) => l.slice(indent)).join('\n');
}
