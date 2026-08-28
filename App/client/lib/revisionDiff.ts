/**
 * The tiny line diff behind the Revisions page's before/after view (M52).
 *
 * One flat list of rows in document order: `same` rows appear in both
 * columns, `removed` rows only on the "Current" side, `added` rows only on
 * the "Proposed" side. Plain LCS over lines — no dependency, no word-level
 * cleverness; a Soul or brief is prose, and line granularity reads fine.
 */

export type DiffLineKind = "same" | "removed" | "added";
export type DiffLine = { kind: DiffLineKind; text: string };

/**
 * Cap on the LCS table (rows × cols). A proposal body is at most a few
 * thousand lines; past this the quadratic table stops paying for itself and
 * the diff degrades to a coarse full replace of the changed middle.
 */
const MAX_TABLE_CELLS = 1_000_000;

function toLines(text: string): string[] {
  return text === "" ? [] : text.replace(/\r\n/g, "\n").split("\n");
}

export function diffLines(base: string, proposed: string): DiffLine[] {
  const a = toLines(base);
  const b = toLines(proposed);

  // Trim the common prefix and suffix first — most proposals edit a few
  // lines in the middle of a long document, so this keeps the table tiny.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const out: DiffLine[] = a.slice(0, start).map((text) => ({ kind: "same" as const, text }));

  if ((midA.length + 1) * (midB.length + 1) > MAX_TABLE_CELLS) {
    // Coarse fallback: a full replace is still a correct diff.
    for (const text of midA) out.push({ kind: "removed", text });
    for (const text of midB) out.push({ kind: "added", text });
  } else {
    // dp[i][j] = length of the LCS of midA[i..] and midB[j..].
    const dp: Uint32Array[] = Array.from(
      { length: midA.length + 1 },
      () => new Uint32Array(midB.length + 1),
    );
    for (let i = midA.length - 1; i >= 0; i -= 1) {
      for (let j = midB.length - 1; j >= 0; j -= 1) {
        dp[i][j] =
          midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        out.push({ kind: "same", text: midA[i] });
        i += 1;
        j += 1;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        // Ties emit the removal first, so an edited line reads old-then-new.
        out.push({ kind: "removed", text: midA[i] });
        i += 1;
      } else {
        out.push({ kind: "added", text: midB[j] });
        j += 1;
      }
    }
    for (; i < midA.length; i += 1) out.push({ kind: "removed", text: midA[i] });
    for (; j < midB.length; j += 1) out.push({ kind: "added", text: midB[j] });
  }

  for (const text of a.slice(endA)) out.push({ kind: "same", text });
  return out;
}
