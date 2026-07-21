import crypto from "node:crypto";
import { AppDataSource } from "../db/datasource.js";
import { AuthFlowState } from "../db/entities/AuthFlowState.js";
import { encryptSecret, decryptSecret } from "../lib/secret.js";
import { config } from "../../config.js";
import { LessThan } from "typeorm";

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function createAuthFlowState(
  kind: string,
  payload: unknown,
  ttlMs: number,
): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  const repo = AppDataSource.getRepository(AuthFlowState);
  await repo.delete({ expiresAt: LessThan(new Date()) });
  await repo.save(
    repo.create({
      tokenHash: hashToken(token),
      kind,
      payloadEncrypted: encryptSecret(JSON.stringify(payload), `auth-flow:${kind}`),
      expiresAt: new Date(Date.now() + ttlMs),
    }),
  );
  return token;
}

/** Atomically consume a state token. A callback replay receives null. */
export async function consumeAuthFlowState<T>(kind: string, token: string): Promise<T | null> {
  return AppDataSource.transaction(async (manager) => {
    const repo = manager.getRepository(AuthFlowState);
    const row =
      config.db.driver === "postgres"
        ? await repo.findOne({
            where: { tokenHash: hashToken(token), kind },
            lock: { mode: "pessimistic_write" },
          })
        : await repo.findOneBy({ tokenHash: hashToken(token), kind });
    if (!row) return null;
    await repo.remove(row);
    if (row.expiresAt < new Date()) return null;
    try {
      return JSON.parse(decryptSecret(row.payloadEncrypted)) as T;
    } catch {
      return null;
    }
  });
}
