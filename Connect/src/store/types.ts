/** A row is addressed by its kind and the SHA-256 of the token a client holds. */
export type FlowKey = { kind: string; tokenHash: string };

export type StoredFlow = {
  /** Sealed before it reaches the store; a store never sees plaintext or raw tokens. */
  value: string;
  /** Changes on every write, so a stale reader's write is refused. */
  revision: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
};

/**
 * Short-lived sign-in state.
 *
 * Every mutation is conditional on the revision the caller read, and every
 * read ignores expired rows, so concurrent requests against any number of
 * replicas settle on exactly one winner: one poll receives a credential, one
 * callback redeems a code. Expired rows are invisible before they are swept.
 */
export interface FlowStore {
  readonly name: "memory" | "postgres";
  insert(key: FlowKey, value: string, expiresAt: number): Promise<void>;
  get(key: FlowKey): Promise<StoredFlow | null>;
  /** Replace the value only if it is still at `revision`; the expiry never moves. */
  replace(key: FlowKey, revision: string, value: string): Promise<boolean>;
  /** Delete only if still at `revision`; true for exactly one concurrent caller. */
  remove(key: FlowKey, revision: string): Promise<boolean>;
  /** Delete expired rows; returns how many. */
  sweep(): Promise<number>;
  /** Throws when the store cannot serve requests. */
  ping(): Promise<void>;
  close(): Promise<void>;
}
