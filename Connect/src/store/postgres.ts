import crypto from "node:crypto";
import pg from "pg";
import type { FlowKey, FlowStore } from "./types.js";

// "genc" — serializes schema setup when several replicas start together.
const SCHEMA_LOCK = 0x67656e63;

/**
 * State shared through Postgres, for running more than one replica.
 *
 * The table holds only sealed values keyed by token hashes, each for at most
 * ten minutes, so it needs no migrations history: the one table is created
 * idempotently at boot. Conditional UPDATE/DELETE on the revision column gives
 * the same single-winner semantics as the memory store across replicas.
 */
export async function createPostgresStore(
  connectionString: string,
  options: { table?: string; now?: () => number } = {},
): Promise<FlowStore> {
  const table = options.table ?? "connect_flow_states";
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(table)) throw new Error("Invalid flow table name");
  const now = () => new Date((options.now ?? Date.now)());
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 5_000,
    query_timeout: 10_000,
  });
  // An idle client can fail when the server restarts; the pool replaces it.
  // Without a listener that error would crash the process.
  pool.on("error", () => {});

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [SCHEMA_LOCK]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${table} (
        kind TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        value TEXT NOT NULL,
        revision TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (kind, token_hash)
      )`,
    );
    await client.query(`CREATE INDEX IF NOT EXISTS ${table}_expires_at ON ${table} (expires_at)`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    await pool.end().catch(() => {});
    throw error;
  }
  client.release();

  return {
    name: "postgres",
    async insert(key: FlowKey, value: string, expiresAt: number) {
      await pool.query(
        `INSERT INTO ${table} (kind, token_hash, value, revision, expires_at) VALUES ($1, $2, $3, $4, $5)`,
        [key.kind, key.tokenHash, value, crypto.randomUUID(), new Date(expiresAt)],
      );
    },
    async get(key: FlowKey) {
      const result = await pool.query<{ value: string; revision: string; expires_at: Date }>(
        `SELECT value, revision, expires_at FROM ${table} WHERE kind = $1 AND token_hash = $2 AND expires_at > $3`,
        [key.kind, key.tokenHash, now()],
      );
      const row = result.rows[0];
      return row
        ? { value: row.value, revision: row.revision, expiresAt: row.expires_at.getTime() }
        : null;
    },
    async replace(key: FlowKey, revision: string, value: string) {
      const result = await pool.query(
        `UPDATE ${table} SET value = $4, revision = $5 WHERE kind = $1 AND token_hash = $2 AND revision = $3 AND expires_at > $6`,
        [key.kind, key.tokenHash, revision, value, crypto.randomUUID(), now()],
      );
      return result.rowCount === 1;
    },
    async remove(key: FlowKey, revision: string) {
      const result = await pool.query(
        `DELETE FROM ${table} WHERE kind = $1 AND token_hash = $2 AND revision = $3 AND expires_at > $4`,
        [key.kind, key.tokenHash, revision, now()],
      );
      return result.rowCount === 1;
    },
    async sweep() {
      const result = await pool.query(`DELETE FROM ${table} WHERE expires_at <= $1`, [now()]);
      return result.rowCount ?? 0;
    },
    async ping() {
      await pool.query("SELECT 1");
    },
    async close() {
      await pool.end();
    },
  };
}
