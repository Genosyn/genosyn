import crypto from "node:crypto";
import { AppDataSource } from "../db/datasource.js";
import { AuthFlowState } from "../db/entities/AuthFlowState.js";
import { encryptSecret, decryptSecret } from "../lib/secret.js";
import { LessThan } from "typeorm";

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
