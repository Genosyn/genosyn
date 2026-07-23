import cronLib from "node-cron";
import { In, IsNull } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { IntegrationConnection } from "../../db/entities/IntegrationConnection.js";
import { Signal, type SignalActionKind, type SignalSourceKind } from "../../db/entities/Signal.js";
import { SignalEvent, type SignalEventStatus } from "../../db/entities/SignalEvent.js";
import { toSlug } from "../../lib/slug.js";
import { nextRunFor } from "../cron.js";
import { isExploreProvider, runSqlAgainstConnection, type QueryResult } from "../explore.js";

/**
 * Signals — saved queries over the customer's own product database, plus a rule
 * for what to do with the rows that come back. See ROADMAP.md M32.
 *
 * This module owns configuration and read paths only; {@link ./signalTick.js}
 * owns the firing. The split exists because the tick has to be schedulable and
 * heavily stubbed in tests, while CRUD has to be callable from a route handler
 * that must never see an exception it did not ask for.
 *
 * Three decisions shape the surface:
 *
 * - **Write paths return a result, they do not throw.** `createSignal` and
 *   `updateSignal` hand back `{ ok: false, error }` for a bad cron or a taken
 *   slug. Express 4 does not catch a rejected promise from an async handler —
 *   the process exits — so a service that throws on ordinary user input is a
 *   liability at exactly the layer that consumes it.
 * - **One validator, borrowed.** The cron a Signal accepts is *precisely* the
 *   cron a Routine accepts: `node-cron`'s `validate()` plus `nextRunFor()`.
 *   The two disagree (node-cron accepts `"5-1 9 * * *"`, cron-parser throws on
 *   it) and routines.ts already learned that lesson the expensive way — a
 *   schedule that saved with a 200 and then never fired. A second, subtly
 *   different validator here would recreate that bug in a new place.
 * - **Query execution is a seam, not a copy.** Everything routes through
 *   {@link runSignalQuery}, which delegates to Explore's single executor and
 *   its 30s / 5,000-row envelope. {@link setQueryRunner} exists so the tick and
 *   its tests can run without a live Postgres; it is the *only* way to reach
 *   past the executor, and production never calls it.
 */

/**
 * Rows one tick will look at. Deliberately far below Explore's 5,000 ceiling:
 * a Signal that matches 500 accounts on a single tick is a misconfigured query,
 * not an alert, and firing 5,000 notifications is how a company turns the
 * feature off permanently. The overflow is not lost — the rows we did fire on
 * get dedupe keys stored, so the next tick sees the next 500. A Signal with an
 * `ORDER BY` therefore drains in priority order.
 */
export const MAX_SIGNAL_ROWS = 500;

/** Rows the "Test" button shows. Enough to eyeball the shape, not a data dump. */
export const TEST_SIGNAL_ROW_CAP = 20;

export type SignalInput = {
  name: string;
  /** Optional explicit slug. Defaults to a slugified `name`. */
  slug?: string;
  description?: string;
  sourceKind?: SignalSourceKind;
  connectionId?: string | null;
  sql?: string;
  cron?: string;
  enabled?: boolean;
  dedupeKeyColumn?: string;
  emailColumn?: string;
  domainColumn?: string;
  amountColumn?: string;
  actionKind?: SignalActionKind;
  /** Serialized to `actionConfigJson`. Pass null to clear. */
  actionConfig?: Record<string, unknown> | null;
  employeeId?: string | null;
};

/**
 * The result shape for the two write paths.
 *
 * A discriminated union rather than `Signal | null` because "not found",
 * "invalid cron" and "slug taken" map to three different HTTP statuses and a
 * null cannot tell them apart.
 */
export type SignalResult =
  | { ok: true; signal: Signal }
  | { ok: false; error: string };

export type SignalListOptions = {
  /** Include archived rows. Default false. */
  includeArchived?: boolean;
  /** Filter on the enabled flag. Omit for both. */
  enabled?: boolean;
};

export type SignalEventListOptions = {
  signalId?: string;
  status?: SignalEventStatus;
  limit?: number;
  offset?: number;
};

export type TestSignalResult = {
  /** Column names in the executor's order, empty when the run failed. */
  columns: string[];
  /** At most {@link TEST_SIGNAL_ROW_CAP} rows. */
  rows: Record<string, unknown>[];
  /** True when the query returned more rows than the cap shows. */
  truncated: boolean;
  /** Present only on failure; `rows` is empty when it is set. */
  error?: string;
};

const DEFAULT_EVENT_LIMIT = 50;
const MAX_EVENT_LIMIT = 200;

// ───────────────────────────── the executor seam ─────────────────────────────

/**
 * How a Signal's rows are fetched. Takes the whole Signal rather than a SQL
 * string because a `stripe`-kind source has no SQL at all, and a runner that
 * only accepted `(connectionId, sql)` would have to be widened the day the
 * second source kind lands.
 */
export type SignalQueryRunner = (signal: Signal) => Promise<QueryResult>;

let queryRunner: SignalQueryRunner | null = null;

/**
 * Replace the executor. Tests only.
 *
 * The alternative — teaching `explore.ts` about a fake provider — would put
 * test scaffolding inside the code path that holds real customer credentials,
 * so the seam lives here instead. Pass `null` to restore the real executor;
 * a test that forgets leaks its stub into every later test in the file, which
 * is why the setter is deliberately not company-scoped or clever.
 */
export function setQueryRunner(runner: SignalQueryRunner | null): void {
  queryRunner = runner;
}

/**
 * Fetch a Signal's rows.
 *
 * Rejects rather than returning an error shape: both callers (the tick and
 * `testSignal`) already have a try/catch, and collapsing a driver error into a
 * `{ rows: [] }` would make "the database is unreachable" indistinguishable
 * from "nothing matched" — which is the difference between a broken Signal and
 * a healthy quiet one.
 */
export async function runSignalQuery(
  signal: Signal,
  opts: { maxRows?: number } = {},
): Promise<QueryResult> {
  if (queryRunner) return queryRunner(signal);

  if (signal.sourceKind !== "sql") {
    throw new Error(
      `Signals of kind "${signal.sourceKind}" cannot run yet — only "sql" is implemented`,
    );
  }
  if (!signal.connectionId) throw new Error("Signal has no connection configured");
  if (!signal.sql.trim()) throw new Error("Signal has no SQL configured");

  const connection = await AppDataSource.getRepository(IntegrationConnection).findOneBy({
    id: signal.connectionId,
    companyId: signal.companyId,
  });
  if (!connection) throw new Error("The signal's connection no longer exists");
  if (!isExploreProvider(connection.provider)) {
    throw new Error(`Connection provider "${connection.provider}" cannot run queries`);
  }

  return runSqlAgainstConnection(connection, signal.sql, {
    maxRows: opts.maxRows ?? MAX_SIGNAL_ROWS,
  });
}

// ───────────────────────────── validation ─────────────────────────────

/**
 * True when the scheduler can actually run this expression.
 *
 * Both checks, in the order routines.ts settled on: `node-cron` decides what we
 * accept, `nextRunFor` decides what we can schedule, and we accept only the
 * intersection. Dropping either half re-opens the "saved fine, never fires"
 * hole.
 */
export function isValidSignalCron(expr: string): boolean {
  if (typeof expr !== "string" || expr.trim() === "") return false;
  if (!cronLib.validate(expr)) return false;
  return nextRunFor(expr) !== null;
}

/**
 * Read a Signal's action config without ever throwing.
 *
 * `actionConfigJson` is text a route wrote and a later migration may have
 * mangled; a `JSON.parse` in the dispatch path would take down the whole tick
 * for every other Signal. Non-objects (a bare `"3"`, an array, `null`) collapse
 * to `{}` because every consumer reads named keys off it, and an empty config
 * fails the same way a missing one does — visibly, on one event.
 */
export function parseActionConfig(signal: Pick<Signal, "actionConfigJson">): Record<string, unknown> {
  const raw = signal?.actionConfigJson;
  if (!raw || typeof raw !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function serializeActionConfig(config: Record<string, unknown> | null | undefined): string | null {
  if (config === null || config === undefined) return null;
  try {
    return JSON.stringify(config);
  } catch {
    // A caller handing us a cycle gets no config rather than a failed save;
    // the action will report the missing key on its own event.
    return null;
  }
}

// ───────────────────────────── slugs ─────────────────────────────

/**
 * Unique slug within one company.
 *
 * Archived Signals keep their slug, so re-creating a Signal you archived last
 * month lands on `trial-ending-2` rather than colliding. The suffix walk is the
 * same one stages and charts use — a company has tens of Signals, not tens of
 * thousands, so the loop is cheaper than a `LIKE` scan.
 */
export async function uniqueSignalSlug(companyId: string, base: string): Promise<string> {
  const repo = AppDataSource.getRepository(Signal);
  const root = toSlug(base) || "signal";
  let slug = root;
  let n = 1;
  while (await repo.findOneBy({ companyId, slug })) {
    n += 1;
    slug = `${root}-${n}`;
  }
  return slug;
}

// ───────────────────────────── CRUD ─────────────────────────────

/**
 * Every Signal for a company, newest first.
 *
 * Ordered by `createdAt` rather than `lastRunAt`: this list is a configuration
 * screen, and a page whose rows reshuffle every time a cron fires is unusable
 * for editing.
 */
export async function listSignals(
  companyId: string,
  opts: SignalListOptions = {},
): Promise<Signal[]> {
  const qb = AppDataSource.getRepository(Signal)
    .createQueryBuilder("s")
    .where("s.companyId = :companyId", { companyId });
  if (!opts.includeArchived) qb.andWhere("s.archivedAt IS NULL");
  if (opts.enabled !== undefined) {
    qb.andWhere("s.enabled = :enabled", { enabled: opts.enabled });
  }
  return qb.orderBy("s.createdAt", "DESC").addOrderBy("s.id", "DESC").getMany();
}

export async function getSignal(companyId: string, id: string): Promise<Signal | null> {
  return AppDataSource.getRepository(Signal).findOneBy({ id, companyId });
}

export async function getSignalBySlug(companyId: string, slug: string): Promise<Signal | null> {
  return AppDataSource.getRepository(Signal).findOneBy({ companyId, slug });
}

/**
 * Create a Signal.
 *
 * Starts **disabled** unless the caller explicitly asks otherwise. A Signal is
 * a query against somebody's production database wired to an action that emails
 * people; the first version is almost always wrong, and "save, test, then arm"
 * is the only order that does not burn the company's trust on the first try.
 */
export async function createSignal(
  companyId: string,
  input: SignalInput,
  actor: { userId?: string | null } = {},
): Promise<SignalResult> {
  const name = (input.name ?? "").trim();
  if (!name) return { ok: false, error: "Name is required" };

  const cron = (input.cron ?? "0 * * * *").trim();
  if (!isValidSignalCron(cron)) {
    return { ok: false, error: `"${cron}" is not a cron expression this scheduler can run` };
  }

  const slug = await uniqueSignalSlug(companyId, input.slug || name);
  const repo = AppDataSource.getRepository(Signal);
  const signal = await repo.save(
    repo.create({
      companyId,
      name,
      slug,
      description: input.description ?? "",
      sourceKind: input.sourceKind ?? "sql",
      connectionId: input.connectionId ?? null,
      sql: input.sql ?? "",
      cron,
      enabled: input.enabled ?? false,
      dedupeKeyColumn: input.dedupeKeyColumn ?? "",
      emailColumn: input.emailColumn ?? "",
      domainColumn: input.domainColumn ?? "",
      amountColumn: input.amountColumn ?? "",
      actionKind: input.actionKind ?? "activity",
      actionConfigJson: serializeActionConfig(input.actionConfig),
      employeeId: input.employeeId ?? null,
      lastRunAt: null,
      lastError: "",
      lastEventCount: 0,
      archivedAt: null,
      createdById: actor.userId ?? null,
    }),
  );
  return { ok: true, signal };
}

/**
 * Patch a Signal.
 *
 * The slug is **not** re-derived when the name changes. It is in a URL and on
 * every bookmark; renaming "Trial ending" to "Trial ending soon" must not break
 * the link. An explicit `slug` in the patch is honoured, and a collision is
 * reported rather than silently suffixed — a human typed it, so a human should
 * be told.
 *
 * Editing does not reset `lastRunAt`: changing the SQL of a running Signal
 * should not replay its whole history on the next tick. Dedupe keys already
 * stored keep suppressing the rows they matched, which is the conservative
 * direction.
 */
export async function updateSignal(
  companyId: string,
  id: string,
  patch: Partial<SignalInput>,
): Promise<SignalResult> {
  const repo = AppDataSource.getRepository(Signal);
  const signal = await repo.findOneBy({ id, companyId });
  if (!signal) return { ok: false, error: "Signal not found" };

  if (patch.cron !== undefined) {
    const cron = patch.cron.trim();
    if (!isValidSignalCron(cron)) {
      return { ok: false, error: `"${cron}" is not a cron expression this scheduler can run` };
    }
    signal.cron = cron;
  }

  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) return { ok: false, error: "Name is required" };
    signal.name = name;
  }

  if (patch.slug !== undefined) {
    const slug = toSlug(patch.slug);
    if (!slug) return { ok: false, error: "Slug is required" };
    const clash = await repo.findOneBy({ companyId, slug });
    if (clash && clash.id !== id) {
      return { ok: false, error: `The slug "${slug}" is already in use` };
    }
    signal.slug = slug;
  }

  if (patch.description !== undefined) signal.description = patch.description;
  if (patch.sourceKind !== undefined) signal.sourceKind = patch.sourceKind;
  if (patch.connectionId !== undefined) signal.connectionId = patch.connectionId;
  if (patch.sql !== undefined) signal.sql = patch.sql;
  if (patch.enabled !== undefined) signal.enabled = patch.enabled;
  if (patch.dedupeKeyColumn !== undefined) signal.dedupeKeyColumn = patch.dedupeKeyColumn;
  if (patch.emailColumn !== undefined) signal.emailColumn = patch.emailColumn;
  if (patch.domainColumn !== undefined) signal.domainColumn = patch.domainColumn;
  if (patch.amountColumn !== undefined) signal.amountColumn = patch.amountColumn;
  if (patch.actionKind !== undefined) signal.actionKind = patch.actionKind;
  if (patch.actionConfig !== undefined) {
    signal.actionConfigJson = serializeActionConfig(patch.actionConfig);
  }
  if (patch.employeeId !== undefined) signal.employeeId = patch.employeeId;

  return { ok: true, signal: await repo.save(signal) };
}

/**
 * Soft delete.
 *
 * Also clears `enabled`, which is belt-and-braces: the tick already filters on
 * `archivedAt IS NULL`, but an archived-then-restored Signal silently resuming
 * its firing would be a genuinely nasty surprise. Restoring is an explicit
 * re-arm.
 *
 * Events are left in place. They are the audit trail of what fired and what it
 * did, and deleting them because somebody tidied up a Signal list would erase
 * the reason a deal exists.
 */
export async function archiveSignal(
  companyId: string,
  id: string,
  now = new Date(),
): Promise<Signal | null> {
  const repo = AppDataSource.getRepository(Signal);
  const signal = await repo.findOneBy({ id, companyId });
  if (!signal) return null;
  signal.archivedAt = now;
  signal.enabled = false;
  return repo.save(signal);
}

/** Un-archive. Stays disabled — see {@link archiveSignal}. */
export async function restoreSignal(companyId: string, id: string): Promise<Signal | null> {
  const repo = AppDataSource.getRepository(Signal);
  const signal = await repo.findOneBy({ id, companyId });
  if (!signal) return null;
  signal.archivedAt = null;
  return repo.save(signal);
}

// ───────────────────────────── events ─────────────────────────────

/**
 * The event feed, newest first, with a total for the pager.
 *
 * `total` is a second query rather than a `getManyAndCount`, because the count
 * is over the same filters but without the page window and this reads more
 * obviously than trusting the query builder to have kept them in sync.
 */
export async function listSignalEvents(
  companyId: string,
  opts: SignalEventListOptions = {},
): Promise<{ rows: SignalEvent[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_EVENT_LIMIT, 1), MAX_EVENT_LIMIT);
  const offset = Math.max(opts.offset ?? 0, 0);

  const qb = AppDataSource.getRepository(SignalEvent)
    .createQueryBuilder("e")
    .where("e.companyId = :companyId", { companyId });
  if (opts.signalId) qb.andWhere("e.signalId = :signalId", { signalId: opts.signalId });
  if (opts.status) qb.andWhere("e.status = :status", { status: opts.status });

  const total = await qb.clone().getCount();
  const rows = await qb
    .orderBy("e.occurredAt", "DESC")
    .addOrderBy("e.createdAt", "DESC")
    .addOrderBy("e.id", "DESC")
    .skip(offset)
    .take(limit)
    .getMany();

  return { rows, total };
}

/** Dedupe keys this Signal has already fired on, restricted to `keys`. */
export async function loadExistingDedupeKeys(
  signalId: string,
  keys: string[],
): Promise<Set<string>> {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return new Set<string>();
  const rows = await AppDataSource.getRepository(SignalEvent).find({
    where: { signalId, dedupeKey: In(unique) },
    select: { dedupeKey: true },
  });
  return new Set(rows.map((r) => r.dedupeKey));
}

/** Enabled, un-archived Signals across every company — the tick's work list. */
export async function listRunnableSignals(): Promise<Signal[]> {
  return AppDataSource.getRepository(Signal).find({
    where: { enabled: true, archivedAt: IsNull() },
    order: { lastRunAt: "ASC", createdAt: "ASC" },
  });
}

// ───────────────────────────── test run ─────────────────────────────

/**
 * Run a Signal's query once and show the caller what came back.
 *
 * This powers the "Test" button, and its single hard guarantee is that it
 * **writes nothing** — no SignalEvent, no `lastRunAt`, no `lastError`. Testing
 * a Signal must not consume the dedupe keys of the rows it is about to fire on,
 * or the first real tick after a test would find everything already seen and
 * the Signal would look permanently broken.
 *
 * Errors come back in the result rather than as a rejection, because "your SQL
 * has a typo" is the *expected* outcome of pressing Test and the route rendering
 * it is not an error path.
 */
export async function testSignal(companyId: string, signalId: string): Promise<TestSignalResult> {
  const signal = await getSignal(companyId, signalId);
  if (!signal) return { columns: [], rows: [], truncated: false, error: "Signal not found" };

  try {
    const result = await runSignalQuery(signal, { maxRows: TEST_SIGNAL_ROW_CAP + 1 });
    const rows = result.rows ?? [];
    const columns =
      result.fields && result.fields.length > 0
        ? result.fields.map((f) => f.name)
        : rows.length > 0
          ? Object.keys(rows[0])
          : [];
    return {
      columns,
      rows: rows.slice(0, TEST_SIGNAL_ROW_CAP),
      // `truncated` from the executor means "we hit the 5,000 cap"; ours also
      // covers "there were more than we are showing you", which is the thing
      // the person pressing Test actually needs to know.
      truncated: rows.length > TEST_SIGNAL_ROW_CAP || result.truncated === true,
    };
  } catch (err) {
    return {
      columns: [],
      rows: [],
      truncated: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
