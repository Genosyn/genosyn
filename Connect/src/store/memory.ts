import crypto from "node:crypto";
import { ConnectError } from "../errors.js";
import type { FlowKey, FlowStore, StoredFlow } from "./types.js";

/**
 * State in this process's memory — right for a single replica.
 *
 * Sign-ins last ten minutes, so a restart costs at most the few that were
 * open at that moment, and each person simply starts again. Token renewal
 * keeps no state at all and is unaffected. Several replicas need the Postgres
 * store instead, because a sign-in's requests can land on any of them.
 */
export function createMemoryStore(
  options: { maxEntries?: number; now?: () => number } = {},
): FlowStore {
  const maxEntries = options.maxEntries ?? 100_000;
  const now = options.now ?? Date.now;
  const rows = new Map<string, StoredFlow>();
  const id = (key: FlowKey) => `${key.kind}\u0000${key.tokenHash}`;

  function live(key: FlowKey): StoredFlow | null {
    const row = rows.get(id(key));
    if (!row) return null;
    if (row.expiresAt <= now()) {
      rows.delete(id(key));
      return null;
    }
    return row;
  }

  function sweepNow(): number {
    let removed = 0;
    const current = now();
    for (const [key, row] of rows) {
      if (row.expiresAt <= current) {
        rows.delete(key);
        removed++;
      }
    }
    return removed;
  }

  return {
    name: "memory",
    async insert(key, value, expiresAt) {
      if (rows.size >= maxEntries) sweepNow();
      // Starting a sign-in is rate limited per address, so a full table means
      // something is wrong; refuse new ones rather than grow without bound.
      if (rows.size >= maxEntries) {
        throw new ConnectError("Sign-in is busy right now. Please try again shortly.", 503);
      }
      if (rows.has(id(key))) throw new Error("Duplicate sign-in token");
      rows.set(id(key), { value, revision: crypto.randomUUID(), expiresAt });
    },
    async get(key) {
      const row = live(key);
      return row ? { ...row } : null;
    },
    async replace(key, revision, value) {
      const row = live(key);
      if (!row || row.revision !== revision) return false;
      rows.set(id(key), { value, revision: crypto.randomUUID(), expiresAt: row.expiresAt });
      return true;
    },
    async remove(key, revision) {
      const row = live(key);
      if (!row || row.revision !== revision) return false;
      rows.delete(id(key));
      return true;
    },
    async sweep() {
      return sweepNow();
    },
    async ping() {},
    async close() {
      rows.clear();
    },
  };
}
