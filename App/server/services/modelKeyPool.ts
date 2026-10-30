/**
 * Whose turn it is among an AI Model's API keys.
 *
 * An Anthropic or OpenAI AI Model's API keys are one pool of equals: there is
 * no primary and no backup. Every session that runs on the model opens on the
 * key whose turn it is and keeps that key until it ends (`agent/apiKeyRing.ts`)
 * — a session being one OpenCode session against the per-turn model proxy: a
 * chat reply, a Routine Run's work or a Check fix, a Repository work-session
 * turn, a delegated copy, a restricted turn such as grading. A meeting's
 * transcription takes a turn the same way. A connection test does not: it
 * checks the model rather than adding to its work.
 *
 * Turns go round-robin, kept as "handed out longest ago": every key remembers
 * the hand-out it last received — the session that opened on it, or moved to
 * it after another key was refused — and the next session takes the waking
 * key that has waited longest. While the keys stay as they are that is plain
 * round-robin: each key once, then each again in the same order. It stays fair
 * when they change: a key just added has never been handed out, so it goes
 * ahead of every key that has — once the others have all had a turn, that is
 * the very next session; a key back from a rest after a refusal takes its turn
 * at once; a removed key simply drops out. Keys this process has not handed
 * out yet start from a random place in the pool, so a restart — or a second
 * App process — does not open every model's next session on its first key.
 *
 * The turn order lives in this process's memory, per AI Model row, so one
 * model shared by several AI Employees is one pool with one turn order. It is
 * deliberately not saved: an install runs one App process (the Helm chart's
 * `replicaCount: 1`), and the random starting place spreads the keys evenly
 * across restarts and processes anyway, so a database write on every session
 * would buy nothing but load on the one SQLite connection. Taking a turn is
 * synchronous — no `await` between reading the order and handing out the key —
 * so sessions that start at the same moment never take the same turn.
 */

type Pool = {
  /** Where in the pool keys never handed out start, as a fraction of its length. */
  start: number;
  /** Hand-outs so far; each key's stamp is the count when it was handed out. */
  handOuts: number;
  /** keyId → the stamp of its last hand-out. */
  lastHandOut: Map<string, number>;
};

const pools = new Map<string, Pool>();
let random: () => number = Math.random;

function poolOf(modelId: string): Pool {
  let pool = pools.get(modelId);
  if (!pool) {
    pool = { start: random(), handOuts: 0, lastHandOut: new Map() };
    pools.set(modelId, pool);
  }
  return pool;
}

/**
 * `keys` in the order sessions take them: keys this process has not handed out
 * yet first — from the pool's random starting place onward — then the rest,
 * the one handed out longest ago first.
 */
export function turnOrder<K extends { id: string }>(modelId: string, keys: readonly K[]): K[] {
  if (keys.length <= 1) return [...keys];
  const pool = poolOf(modelId);
  const first = Math.min(keys.length - 1, Math.floor(pool.start * keys.length));
  return keys
    .map((key, index) => ({
      key,
      stamp: pool.lastHandOut.get(key.id) ?? -1,
      place: (index - first + keys.length) % keys.length,
    }))
    .sort((a, b) => a.stamp - b.stamp || a.place - b.place)
    .map(({ key }) => key);
}

/**
 * A session just opened on this key, or moved to it: it goes to the back of
 * the turn order.
 */
export function handOutKey(modelId: string, keyId: string): void {
  const pool = poolOf(modelId);
  pool.lastHandOut.set(keyId, pool.handOuts);
  pool.handOuts += 1;
}

/**
 * Forget the turns of keys this AI Model no longer holds — every key but those
 * in `keep` — or, with no `keep`, the model's whole turn order.
 */
export function forgetKeyTurns(modelId: string, keep?: ReadonlySet<string>): void {
  if (!keep) {
    pools.delete(modelId);
    return;
  }
  const pool = pools.get(modelId);
  if (!pool) return;
  for (const keyId of [...pool.lastHandOut.keys()]) {
    if (!keep.has(keyId)) pool.lastHandOut.delete(keyId);
  }
}

/**
 * Tests only: forget every turn order, and pick each new pool's starting place
 * with `options.random` (a number in [0, 1); `Math.random` by default).
 */
export function resetKeyPoolMemory(options: { random?: () => number } = {}): void {
  pools.clear();
  random = options.random ?? Math.random;
}
