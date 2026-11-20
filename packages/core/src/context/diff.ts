export interface DiffLine {
  type: 'context' | 'added' | 'removed';
  text: string;
}

export interface DocumentDiffResult {
  fromVersion: number;
  toVersion: number;
  addedCount: number;
  removedCount: number;
  lines: DiffLine[];
}

/**
 * Lightweight deterministic line-level LCS diff for solidified document
 * version comparisons (e.g. v1 <-> v2).
 */
export function computeLineDiff(
  fromText: string,
  toText: string,
  fromVersion: number,
  toVersion: number,
): DocumentDiffResult {
  const a = fromText.replace(/\r\n/gu, '\n').split('\n');
  const b = toText.replace(/\r\n/gu, '\n').split('\n');

  const n = a.length;
  const m = b.length;

  // Guard pathological huge files with a bounded fallback
  if (n * m > 400_000) {
    const lines: DiffLine[] = [
      ...a.map((text): DiffLine => ({ type: 'removed', text })),
      ...b.map((text): DiffLine => ({ type: 'added', text })),
    ];
    return {
      fromVersion,
      toVersion,
      addedCount: b.length,
      removedCount: a.length,
      lines,
    };
  }

  const dp: Uint32Array[] = Array.from(
    { length: n + 1 },
    () => new Uint32Array(m + 1),
  );
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = dp[i]!;
    const nextRow = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j -= 1) {
      if (a[i] === b[j]) {
        row[j] = nextRow[j + 1]! + 1;
      } else {
        row[j] = Math.max(nextRow[j]!, row[j + 1]!);
      }
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let addedCount = 0;
  let removedCount = 0;

  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push({ type: 'context', text: a[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      lines.push({ type: 'removed', text: a[i]! });
      removedCount += 1;
      i += 1;
    } else {
      lines.push({ type: 'added', text: b[j]! });
      addedCount += 1;
      j += 1;
    }
  }
  while (i < n) {
    lines.push({ type: 'removed', text: a[i]! });
    removedCount += 1;
    i += 1;
  }
  while (j < m) {
    lines.push({ type: 'added', text: b[j]! });
    addedCount += 1;
    j += 1;
  }

  return {
    fromVersion,
    toVersion,
    addedCount,
    removedCount,
    lines,
  };
}
