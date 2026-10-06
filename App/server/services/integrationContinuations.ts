import { LessThan } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { IntegrationContinuation } from "../db/entities/IntegrationContinuation.js";

/**
 * Durable storage behind the short continuation references Integration
 * tools hand out (see `IntegrationContinuation`). A reference is derived from
 * the value it stands for, so saving the same value twice is a no-op.
 */
export type ContinuationStore = {
  save(id: string, token: string, connectionId: string): Promise<void>;
  load(id: string): Promise<string | null>;
};

/** Older values are past every continuation's own expiry (30 days). */
export const CONTINUATION_RETENTION_MS = 31 * 86_400_000;
const PRUNE_INTERVAL_MS = 60 * 60_000;
let lastPrunedAt = 0;

export const databaseContinuationStore: ContinuationStore = {
  async save(id, token, connectionId) {
    const repo = AppDataSource.getRepository(IntegrationContinuation);
    await repo.createQueryBuilder().insert().values({ id, token, connectionId }).orIgnore().execute();
    if (Date.now() - lastPrunedAt < PRUNE_INTERVAL_MS) return;
    lastPrunedAt = Date.now();
    await repo.delete({ createdAt: LessThan(new Date(Date.now() - CONTINUATION_RETENTION_MS)) });
  },
  async load(id) {
    const row = await AppDataSource.getRepository(IntegrationContinuation).findOneBy({ id });
    return row?.token ?? null;
  },
};

const memoryTokens = new Map<string, string>();

/** For callers without a database, and tests: references last as long as the process. */
export const memoryContinuationStore: ContinuationStore = {
  async save(id, token) {
    memoryTokens.set(id, token);
  },
  async load(id) {
    return memoryTokens.get(id) ?? null;
  },
};

/** The database once it is open; the process memory before that. */
export function continuationStore(): ContinuationStore {
  return AppDataSource.isInitialized ? databaseContinuationStore : memoryContinuationStore;
}
