import { randomUUID } from "node:crypto";

import { AppDataSource } from "../db/datasource.js";

/**
 * An in-memory database for service tests.
 *
 * Before this existed the test suite could only reach pure functions, so every
 * service — the ones holding the actual invariants — was untested. The blocker
 * was that `AppDataSource` is a module-level `const` built from `config.ts`, so
 * there was no seam to point it somewhere disposable. TypeORM 0.3's
 * `setOptions()` is that seam: called before `initialize()`, it repoints the
 * same instance at `:memory:` without touching the export every service
 * imports.
 *
 * **Safety.** {@link initTestDb} refuses to run against an already-initialized
 * DataSource, and asserts the resulting database really is `:memory:`. A test
 * harness that silently attached to `data/app.sqlite` and then called
 * `synchronize(true)` would drop the developer's local database — so that path
 * throws rather than trusting configuration.
 *
 * Schema comes from `synchronize`, not from the migration chain. The migrations
 * are already covered end-to-end by CI's fresh-boot job (and, for Postgres, by
 * generating against a real server); re-running 100+ of them per test file
 * would cost seconds for coverage we already have.
 *
 * Usage:
 * ```ts
 * import { beforeEach, before, test } from "node:test";
 * before(initTestDb);
 * beforeEach(resetTestDb);
 * ```
 * `node:test` runs each file in its own process, so one DataSource per file is
 * exactly right and tests in different files cannot see each other's rows.
 */

let initialized = false;

/** Point the shared DataSource at a private in-memory database and connect. */
export async function initTestDb(): Promise<void> {
  if (initialized) return;
  if (AppDataSource.isInitialized) {
    throw new Error(
      "initTestDb: AppDataSource is already initialized — refusing to repoint a live connection",
    );
  }

  AppDataSource.setOptions({
    type: "better-sqlite3",
    database: ":memory:",
    synchronize: true,
    dropSchema: true,
    migrations: [],
    logging: false,
  });

  const database = (AppDataSource.options as { database?: unknown }).database;
  if (database !== ":memory:") {
    throw new Error(
      `initTestDb: expected an in-memory database, got ${String(database)} — refusing to continue`,
    );
  }

  await AppDataSource.initialize();
  initialized = true;
}

/**
 * Drop and rebuild every table.
 *
 * Chosen over per-table DELETE because it also resets anything a previous test
 * altered about the schema, and because a test that leaks a row into the next
 * one produces failures that look like logic bugs and cost hours.
 */
export async function resetTestDb(): Promise<void> {
  if (!initialized) await initTestDb();
  await AppDataSource.synchronize(true);
}

export async function closeTestDb(): Promise<void> {
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
  initialized = false;
}

/**
 * A company id for scoping test rows.
 *
 * Tests do not insert a real `Company`: every service scopes by a `companyId`
 * varchar with no foreign key (this codebase has no TypeORM relations), so an
 * opaque id is enough and keeps fixtures to one line. Where a test genuinely
 * needs the Company row it inserts one itself.
 */
export function testCompanyId(): string {
  return `co_${randomUUID()}`;
}

/** Deterministic-ish id for fixtures that need a stable-looking foreign key. */
export function testId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

/**
 * Save a row through the shared DataSource.
 *
 * Thin, but it keeps fixture setup to `await insert(Contact, {...})` instead of
 * three lines of repository ceremony in every test.
 */
export async function insert<T extends object>(
  entity: new () => T,
  values: Partial<T>,
): Promise<T> {
  const repo = AppDataSource.getRepository(entity);
  return repo.save(repo.create(values as T));
}
