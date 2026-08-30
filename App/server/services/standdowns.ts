import type { FindOptionsWhere } from "typeorm";
import { In, IsNull } from "typeorm";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Membership } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { Standdown, type StanddownScope, type StanddownSource } from "../db/entities/Standdown.js";
import { recordAudit } from "./audit.js";
import { createNotifications } from "./notifications.js";
import { managingMemberIdForEmployee } from "./reportingLine.js";

/**
 * Standdowns (M58) — the stop button, and the predicate every hot path asks
 * before it starts AI work.
 *
 * The design constraint that shapes this whole module is that the *consumers*
 * are the heartbeat dispatch loop and every chat turn: places that run
 * hundreds of times a minute and cannot afford a query. So enforcement is a
 * **synchronous read of a module-level cache** — {@link workBlocked} never
 * touches the database — and the cache is kept honest two ways at once:
 *
 *  - {@link placeStanddown} and {@link liftStanddown} update it **before they
 *    return**, so the human who pressed the button sees the stop take effect
 *    on the very next tick rather than up to a refresh interval later. Making
 *    the button's own replica wait on a poll would be indefensible for an
 *    emergency instrument.
 *  - a single shared 15s timer reloads every active row. That interval exists
 *    for exactly one reason: a standdown placed on one replica has to reach
 *    the others. It is not how the placing replica learns about its own stop.
 *
 * The cache holds the **rows**, not booleans. The banner needs the reason and
 * the id, the block message names the reason, and re-reading the row to get
 * them would put a query back on the path this cache exists to keep clear.
 *
 * Deliberately no MCP tool in either direction, per the entity's own JSDoc:
 * the roster must not be able to stand itself down, and must not be able to
 * lift one.
 */

/** Only ever a cross-replica catch-up — see the module note. */
const REFRESH_INTERVAL_MS = 15_000;

/** A stop nobody explained is a stop nobody can safely lift. */
const REASON_MAX = 2000;

export class StanddownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StanddownError";
  }
}

export type WorkBlock =
  | { blocked: false }
  | { blocked: true; scope: StanddownScope; reason: string; standdownId: string };

/**
 * One company's active standdowns, indexed the three ways the predicate asks.
 * `company` is checked first because a wider scope subsumes narrower ones.
 */
type CompanyStanddowns = {
  company: Standdown | null;
  employees: Map<string, Standdown>;
  routines: Map<string, Standdown>;
};

type CacheMap = Map<string, CompanyStanddowns>;

let cache: CacheMap = new Map();
let refreshTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Buffers held by refreshes that are currently reading the database.
 *
 * A refresh reads, then swaps in what it read. Without this, a standdown
 * placed *during* that read would be swapped straight back out and go
 * unenforced until the next tick — precisely the latency the synchronous
 * update exists to remove. Every local edit is therefore also recorded here
 * and replayed onto the refresh's result before it lands.
 */
const refreshBuffers = new Set<Array<(into: CacheMap) => void>>();

function companyEntry(into: CacheMap, companyId: string): CompanyStanddowns {
  const existing = into.get(companyId);
  if (existing) return existing;
  const created: CompanyStanddowns = { company: null, employees: new Map(), routines: new Map() };
  into.set(companyId, created);
  return created;
}

function indexRow(into: CacheMap, row: Standdown): void {
  const entry = companyEntry(into, row.companyId);
  if (row.scope === "company") {
    entry.company = row;
    return;
  }
  if (!row.scopeId) return;
  if (row.scope === "employee") entry.employees.set(row.scopeId, row);
  else entry.routines.set(row.scopeId, row);
}

function unindexRow(into: CacheMap, row: Standdown): void {
  const entry = into.get(row.companyId);
  if (!entry) return;
  if (row.scope === "company") {
    if (entry.company?.id === row.id) entry.company = null;
  } else if (row.scopeId) {
    const bucket = row.scope === "employee" ? entry.employees : entry.routines;
    if (bucket.get(row.scopeId)?.id === row.id) bucket.delete(row.scopeId);
  }
}

/** Apply an edit to the live cache now, and to any in-flight refresh's result. */
function applyLocally(edit: (into: CacheMap) => void): void {
  edit(cache);
  for (const buffer of refreshBuffers) buffer.push(edit);
}

/**
 * Reload every active standdown. Exported for boot and for the tests; the
 * timer is the only other caller.
 */
export async function refreshStanddowns(): Promise<void> {
  const buffer: Array<(into: CacheMap) => void> = [];
  refreshBuffers.add(buffer);
  try {
    const rows = await AppDataSource.getRepository(Standdown).find({
      where: { liftedAt: IsNull() },
    });
    const next: CacheMap = new Map();
    for (const row of rows) indexRow(next, row);
    for (const edit of buffer) edit(next);
    cache = next;
  } finally {
    refreshBuffers.delete(buffer);
  }
}

/** Load before the scheduler starts, then keep other replicas in step. */
export async function bootStanddowns(): Promise<void> {
  await refreshStanddowns();
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    void refreshStanddowns().catch((err: unknown) => {
      // A transient database failure keeps the last known-good view: the
      // safe direction here is to keep enforcing what we last read.
      // eslint-disable-next-line no-console
      console.warn(
        `[standdowns] refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }, REFRESH_INTERVAL_MS);
  refreshTimer.unref();
}

/**
 * Stop refreshing and forget what we knew. A process that is no longer
 * reloading rows must not keep answering from a view that can only get
 * staler — the caller is shutting down, and a frozen "blocked" answer would
 * outlive the lift that cleared it.
 */
export function stopStanddowns(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
  cache = new Map();
}

export type StanddownTarget = {
  employeeId?: string;
  routineId?: string;
};

function matchingRow(companyId: string, opts: StanddownTarget): Standdown | null {
  const entry = cache.get(companyId);
  if (!entry) return null;
  if (entry.company) return entry.company;
  if (opts.employeeId) {
    const byEmployee = entry.employees.get(opts.employeeId);
    if (byEmployee) return byEmployee;
  }
  if (opts.routineId) {
    const byRoutine = entry.routines.get(opts.routineId);
    if (byRoutine) return byRoutine;
  }
  return null;
}

/**
 * The enforcement predicate. Synchronous by contract — call it from the
 * dispatch loop, from a chat turn, from a Trigger, from anywhere that is
 * about to start AI work.
 *
 * Pass whatever narrowing you have: a company standdown blocks regardless,
 * so omitting the employee or Routine never produces a false negative for the
 * wider scope.
 */
export function workBlocked(companyId: string, opts: StanddownTarget = {}): WorkBlock {
  const row = matchingRow(companyId, opts);
  if (!row) return { blocked: false };
  return { blocked: true, scope: row.scope, reason: row.reason, standdownId: row.id };
}

/**
 * Whether anything at all is stood down right now.
 *
 * The scheduler's hot loops call {@link workBlockedForRoutine}, which needs a
 * `companyId` a `Routine` row does not carry. On the overwhelmingly common
 * path — nothing stood down anywhere — this lets them answer without the
 * lookup that would otherwise cost one query per due Routine per heartbeat,
 * forever, to discover that nothing is stopped.
 */
export function anyStanddownsActive(): boolean {
  for (const entry of cache.values()) {
    if (entry.company || entry.employees.size > 0 || entry.routines.size > 0) return true;
  }
  return false;
}

/**
 * The predicate the scheduler asks, from a `Routine` row.
 *
 * `Routine` has an `employeeId` and no `companyId` — the company is one hop
 * through `AIEmployee`, which is why this is the async form. Short-circuits on
 * an empty cache so the common path is free.
 */
export async function workBlockedForRoutine(
  routine: Pick<Routine, "id" | "employeeId">,
): Promise<WorkBlock> {
  if (!anyStanddownsActive()) return { blocked: false };
  const employee = await AppDataSource.getRepository(AIEmployee).findOne({
    where: { id: routine.employeeId },
    select: { id: true, companyId: true },
  });
  if (!employee) return { blocked: false };
  return workBlocked(employee.companyId, {
    employeeId: routine.employeeId,
    routineId: routine.id,
  });
}

/** The row itself, for the banner that has to render who and why. */
export function activeStanddownFor(
  companyId: string,
  opts: StanddownTarget = {},
): Standdown | null {
  return matchingRow(companyId, opts);
}

function scopeNoun(scope: StanddownScope): string {
  if (scope === "company") return "company";
  if (scope === "employee") return "AI Employee";
  return "Routine";
}

/**
 * The throwing form, for the seams that would otherwise have to invent their
 * own message. The reason travels with the error because it is the only thing
 * that tells the reader whether they are looking at a drill or an incident.
 */
export function assertNotStoodDown(companyId: string, opts: StanddownTarget = {}): void {
  const block = workBlocked(companyId, opts);
  if (!block.blocked) return;
  throw new StanddownError(
    `AI work is stood down for this ${scopeNoun(block.scope)}: ${block.reason}`,
  );
}

/* ------------------------------------------------------------------ *
 * Interrupting work already in flight
 * ------------------------------------------------------------------ */

type RunInterrupter = {
  ctx: { companyId: string; employeeId: string; routineId: string };
  abort: () => void;
};

/**
 * Registered per in-flight Run by the runner, mirroring
 * `activeTurnInterrupters` in `durableChatTurns.ts`.
 *
 * It lives *here* rather than in the runner because `placeStanddown` is what
 * calls it, and a registry in `runner.ts` would make `standdowns.ts` import
 * the runner while the runner imports the predicate — a cycle, for a map.
 */
const runInterrupters = new Map<string, RunInterrupter>();

export function registerRunInterrupter(
  runId: string,
  ctx: { companyId: string; employeeId: string; routineId: string },
  abort: () => void,
): void {
  runInterrupters.set(runId, { ctx, abort });
}

export function unregisterRunInterrupter(runId: string): void {
  runInterrupters.delete(runId);
}

function coversRun(standdown: Standdown, ctx: RunInterrupter["ctx"]): boolean {
  if (standdown.companyId !== ctx.companyId) return false;
  if (standdown.scope === "company") return true;
  if (standdown.scope === "employee") return standdown.scopeId === ctx.employeeId;
  return standdown.scopeId === ctx.routineId;
}

/**
 * Abort every registered Run the standdown covers and report their ids.
 *
 * Without this a standdown would only stop the *next* slot, which is not what
 * anyone means when they press stop — the Run currently spending money or
 * sending mail is the one they are worried about. Registration is per
 * process, so this stops the Runs on this replica; the others stop theirs
 * when the refresh reaches them.
 */
export function interruptCoveredRuns(standdown: Standdown): string[] {
  const interrupted: string[] = [];
  for (const [runId, entry] of runInterrupters) {
    if (!coversRun(standdown, entry.ctx)) continue;
    interrupted.push(runId);
    try {
      entry.abort();
    } catch (err) {
      // One Run that cannot be aborted must not spare the rest.
      // eslint-disable-next-line no-console
      console.error(`[standdowns] failed to interrupt run ${runId}:`, err);
    }
  }
  return interrupted;
}

/* ------------------------------------------------------------------ *
 * Placing and lifting
 * ------------------------------------------------------------------ */

export type PlaceStanddownInput = {
  companyId: string;
  scope: StanddownScope;
  scopeId?: string | null;
  reason: string;
  source?: StanddownSource;
  placedByUserId?: string | null;
};

/** Every AI Employee a standdown at this scope stops. */
async function coveredEmployees(
  companyId: string,
  scope: StanddownScope,
  scopeId: string | null,
): Promise<AIEmployee[]> {
  const repo = AppDataSource.getRepository(AIEmployee);
  if (scope === "company") return repo.findBy({ companyId });
  if (scope === "employee") return repo.findBy({ companyId, id: scopeId! });
  const routine = await AppDataSource.getRepository(Routine).findOneBy({ id: scopeId! });
  if (!routine) return [];
  return repo.findBy({ companyId, id: routine.employeeId });
}

/**
 * Validate the scope target against the company.
 *
 * A Routine carries no `companyId` of its own, so its company is whatever its
 * employee's is — checking the Routine id alone would let one company stand
 * down another's work.
 */
async function assertScopeTargetExists(
  companyId: string,
  scope: StanddownScope,
  scopeId: string | null,
): Promise<void> {
  if (scope === "company") {
    if (scopeId)
      throw new StanddownError("A company standdown covers everything and names nothing");
    return;
  }
  if (!scopeId) throw new StanddownError(`A ${scopeNoun(scope)} standdown must name its target`);
  if (scope === "employee") {
    const employee = await AppDataSource.getRepository(AIEmployee).countBy({
      id: scopeId,
      companyId,
    });
    if (employee === 0) throw new StanddownError("That AI Employee is not in this company");
    return;
  }
  const routine = await AppDataSource.getRepository(Routine).findOneBy({ id: scopeId });
  if (!routine) throw new StanddownError("That Routine is not in this company");
  const owner = await AppDataSource.getRepository(AIEmployee).countBy({
    id: routine.employeeId,
    companyId,
  });
  if (owner === 0) throw new StanddownError("That Routine is not in this company");
}

function activeWhere(
  companyId: string,
  scope: StanddownScope,
  scopeId: string | null,
): FindOptionsWhere<Standdown> {
  return {
    companyId,
    scope,
    scopeId: scopeId === null ? IsNull() : scopeId,
    liftedAt: IsNull(),
  };
}

/**
 * Place a standdown, stop the Runs it covers, and tell everyone it touches.
 *
 * Idempotent per (scope, scopeId): pressing an already-pressed button returns
 * the standing row rather than stacking a second one. Two rows covering the
 * same scope would mean two lifts to resume work, and the second lift would
 * look like it did nothing — which is the worst possible failure mode for an
 * instrument whose entire job is to be unambiguous.
 */
export async function placeStanddown(input: PlaceStanddownInput): Promise<Standdown> {
  const reason = input.reason.trim().slice(0, REASON_MAX);
  if (!reason) throw new StanddownError("A standdown needs a reason");
  const scopeId = input.scopeId ?? null;
  await assertScopeTargetExists(input.companyId, input.scope, scopeId);

  const repo = AppDataSource.getRepository(Standdown);
  const existing = await repo.findOneBy(activeWhere(input.companyId, input.scope, scopeId));
  if (existing) {
    // The row may have been placed on another replica; index it here so this
    // process enforces it from now rather than from the next refresh.
    applyLocally((into) => indexRow(into, existing));
    return existing;
  }

  const standdown = await repo.save(
    repo.create({
      companyId: input.companyId,
      scope: input.scope,
      scopeId,
      reason,
      source: input.source ?? "human",
      placedByUserId: input.placedByUserId ?? null,
      placedAt: new Date(),
      liftedAt: null,
      liftedByUserId: null,
      liftedReason: "",
    }),
  );
  applyLocally((into) => indexRow(into, standdown));
  const interrupted = interruptCoveredRuns(standdown);

  const employees = await coveredEmployees(input.companyId, input.scope, scopeId);
  await recordAudit({
    companyId: input.companyId,
    actorUserId: input.placedByUserId ?? null,
    actorKind: input.placedByUserId ? "user" : "system",
    action: "standdown.place",
    targetType: "standdown",
    targetId: standdown.id,
    targetLabel: scopeNoun(input.scope),
    metadata: {
      scope: input.scope,
      scopeId,
      source: standdown.source,
      reason,
      interruptedRunIds: interrupted,
    },
    // A standdown is never *inside* a Run — inheriting the ambient provenance
    // of whatever happened to be executing would file the stop as one of that
    // Run's own effects.
    runId: null,
  });

  // Once, here — not once per skipped slot. A stop that lasts a week would
  // otherwise bury the employee's journal under thousands of identical rows
  // and make the one entry that matters unfindable.
  for (const employee of employees) {
    await journalToEmployee(
      employee.id,
      "Your work was stood down",
      `${reason}\n\nNothing you are scheduled for will run, and Runs already in flight were ` +
        "stopped. Work resumes when a human lifts the standdown.",
    );
  }
  await notifyStanddownPlaced(standdown, employees);
  return standdown;
}

/**
 * Lift a standdown. Claimed with a conditional UPDATE on `liftedAt IS NULL`
 * so a double-press — two admins, or one admin and a slow browser — records
 * one lift, one audit row, and one journal entry rather than two.
 */
export async function liftStanddown(args: {
  standdown: Standdown;
  userId?: string | null;
  reason?: string;
}): Promise<Standdown> {
  const repo = AppDataSource.getRepository(Standdown);
  const liftedReason = (args.reason ?? "").trim().slice(0, REASON_MAX);
  const claim = await repo.update(
    { id: args.standdown.id, liftedAt: IsNull() },
    { liftedAt: new Date(), liftedByUserId: args.userId ?? null, liftedReason },
  );
  const current = await repo.findOneByOrFail({ id: args.standdown.id });
  // Whoever lost the race still gets the correct answer back; they just do not
  // re-audit and re-journal a lift that already happened.
  applyLocally((into) => unindexRow(into, current));
  if (claim.affected !== 1) return current;

  const employees = await coveredEmployees(current.companyId, current.scope, current.scopeId);
  await recordAudit({
    companyId: current.companyId,
    actorUserId: args.userId ?? null,
    actorKind: args.userId ? "user" : "system",
    action: "standdown.lift",
    targetType: "standdown",
    targetId: current.id,
    targetLabel: scopeNoun(current.scope),
    metadata: { scope: current.scope, scopeId: current.scopeId, reason: liftedReason },
    runId: null,
  });
  for (const employee of employees) {
    await journalToEmployee(
      employee.id,
      "Your standdown was lifted",
      liftedReason
        ? `${liftedReason}\n\nScheduled work resumes from the next slot.`
        : "Scheduled work resumes from the next slot.",
    );
  }
  return current;
}

export async function listStanddowns(
  companyId: string,
  opts: { active?: boolean } = {},
): Promise<Standdown[]> {
  const where: FindOptionsWhere<Standdown> = opts.active
    ? { companyId, liftedAt: IsNull() }
    : { companyId };
  return AppDataSource.getRepository(Standdown).find({
    where,
    order: { placedAt: "DESC" },
  });
}

export async function getStanddown(companyId: string, id: string): Promise<Standdown | null> {
  return AppDataSource.getRepository(Standdown).findOneBy({ id, companyId });
}

export function serializeStanddown(s: Standdown) {
  return {
    id: s.id,
    scope: s.scope,
    scopeId: s.scopeId,
    reason: s.reason,
    source: s.source,
    placedByUserId: s.placedByUserId,
    placedAt: s.placedAt.toISOString(),
    liftedAt: s.liftedAt?.toISOString() ?? null,
    liftedByUserId: s.liftedByUserId,
    liftedReason: s.liftedReason,
    active: s.liftedAt === null,
    createdAt: s.createdAt.toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * Telling people
 * ------------------------------------------------------------------ */

async function notifyStanddownPlaced(standdown: Standdown, employees: AIEmployee[]): Promise<void> {
  try {
    const memberships = await AppDataSource.getRepository(Membership).find({
      where: { companyId: standdown.companyId, role: In(["owner", "admin"]) },
    });
    const audience = new Set(memberships.map((m) => m.userId));
    // The accountable human is not always an admin, and "the work you are
    // responsible for has stopped" is not news they should hear secondhand.
    for (const employee of employees) {
      const manager = await managingMemberIdForEmployee(standdown.companyId, employee.id);
      if (manager) audience.add(manager);
    }
    if (audience.size === 0) return;
    let what = "A Routine is stood down";
    if (standdown.scope === "company") what = "All AI work is stood down";
    else if (standdown.scope === "employee") {
      what = `${employees[0]?.name ?? "An AI employee"} is stood down`;
    }
    const who =
      standdown.source === "breaker" ? "The failure breaker placed it" : "A human placed it";
    await createNotifications(
      [...audience].map((userId) => ({
        companyId: standdown.companyId,
        userId,
        kind: "standdown_placed" as const,
        title: what,
        body: `${who}: ${standdown.reason}`,
        // Deliberately unlinked: the standdown surface is company chrome, not
        // a row with a URL, and a bell entry that navigates nowhere useful is
        // worse than one that simply says what happened.
        link: null,
        actorKind: "system" as const,
        entityKind: "standdown" as const,
        entityId: standdown.id,
      })),
    );
  } catch (err) {
    // Never let the telling undo the stopping.
    // eslint-disable-next-line no-console
    console.error(`[standdowns] failed to notify placement of ${standdown.id}:`, err);
  }
}

async function journalToEmployee(employeeId: string, title: string, body: string): Promise<void> {
  try {
    const repo = AppDataSource.getRepository(JournalEntry);
    await repo.save(
      repo.create({
        employeeId,
        kind: "system",
        title,
        body,
        runId: null,
        routineId: null,
        authorUserId: null,
      }),
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[standdowns] journal write failed for ${employeeId}:`, err);
  }
}
