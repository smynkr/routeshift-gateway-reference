// A deliberately small line diff for the confirm prompt. Callers MUST redact
// secrets out of both inputs before passing them here — this module does no
// masking of its own.

export function renderDiff(before: string, after: string): string {
  const beforeLines = before ? before.replace(/\n$/, '').split('\n') : [];
  const afterLines = after ? after.replace(/\n$/, '').split('\n') : [];

  if (beforeLines.length === 0) {
    return afterLines.map((l) => `+ ${l}`).join('\n');
  }
  if (afterLines.length === 0) {
    return beforeLines.map((l) => `- ${l}`).join('\n');
  }

  // Drop a common prefix/suffix of unchanged lines so the diff stays focused.
  let start = 0;
  while (start < beforeLines.length && start < afterLines.length && beforeLines[start] === afterLines[start]) {
    start++;
  }
  let endB = beforeLines.length - 1;
  let endA = afterLines.length - 1;
  while (endB >= start && endA >= start && beforeLines[endB] === afterLines[endA]) {
    endB--;
    endA--;
  }

  const out: string[] = [];
  for (let i = 0; i < start; i++) out.push(`  ${beforeLines[i]}`);
  for (let i = start; i <= endB; i++) out.push(`- ${beforeLines[i]}`);
  for (let i = start; i <= endA; i++) out.push(`+ ${afterLines[i]}`);
  for (let i = endB + 1; i < beforeLines.length; i++) out.push(`  ${beforeLines[i]}`);
  return out.join('\n');
}
