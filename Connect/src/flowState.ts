import crypto from "node:crypto";
import { randomToken, type Sealer } from "./secrets.js";
import type { FlowKey, FlowStore } from "./store/types.js";

export type FlowSnapshot<T> = { payload: T; revision: string; expiresAt: number };

/**
 * Typed, sealed sign-in state. Clients hold random tokens; the store holds
 * only their hashes and the sealed payloads, so neither a database dump nor a
 * log of store queries is enough to redeem a sign-in or read a credential.
 */
export type FlowStates = ReturnType<typeof createFlowStates>;

export function createFlowStates(store: FlowStore, sealer: Sealer) {
  const key = (kind: string, token: string): FlowKey => ({
    kind,
    tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
  });
  const context = (kind: string) => `connect-flow:${kind}`;

  return {
    store,
    async create<T>(kind: string, payload: T, expiresAt: number): Promise<string> {
      const token = randomToken();
      await store.insert(
        key(kind, token),
        sealer.seal(JSON.stringify(payload), context(kind)),
        expiresAt,
      );
      return token;
    },
    async read<T>(kind: string, token: string): Promise<FlowSnapshot<T> | null> {
      const row = await store.get(key(kind, token));
      if (!row) return null;
      const plaintext = sealer.open(row.value, context(kind));
      if (plaintext === null) return null;
      try {
        return {
          payload: JSON.parse(plaintext) as T,
          revision: row.revision,
          expiresAt: row.expiresAt,
        };
      } catch {
        return null;
      }
    },
    /** Write `next` only over the exact version that was read. */
    async replace<T>(
      kind: string,
      token: string,
      expected: FlowSnapshot<T>,
      next: T,
    ): Promise<boolean> {
      return store.replace(
        key(kind, token),
        expected.revision,
        sealer.seal(JSON.stringify(next), context(kind)),
      );
    },
    /** Delete the exact version that was read; exactly one concurrent caller gets the payload. */
    async consume<T>(kind: string, token: string, expected: FlowSnapshot<T>): Promise<T | null> {
      return (await store.remove(key(kind, token), expected.revision)) ? expected.payload : null;
    },
  };
}
