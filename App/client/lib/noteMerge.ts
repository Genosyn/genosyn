/**
 * Three-way merge of a note's Markdown, line by line — what keeps an AI
 * Employee's edit and a Member's typing from overwriting each other when
 * both change the same page at once.
 *
 * Given the version both sides started from, a region only one side changed
 * takes that side's change; a region both changed the same way takes it once;
 * a region both changed differently keeps ours (the person at the keyboard)
 * and counts as a conflict. Notes are line-shaped Markdown, so an AI
 * appending a section at the bottom while someone edits the top merges
 * cleanly.
 */

/** Matched line pairs `[indexInA, indexInB]` of a shortest edit script, or null when too different. */
export function matchLines(a: readonly string[], b: readonly string[], maxEdits = 3000): Array<[number, number]> | null {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  const aMid = a.slice(prefix, a.length - suffix);
  const bMid = b.slice(prefix, b.length - suffix);
  const middle = myers(aMid, bMid, maxEdits);
  if (!middle) return null;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < prefix; i++) out.push([i, i]);
  for (const [x, y] of middle) out.push([x + prefix, y + prefix]);
  for (let i = 0; i < suffix; i++) out.push([a.length - suffix + i, b.length - suffix + i]);
  return out;
}

/** Myers' O(ND) diff, returning the matched pairs. */
function myers(a: readonly string[], b: readonly string[], maxEdits: number): Array<[number, number]> | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    if (d > maxEdits) return null;
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, d, offset);
    }
  }
  return null;
}

function backtrack(
  trace: Int32Array[],
  a: readonly string[],
  b: readonly string[],
  depth: number,
  offset: number,
): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  let x = a.length;
  let y = b.length;
  for (let d = depth; d > 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      pairs.push([x - 1, y - 1]);
      x--;
      y--;
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    pairs.push([x - 1, y - 1]);
    x--;
    y--;
  }
  return pairs.reverse();
}

export type MergeResult = { text: string; conflicts: number };

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

/** Merge `ours` and `theirs`, both edited from `base`. */
export function mergeText(base: string, ours: string, theirs: string): MergeResult {
  if (ours === theirs || base === theirs) return { text: ours, conflicts: 0 };
  if (base === ours) return { text: theirs, conflicts: 0 };
  const b = base.split("\n");
  const o = ours.split("\n");
  const t = theirs.split("\n");
  const withOurs = matchLines(b, o);
  const withTheirs = matchLines(b, t);
  if (!withOurs || !withTheirs) return { text: ours, conflicts: 1 };
  const inOurs = new Map(withOurs);
  const inTheirs = new Map(withTheirs);
  const out: string[] = [];
  let conflicts = 0;
  let bi = 0;
  let oi = 0;
  let ti = 0;
  const resolve = (bEnd: number, oEnd: number, tEnd: number) => {
    const bChunk = b.slice(bi, bEnd);
    const oChunk = o.slice(oi, oEnd);
    const tChunk = t.slice(ti, tEnd);
    if (sameLines(oChunk, bChunk)) out.push(...tChunk);
    else if (sameLines(tChunk, bChunk) || sameLines(oChunk, tChunk)) out.push(...oChunk);
    else {
      out.push(...oChunk);
      conflicts++;
    }
  };
  for (let j = 0; j < b.length; j++) {
    const oj = inOurs.get(j);
    const tj = inTheirs.get(j);
    if (oj === undefined || tj === undefined || oj < oi || tj < ti) continue;
    resolve(j, oj, tj);
    out.push(b[j]);
    bi = j + 1;
    oi = oj + 1;
    ti = tj + 1;
  }
  resolve(b.length, o.length, t.length);
  return { text: out.join("\n"), conflicts };
}

export type NoteSnapshot = { title: string; body: string; icon: string };

/** Merge whole snapshots: the body line by line, title and icon as single values. */
export function mergeSnapshots(
  base: NoteSnapshot,
  ours: NoteSnapshot,
  theirs: NoteSnapshot,
): { snapshot: NoteSnapshot; conflicts: number } {
  const body = mergeText(base.body, ours.body, theirs.body);
  let conflicts = body.conflicts;
  const pick = (key: "title" | "icon") => {
    if (ours[key] === base[key]) return theirs[key];
    if (theirs[key] !== base[key] && theirs[key] !== ours[key]) conflicts++;
    return ours[key];
  };
  return { snapshot: { title: pick("title"), body: body.text, icon: pick("icon") }, conflicts };
}
