/**
 * Drawing helpers for the vision page. Every picture on it is grown from a
 * fixed seed at module load, so the prerendered markup and the hydrated tree
 * are the same picture, dot for dot.
 */

export type Point = { x: number; y: number };

/** mulberry32: small, fast, and the same sequence on the server and in the browser. */
export function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const round = (n: number) => Math.round(n * 10) / 10;

/** An S-curve between two points, for a tree that grows downward. */
export function curve(from: Point, to: Point): string {
  const mid = round((from.y + to.y) / 2);
  return `M${round(from.x)} ${round(from.y)}C${round(from.x)} ${mid} ${round(to.x)} ${mid} ${round(to.x)} ${round(to.y)}`;
}

/** The same curve on its side, for a tree that grows to the right. */
export function sideways(from: Point, to: Point): string {
  const mid = round((from.x + to.x) / 2);
  return `M${round(from.x)} ${round(from.y)}C${mid} ${round(from.y)} ${mid} ${round(to.y)} ${round(to.x)} ${round(to.y)}`;
}
