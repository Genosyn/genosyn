import crypto from "node:crypto";
import { AppDataSource } from "../db/datasource.js";
import { AuthFlowState } from "../db/entities/AuthFlowState.js";
import { encryptSecret, decryptSecret } from "../lib/secret.js";
import { LessThan, MoreThan } from "typeorm";

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function createAuthFlowState(
  kind: string,
  payload: unknown,
  ttlMs: number,
  maximumExpiresAt?: number,
): Promise<string> {
  const expiresAt = new Date(Math.min(Date.now() + ttlMs, maximumExpiresAt ?? Infinity));
  const token = crypto.randomBytes(32).toString("base64url");
  const repo = AppDataSource.getRepository(AuthFlowState);
  await repo.delete({ expiresAt: LessThan(new Date()) });
  await repo.save(
    repo.create({
      tokenHash: hashToken(token),
      kind,
      payloadEncrypted: encryptSecret(JSON.stringify(payload), `auth-flow:${kind}`),
      expiresAt,
    }),
  );
  return token;
}

/** Atomically consume a state token. A callback replay receives null. */
export async function consumeAuthFlowState<T>(kind: string, token: string): Promise<T | null> {
  const repo = AppDataSource.getRepository(AuthFlowState);
  const tokenHash = hashToken(token);
  const row = await repo.findOneBy({ tokenHash, kind });
  if (!row) return null;

  // Several requests may read the row, but exactly one can delete this exact
  // id/token/kind tuple. Checking `affected` is the claim: a loser must never
  // receive the already-consumed payload. Burning before decrypting also fails
  // closed if the process stops midway through the callback.
  const claimed = await repo.delete({ id: row.id, tokenHash, kind });
  if (claimed.affected !== 1) return null;
  if (row.expiresAt < new Date()) return null;
  try {
    return JSON.parse(decryptSecret(row.payloadEncrypted)) as T;
  } catch {
    return null;
  }
}

/** A server-only revision: never expose the encrypted payload to a browser. */
export type AuthFlowStateSnapshot<T> = {
  payload: T;
  revision: string;
  expiresAt: number;
};

/** Read without consuming so a caller can verify ownership or a proof first. */
export async function readAuthFlowState<T>(
  kind: string,
  token: string,
): Promise<AuthFlowStateSnapshot<T> | null> {
  const row = await AppDataSource.getRepository(AuthFlowState).findOneBy({
    tokenHash: hashToken(token),
    kind,
    expiresAt: MoreThan(new Date()),
  });
  if (!row) return null;
  try {
    return {
      payload: JSON.parse(decryptSecret(row.payloadEncrypted)) as T,
      revision: row.payloadEncrypted,
      expiresAt: row.expiresAt.getTime(),
    };
  } catch {
    return null;
  }
}

/** Update only the version that was read; never extend its original lifetime. */
export async function compareAndSetAuthFlowState<T>(
  kind: string,
  token: string,
  expected: AuthFlowStateSnapshot<T>,
  next: T,
): Promise<boolean> {
  const result = await AppDataSource.getRepository(AuthFlowState).update(
    {
      tokenHash: hashToken(token),
      kind,
      payloadEncrypted: expected.revision,
      expiresAt: MoreThan(new Date()),
    },
    { payloadEncrypted: encryptSecret(JSON.stringify(next), `auth-flow:${kind}`) },
  );
  return result.affected === 1;
}

/** Consume only a verified snapshot; exactly one concurrent claimant wins. */
export async function consumeAuthFlowStateSnapshot<T>(
  kind: string,
  token: string,
  expected: AuthFlowStateSnapshot<T>,
): Promise<T | null> {
  const result = await AppDataSource.getRepository(AuthFlowState).delete({
    tokenHash: hashToken(token),
    kind,
    payloadEncrypted: expected.revision,
    expiresAt: MoreThan(new Date()),
  });
  return result.affected === 1 ? expected.payload : null;
}
