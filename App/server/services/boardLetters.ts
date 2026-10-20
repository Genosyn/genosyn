import { type EntityManager, In, LessThan, LessThanOrEqual } from "typeorm";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import {
  BoardLetter,
  type BoardLetterAuditStatus,
  type BoardLetterStatus,
  type BoardLetterTrigger,
} from "../db/entities/BoardLetter.js";
import { BoardLetterSettings } from "../db/entities/BoardLetterSettings.js";
import { Company } from "../db/entities/Company.js";
import { User } from "../db/entities/User.js";
import { withSerializedTransaction } from "../db/transactions.js";
import type { runRestrictedEmployeeAgent } from "./agent/runEmployee.js";
import { recordAudit } from "./audit.js";
import { type AuditFinding, auditBoardLetter } from "./boardLetterAudit.js";
import {
  collectLetterEvidence,
  collectLetterFigures,
  type LetterEvidence,
  type LetterFigures,
} from "./boardLetterFigures.js";
import { deliverBoardLetter } from "./boardLetterNotice.js";
import {
  type LetterMonth,
  latestClosedMonth,
  letterDueAt,
  monthContaining,
  monthLabel,
} from "./boardLetterPeriods.js";
import { type LetterTrace, type TraceToken, traceLetter } from "./boardLetterTrace.js";
import {
  BoardLetterWriterUnavailableError,
  type LetterContext,
  writeBoardLetter,
} from "./boardLetterWriting.js";
import { companyTimeZone } from "./companyTimeZone.js";
import { getActiveModel } from "./models.js";
import { isModelConnected } from "./providers.js";
import { emitResourceChange } from "./resourceEvents.js";
import { workBlocked } from "./standdowns.js";

/**
 * The monthly letter to the board, from the schedule to the board's inbox.
 *
 * One letter per company per month, numbered in the order they are begun. On
 * the first of each month, at 06:00 on the company's clock, the scheduler
 * claims the letter for the month just ended — a unique `(companyId, month)`
 * row, so it is claimed exactly once however many processes race — and then,
 * in the background:
 *
 *  1. computes the figures and gathers the evidence (`boardLetterFigures.ts`);
 *  2. asks the writer for the prose in a restricted turn (`boardLetterWriting.ts`);
 *  3. traces every number in the prose to a figure (`boardLetterTrace.ts`);
 *  4. asks the board's auditor for an opinion, when one is appointed
 *     (`boardLetterAudit.ts`);
 *  5. tells the board, once (`boardLetterNotice.ts`).
 *
 * Every step writes with a conditional update fenced on the letter's state
 * and attempt, so an attempt that a restart or a person has superseded can
 * never overwrite the one that replaced it. A scheduled letter whose writer
 * fails is tried again an hour later, up to three attempts; a person can try
 * again at any time. A writer who is stood down is waited for, never worked
 * around. Owners and admins configure all of it and read every letter; no
 * MCP tool reaches any of it.
 */

const STALE_STEP_MS = 15 * 60_000;
const RETRY_DELAY_MS = 60 * 60_000;
export const MAX_SCHEDULED_ATTEMPTS = 3;
const STANDDOWN_RECHECK_MS = 10 * 60_000;
const MAX_DISPATCH_PER_TICK = 3;
const ERROR_MAX_CHARS = 1_000;

export class BoardLetterValidationError extends Error {
  readonly status = 400;
}

export class BoardLetterNotFoundError extends Error {
  readonly status = 404;
}

export class BoardLetterConflictError extends Error {
  readonly status = 409;
}

export type BoardLetterDependencies = {
  /** The model turn, for both the writer and the auditor. */
  runRestricted?: typeof runRestrictedEmployeeAgent;
  now?: () => Date;
  /** Tells the board a letter is ready. Tests pass a recorder. */
  deliver?: (letterId: string, now: Date) => Promise<unknown>;
};

export type BoardLetterEmployee = {
  id: string | null;
  name: string;
  role: string;
  slug: string;
  avatarKey: string | null;
};

export type BoardLetterSettingsDTO = {
  enabled: boolean;
  enabledAt: string | null;
  writer: BoardLetterEmployee | null;
  auditor: BoardLetterEmployee | null;
  auditorAppointedAt: string | null;
  auditorAppointedBy: { id: string; name: string } | null;
  /** The zone the company's months are read in; empty for server time. */
  timeZone: string;
  /** The most recent month that has ended, and the letter it has, if any. */
  lastMonth: {
    month: string;
    label: string;
    letterNumber: number | null;
    status: BoardLetterStatus | null;
    /** Whether a person may ask for its letter now. */
    canWrite: boolean;
  };
  /** The letter the schedule will write next, while letters are on. */
  nextLetter: { month: string; label: string; dueAt: string } | null;
  /** Why letters cannot be written right now, when they cannot. */
  waiting: string | null;
  lastError: string;
};

export type BoardLetterSettingsInput = {
  enabled: boolean;
  writerEmployeeId: string | null;
  auditorEmployeeId: string | null;
};

export type BoardLetterSummaryDTO = {
  id: string;
  number: number;
  month: string;
  monthLabel: string;
  status: BoardLetterStatus;
  auditStatus: BoardLetterAuditStatus;
  summary: string;
  untracedCount: number;
  findingsCount: number;
  writer: BoardLetterEmployee;
  auditor: BoardLetterEmployee | null;
  triggerKind: BoardLetterTrigger;
  attempts: number;
  retryAt: string | null;
  errorMessage: string;
  createdAt: string;
  writtenAt: string | null;
  auditedAt: string | null;
  deliveredAt: string | null;
};

export type BoardLetterTraces = { summary: LetterTrace; body: LetterTrace };

export type BoardLetterDTO = BoardLetterSummaryDTO & {
  periodStart: string;
  periodEnd: string;
  timeZone: string;
  body: string;
  figures: LetterFigures | null;
  evidence: LetterEvidence | null;
  trace: BoardLetterTraces;
  audit: { note: string; findings: AuditFinding[] };
};

type LetterClaim = {
  letter: BoardLetter;
  writer: AIEmployee;
  companyName: string;
  month: LetterMonth;
};

// ──────────────────────────────── Helpers ────────────────────────────────

/** The live-sync kind an open Letters page refetches on. */
export const BOARD_LETTER_KIND = "board_letter";

/**
 * Refresh an open Letters page. Announced here, with `trigger: false`, rather
 * than registered in the resource-change subscriber: everything registered
 * there is a kind a Routine Trigger can subscribe to, and a letter changing
 * state must never start AI work.
 */
function announce(companyId: string): void {
  emitResourceChange(companyId, BOARD_LETTER_KIND, undefined, { trigger: false });
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function errorText(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).trim();
  return text.length > ERROR_MAX_CHARS ? `${text.slice(0, ERROR_MAX_CHARS - 1)}…` : text;
}

const EMPTY_TRACE: LetterTrace = { traced: [], untraced: [] };

function tracesOf(letter: BoardLetter): BoardLetterTraces {
  const stored = parseJson<Partial<BoardLetterTraces>>(letter.traceJson, {});
  return { summary: stored.summary ?? EMPTY_TRACE, body: stored.body ?? EMPTY_TRACE };
}

function untracedOf(traces: BoardLetterTraces): TraceToken[] {
  return [...traces.summary.untraced, ...traces.body.untraced];
}

function employeeSnapshot(employee: AIEmployee): BoardLetterEmployee {
  return {
    id: employee.id,
    name: employee.name,
    role: employee.role,
    slug: employee.slug,
    avatarKey: employee.avatarKey ?? null,
  };
}

function isStale(letter: BoardLetter, now: Date): boolean {
  return letter.startedAt.getTime() <= now.getTime() - STALE_STEP_MS;
}

/** Whether `month`'s letter is owed by the schedule: it ended after letters were switched on. */
function isOwed(settings: BoardLetterSettings, month: LetterMonth): boolean {
  return settings.enabledAt !== null && month.end.getTime() > settings.enabledAt.getTime();
}

async function lockedSettings(
  manager: EntityManager,
  companyId: string,
): Promise<BoardLetterSettings | null> {
  const repo = manager.getRepository(BoardLetterSettings);
  if (config.db.driver === "postgres") {
    return repo.findOne({ where: { companyId }, lock: { mode: "pessimistic_write" } });
  }
  return repo.findOneBy({ companyId });
}

/** Create the settings row if the company has none, then lock and return it. */
async function ensureLockedSettings(
  manager: EntityManager,
  companyId: string,
): Promise<BoardLetterSettings> {
  await manager
    .getRepository(BoardLetterSettings)
    .createQueryBuilder()
    .insert()
    .values({
      companyId,
      enabled: false,
      enabledAt: null,
      writerEmployeeId: null,
      auditorEmployeeId: null,
      auditorAppointedByUserId: null,
      auditorAppointedAt: null,
      nextLetterAt: null,
      lastError: "",
    })
    .orIgnore()
    .execute();
  const settings = await lockedSettings(manager, companyId);
  if (!settings) throw new Error("Could not initialize letter settings.");
  return settings;
}

/**
 * When the scheduler should next look. The month just ended, if its letter is
 * owed and missing (possibly already due) or failed with a retry pending;
 * otherwise 06:00 on the next first of the month.
 */
async function computeNextLetterAt(
  manager: EntityManager,
  settings: BoardLetterSettings,
  timeZone: string,
  now: Date,
): Promise<Date | null> {
  if (!settings.enabled || !settings.writerEmployeeId) return null;
  const closed = latestClosedMonth(now, timeZone);
  if (isOwed(settings, closed)) {
    const letter = await manager
      .getRepository(BoardLetter)
      .findOneBy({ companyId: settings.companyId, month: closed.month });
    if (!letter) return letterDueAt(closed, timeZone);
    if (letter.status === "failed" && letter.retryAt) return letter.retryAt;
  }
  return letterDueAt(monthContaining(now, timeZone), timeZone);
}

async function nextNumber(manager: EntityManager, companyId: string): Promise<number> {
  const last = await manager.getRepository(BoardLetter).findOne({
    where: { companyId },
    order: { number: "DESC" },
    select: { id: true, number: true },
  });
  return (last?.number ?? 0) + 1;
}

async function beginLetter(
  manager: EntityManager,
  args: {
    companyId: string;
    month: LetterMonth;
    timeZone: string;
    writer: AIEmployee;
    trigger: BoardLetterTrigger;
    existing: BoardLetter | null;
    now: Date;
  },
): Promise<BoardLetter> {
  const repo = manager.getRepository(BoardLetter);
  const writer = {
    writerEmployeeId: args.writer.id,
    writerName: args.writer.name,
    writerRole: args.writer.role,
    writerSlug: args.writer.slug,
    writerAvatarKey: args.writer.avatarKey ?? null,
  };
  if (args.existing) {
    // A failed (or abandoned) letter keeps its number and month; this attempt
    // starts from nothing but them.
    const updated = await repo.update(
      { id: args.existing.id, attempts: args.existing.attempts },
      {
        ...writer,
        status: "writing",
        triggerKind: args.trigger,
        attempts: args.existing.attempts + 1,
        retryAt: null,
        startedAt: args.now,
        writtenAt: null,
        errorMessage: "",
        auditStatus: "pending",
        auditNote: "",
        auditFindingsJson: "[]",
        auditedAt: null,
        untracedCount: 0,
        summary: "",
        body: "",
        traceJson: "{}",
      },
    );
    if (updated.affected !== 1) {
      throw new BoardLetterConflictError("The letter changed while it was being restarted.");
    }
    const restarted = await repo.findOneBy({ id: args.existing.id });
    if (!restarted) throw new BoardLetterNotFoundError("The letter no longer exists.");
    return restarted;
  }
  return repo.save(
    repo.create({
      companyId: args.companyId,
      number: await nextNumber(manager, args.companyId),
      month: args.month.month,
      periodStart: args.month.start,
      periodEnd: args.month.end,
      timeZone: args.timeZone,
      status: "writing",
      triggerKind: args.trigger,
      attempts: 1,
      retryAt: null,
      startedAt: args.now,
      writtenAt: null,
      deliveredAt: null,
      ...writer,
      auditStatus: "pending",
      auditorEmployeeId: null,
      auditorName: "",
      auditorRole: "",
      auditorSlug: "",
      auditorAvatarKey: null,
      auditedAt: null,
      untracedCount: 0,
      summary: "",
      errorMessage: "",
      auditNote: "",
      auditFindingsJson: "[]",
      traceJson: "{}",
      figuresJson: "{}",
      evidenceJson: "{}",
      body: "",
    }),
  );
}

async function companyName(companyId: string): Promise<string> {
  const company = await AppDataSource.getRepository(Company).findOne({
    where: { id: companyId },
    select: { id: true, name: true },
  });
  return company?.name ?? "the company";
}

/** The appointed auditor, unless there is none or it is somehow the writer. */
async function appointedAuditor(
  companyId: string,
  writerId: string | null,
): Promise<AIEmployee | null> {
  const settings = await AppDataSource.getRepository(BoardLetterSettings).findOneBy({ companyId });
  if (!settings?.auditorEmployeeId || settings.auditorEmployeeId === writerId) return null;
  return AppDataSource.getRepository(AIEmployee).findOneBy({
    id: settings.auditorEmployeeId,
    companyId,
  });
}

function auditorColumns(auditor: AIEmployee) {
  return {
    auditorEmployeeId: auditor.id,
    auditorName: auditor.name,
    auditorRole: auditor.role,
    auditorSlug: auditor.slug,
    auditorAvatarKey: auditor.avatarKey ?? null,
  };
}

// ─────────────────────────────── Settings ────────────────────────────────

/** Why `writer` cannot write a letter right now, if it cannot. */
async function writerWaiting(
  companyId: string,
  writer: AIEmployee | null,
): Promise<{ message: string | null; blocked: boolean }> {
  if (!writer) return { message: "Choose an AI Employee to write the letters.", blocked: true };
  if (workBlocked(companyId, { employeeId: writer.id }).blocked) {
    return {
      message: `${writer.name} is stood down, so no letter is written until the Standdown is lifted.`,
      blocked: true,
    };
  }
  const model = await getActiveModel(writer.id);
  if (!model || !isModelConnected(model)) {
    return {
      message: `${writer.name} needs a connected AI Model to write the letters.`,
      blocked: false,
    };
  }
  return { message: null, blocked: false };
}

async function hydrateSettings(
  companyId: string,
  settings: BoardLetterSettings | null,
  now: Date,
): Promise<BoardLetterSettingsDTO> {
  const timeZone = await companyTimeZone(companyId);
  const closed = latestClosedMonth(now, timeZone);
  const employees = AppDataSource.getRepository(AIEmployee);
  const [writer, auditor, appointer, lastLetter] = await Promise.all([
    settings?.writerEmployeeId
      ? employees.findOneBy({ id: settings.writerEmployeeId, companyId })
      : Promise.resolve(null),
    settings?.auditorEmployeeId
      ? employees.findOneBy({ id: settings.auditorEmployeeId, companyId })
      : Promise.resolve(null),
    settings?.auditorAppointedByUserId
      ? AppDataSource.getRepository(User).findOne({
          where: { id: settings.auditorAppointedByUserId },
          select: { id: true, name: true, email: true },
        })
      : Promise.resolve(null),
    AppDataSource.getRepository(BoardLetter).findOne({
      where: { companyId, month: closed.month },
      select: { id: true, number: true, status: true, startedAt: true, retryAt: true },
    }),
  ]);
  const waiting = await writerWaiting(companyId, writer);
  let nextLetter: BoardLetterSettingsDTO["nextLetter"] = null;
  if (settings?.enabled && writer) {
    const retryAt = lastLetter?.status === "failed" ? lastLetter.retryAt : null;
    const owedNow = isOwed(settings, closed) && (!lastLetter || retryAt !== null);
    const month = owedNow ? closed : monthContaining(now, timeZone);
    const due = owedNow && retryAt ? retryAt : letterDueAt(month, timeZone);
    nextLetter = {
      month: month.month,
      label: monthLabel(month.month),
      dueAt: new Date(Math.max(due.getTime(), now.getTime())).toISOString(),
    };
  }
  // A letter being written, or one whose audit is finishing, is not asked for
  // again; a writing step a dead process abandoned may be.
  const inFlight =
    lastLetter?.status === "auditing" ||
    (lastLetter?.status === "writing" && !isStale(lastLetter as BoardLetter, now));
  return {
    enabled: settings?.enabled ?? false,
    enabledAt: settings?.enabledAt?.toISOString() ?? null,
    writer: writer ? employeeSnapshot(writer) : null,
    auditor: auditor ? employeeSnapshot(auditor) : null,
    auditorAppointedAt: auditor ? (settings?.auditorAppointedAt?.toISOString() ?? null) : null,
    auditorAppointedBy:
      auditor && appointer ? { id: appointer.id, name: appointer.name || appointer.email } : null,
    timeZone,
    lastMonth: {
      month: closed.month,
      label: monthLabel(closed.month),
      letterNumber: lastLetter?.number ?? null,
      status: lastLetter?.status ?? null,
      canWrite: Boolean(writer) && !waiting.blocked && lastLetter?.status !== "ready" && !inFlight,
    },
    nextLetter,
    waiting: waiting.message,
    lastError: settings?.lastError ?? "",
  };
}

export async function getBoardLetterSettings(
  companyId: string,
  now: Date = new Date(),
): Promise<BoardLetterSettingsDTO> {
  const settings = await AppDataSource.getRepository(BoardLetterSettings).findOneBy({ companyId });
  return hydrateSettings(companyId, settings, now);
}

async function companyEmployee(companyId: string, id: string, role: string): Promise<AIEmployee> {
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({ id, companyId });
  if (!employee) throw new BoardLetterValidationError(`Choose ${role} from this company.`);
  return employee;
}

/**
 * Choose the writer, appoint the auditor, and switch letters on or off.
 * Owners and admins only — the route enforces it — and recorded in the audit
 * log with who made the change, because who appointed the auditor is part of
 * what makes the audit worth reading.
 */
export async function updateBoardLetterSettings(
  companyId: string,
  input: BoardLetterSettingsInput,
  actorUserId: string,
  now: Date = new Date(),
): Promise<BoardLetterSettingsDTO> {
  if (input.enabled && !input.writerEmployeeId) {
    throw new BoardLetterValidationError(
      "Choose an AI Employee to write the letters before switching them on.",
    );
  }
  if (
    input.writerEmployeeId &&
    input.auditorEmployeeId &&
    input.writerEmployeeId === input.auditorEmployeeId
  ) {
    throw new BoardLetterValidationError(
      "Appoint an auditor other than the writer: no one audits their own letter.",
    );
  }
  const writer = input.writerEmployeeId
    ? await companyEmployee(companyId, input.writerEmployeeId, "a writer")
    : null;
  const auditor = input.auditorEmployeeId
    ? await companyEmployee(companyId, input.auditorEmployeeId, "an auditor")
    : null;
  const timeZone = await companyTimeZone(companyId);

  const { saved, auditorChanged } = await withSerializedTransaction(async (manager) => {
    const settings = await ensureLockedSettings(manager, companyId);
    const auditorChanged = settings.auditorEmployeeId !== (auditor?.id ?? null);
    if (input.enabled && !settings.enabled) settings.enabledAt = now;
    settings.enabled = input.enabled;
    settings.writerEmployeeId = writer?.id ?? null;
    if (auditorChanged) {
      settings.auditorEmployeeId = auditor?.id ?? null;
      settings.auditorAppointedByUserId = auditor ? actorUserId : null;
      settings.auditorAppointedAt = auditor ? now : null;
    }
    settings.lastError = "";
    settings.nextLetterAt = await computeNextLetterAt(manager, settings, timeZone, now);
    return {
      saved: await manager.getRepository(BoardLetterSettings).save(settings),
      auditorChanged,
    };
  });

  announce(companyId);
  await recordAudit({
    companyId,
    actorUserId,
    action: "board_letter.settings.update",
    targetType: "board_letter_settings",
    targetId: saved.id,
    targetLabel: "Letters to the board",
    metadata: {
      enabled: saved.enabled,
      writerEmployeeId: saved.writerEmployeeId,
      auditorEmployeeId: saved.auditorEmployeeId,
    },
  });
  if (auditorChanged) {
    await recordAudit({
      companyId,
      actorUserId,
      action: auditor ? "board_letter.auditor.appoint" : "board_letter.auditor.remove",
      targetType: "ai_employee",
      targetId: auditor?.id ?? null,
      targetLabel: auditor?.name ?? "No auditor",
    });
  }
  return hydrateSettings(companyId, saved, now);
}

// ─────────────────────────────── Writing ─────────────────────────────────

async function settleFailed(letter: BoardLetter, error: unknown, now: Date): Promise<void> {
  const message = errorText(error) || "The letter could not be written.";
  const retryable = !(error instanceof BoardLetterWriterUnavailableError);
  const retryAt =
    letter.triggerKind === "schedule" && retryable && letter.attempts < MAX_SCHEDULED_ATTEMPTS
      ? new Date(now.getTime() + RETRY_DELAY_MS)
      : null;
  const updated = await AppDataSource.getRepository(BoardLetter).update(
    { id: letter.id, status: "writing", attempts: letter.attempts },
    { status: "failed", errorMessage: message, retryAt },
  );
  if (updated.affected !== 1) return;
  const timeZone = await companyTimeZone(letter.companyId);
  await withSerializedTransaction(async (manager) => {
    const settings = await lockedSettings(manager, letter.companyId);
    if (!settings) return;
    settings.lastError = `Letter No. ${letter.number}, for ${monthLabel(letter.month)}: ${message}`;
    // The retry, when one is owed; otherwise the next month's letter.
    settings.nextLetterAt = await computeNextLetterAt(manager, settings, timeZone, now);
    await manager.getRepository(BoardLetterSettings).save(settings);
  });
  announce(letter.companyId);
}

async function clearLastError(companyId: string): Promise<void> {
  await AppDataSource.getRepository(BoardLetterSettings).update({ companyId }, { lastError: "" });
}

function letterContext(
  letter: BoardLetter,
  name: string,
  figures: LetterFigures,
  evidence: LetterEvidence,
): LetterContext {
  return {
    companyName: name,
    letterNumber: letter.number,
    monthLabel: monthLabel(letter.month),
    figures,
    evidence,
  };
}

async function runAuditStep(args: {
  companyId: string;
  letterId: string;
  auditor: AIEmployee;
  writerEmployeeId: string | null;
  writerName: string;
  context: LetterContext;
  letter: { summary: string; body: string };
  untraced: readonly TraceToken[];
  dependencies: BoardLetterDependencies;
}): Promise<void> {
  const audit = await auditBoardLetter({
    auditor: args.auditor,
    writerEmployeeId: args.writerEmployeeId,
    writerName: args.writerName,
    context: args.context,
    letter: args.letter,
    untraced: args.untraced,
    dependencies: { runRestricted: args.dependencies.runRestricted },
  });
  await AppDataSource.getRepository(BoardLetter).update(
    { id: args.letterId, status: "auditing", auditStatus: "pending" },
    {
      status: "ready",
      auditStatus: audit.status,
      auditNote: audit.note,
      auditFindingsJson: JSON.stringify(audit.findings),
      auditedAt: args.dependencies.now?.() ?? new Date(),
    },
  );
  announce(args.companyId);
}

/** Steps 1–5 for a claimed letter. Never throws; a failure settles the letter. */
async function completeLetter(
  claim: LetterClaim,
  dependencies: BoardLetterDependencies,
): Promise<BoardLetter | null> {
  const clock = () => dependencies.now?.() ?? new Date();
  const repo = AppDataSource.getRepository(BoardLetter);
  const { letter, writer, month } = claim;
  const fence = { id: letter.id, status: "writing" as const, attempts: letter.attempts };
  try {
    const figures = await collectLetterFigures({
      companyId: letter.companyId,
      month,
      timeZone: letter.timeZone,
      now: clock(),
    });
    const evidence = await collectLetterEvidence({
      companyId: letter.companyId,
      month,
      goalIds: figures.goals.map((goal) => goal.id),
    });
    // Stored before the writer starts, so the page shows the figures while
    // the prose is still being drafted.
    const stored = await repo.update(fence, {
      figuresJson: JSON.stringify(figures),
      evidenceJson: JSON.stringify(evidence),
    });
    if (stored.affected !== 1) return null;
    announce(letter.companyId);

    const context = letterContext(letter, claim.companyName, figures, evidence);
    const written = await writeBoardLetter(writer, context, {
      runRestricted: dependencies.runRestricted,
    });
    const options = { letterNumber: letter.number, year: Number(letter.month.slice(0, 4)) };
    const traces: BoardLetterTraces = {
      summary: traceLetter(written.summary, figures.figures, options),
      body: traceLetter(written.body, figures.figures, options),
    };
    const untraced = untracedOf(traces);
    const auditor = await appointedAuditor(letter.companyId, writer.id);
    const writtenAt = clock();
    const settled = await repo.update(fence, {
      summary: written.summary,
      body: written.body,
      traceJson: JSON.stringify(traces),
      untracedCount: untraced.length,
      writtenAt,
      // The audit step's own clock: what the stale sweep measures from.
      startedAt: writtenAt,
      errorMessage: "",
      retryAt: null,
      status: auditor ? "auditing" : "ready",
      auditStatus: auditor ? "pending" : "not_appointed",
      ...(auditor ? auditorColumns(auditor) : {}),
    });
    if (settled.affected !== 1) return null;
    announce(letter.companyId);

    if (auditor) {
      await runAuditStep({
        companyId: letter.companyId,
        letterId: letter.id,
        auditor,
        writerEmployeeId: writer.id,
        writerName: writer.name,
        context,
        letter: written,
        untraced,
        dependencies,
      });
    }
    await (dependencies.deliver ?? deliverBoardLetter)(letter.id, clock());
    await clearLastError(letter.companyId);
    return repo.findOneBy({ id: letter.id });
  } catch (error) {
    await settleFailed(letter, error, clock()).catch((settleError: unknown) => {
      // eslint-disable-next-line no-console
      console.error(`[board-letters] could not record the failure of ${letter.id}:`, settleError);
    });
    // eslint-disable-next-line no-console
    console.error(`[board-letters] letter ${letter.id} could not be written:`, error);
    return null;
  }
}

/**
 * Claim the letter the schedule owes `companyId` right now, if it owes one.
 * Advances the scheduler cursor whatever happens, so a row that is due and
 * owes nothing is not looked at again until it might.
 */
async function claimScheduledLetter(companyId: string, now: Date): Promise<LetterClaim | null> {
  const timeZone = await companyTimeZone(companyId);
  const name = await companyName(companyId);
  return withSerializedTransaction(async (manager) => {
    const settings = await lockedSettings(manager, companyId);
    if (!settings) return null;
    const settingsRepo = manager.getRepository(BoardLetterSettings);
    const month = latestClosedMonth(now, timeZone);
    const due = isOwed(settings, month) && letterDueAt(month, timeZone).getTime() <= now.getTime();
    const existing = due
      ? await manager.getRepository(BoardLetter).findOneBy({ companyId, month: month.month })
      : null;
    const retryDue =
      existing?.status === "failed" &&
      existing.retryAt !== null &&
      existing.retryAt.getTime() <= now.getTime();
    if (!settings.enabled || !settings.writerEmployeeId || !due || (existing && !retryDue)) {
      settings.nextLetterAt = await computeNextLetterAt(manager, settings, timeZone, now);
      await settingsRepo.save(settings);
      return null;
    }
    const writer = await manager
      .getRepository(AIEmployee)
      .findOneBy({ id: settings.writerEmployeeId, companyId });
    if (!writer) {
      settings.enabled = false;
      settings.writerEmployeeId = null;
      settings.nextLetterAt = null;
      settings.lastError = "Choose another AI Employee to write the letters.";
      await settingsRepo.save(settings);
      return null;
    }
    if (workBlocked(companyId, { employeeId: writer.id }).blocked) {
      // A Standdown is waited out, never worked around: look again shortly,
      // and write the letter once a person lifts it.
      settings.lastError = `${writer.name} is stood down, so the letter for ${monthLabel(month.month)} waits until the Standdown is lifted.`;
      settings.nextLetterAt = new Date(now.getTime() + STANDDOWN_RECHECK_MS);
      await settingsRepo.save(settings);
      return null;
    }
    const letter = await beginLetter(manager, {
      companyId,
      month,
      timeZone,
      writer,
      trigger: "schedule",
      existing,
      now,
    });
    settings.lastError = "";
    settings.nextLetterAt = letterDueAt(monthContaining(now, timeZone), timeZone);
    await settingsRepo.save(settings);
    return { letter, writer, companyName: name, month };
  });
}

export type BoardLetterDispatchResult = {
  started: number;
  completions: Array<Promise<BoardLetter | null>>;
};

/** The heartbeat's pass: start every letter that is due. Never waits for prose. */
export async function dispatchDueBoardLetters(
  now: Date = new Date(),
  dependencies: BoardLetterDependencies = {},
  assertLeaseHeld: () => void = () => undefined,
): Promise<BoardLetterDispatchResult> {
  const repo = AppDataSource.getRepository(BoardLetterSettings);
  const due = await repo.find({
    where: { enabled: true, nextLetterAt: LessThanOrEqual(now) },
    order: { nextLetterAt: "ASC" },
    take: MAX_DISPATCH_PER_TICK,
  });
  const completions: Array<Promise<BoardLetter | null>> = [];
  for (const settings of due) {
    assertLeaseHeld();
    try {
      const claim = await claimScheduledLetter(settings.companyId, now);
      announce(settings.companyId);
      if (claim) completions.push(completeLetter(claim, dependencies));
    } catch (error) {
      // A claim that keeps failing must not be retried on every heartbeat.
      await repo.update(
        { id: settings.id },
        { nextLetterAt: new Date(now.getTime() + RETRY_DELAY_MS), lastError: errorText(error) },
      );
      // eslint-disable-next-line no-console
      console.error(`[board-letters] could not claim a letter for ${settings.companyId}:`, error);
    }
  }
  return { started: completions.length, completions };
}

/**
 * A person asking for the month just ended now, rather than at 06:00 on the
 * first: the way to have a letter for a month that ended before letters were
 * switched on, or to try a failed one again. Starts the work and returns at
 * once; `completion` settles when the letter is finished or has failed.
 */
export async function writeBoardLetterNow(
  companyId: string,
  actorUserId: string,
  dependencies: BoardLetterDependencies = {},
): Promise<{ letter: BoardLetter; completion: Promise<BoardLetter | null> }> {
  const now = dependencies.now?.() ?? new Date();
  const timeZone = await companyTimeZone(companyId);
  const name = await companyName(companyId);
  const claim = await withSerializedTransaction(async (manager) => {
    const settings = await lockedSettings(manager, companyId);
    if (!settings?.writerEmployeeId) {
      throw new BoardLetterValidationError("Choose an AI Employee to write the letters first.");
    }
    const writer = await manager
      .getRepository(AIEmployee)
      .findOneBy({ id: settings.writerEmployeeId, companyId });
    if (!writer)
      throw new BoardLetterValidationError("Choose another AI Employee to write the letters.");
    const block = workBlocked(companyId, { employeeId: writer.id });
    if (block.blocked) {
      throw new BoardLetterConflictError(
        `${writer.name} is stood down. Lift the Standdown before asking for a letter.`,
      );
    }
    const month = latestClosedMonth(now, timeZone);
    const existing = await manager
      .getRepository(BoardLetter)
      .findOneBy({ companyId, month: month.month });
    if (existing?.status === "ready") {
      throw new BoardLetterConflictError(
        `Letter No. ${existing.number}, for ${monthLabel(month.month)}, is already written.`,
      );
    }
    if (existing && existing.status !== "failed" && !isStale(existing, now)) {
      throw new BoardLetterConflictError(`Letter No. ${existing.number} is already being written.`);
    }
    if (existing?.status === "auditing") {
      throw new BoardLetterConflictError(
        `Letter No. ${existing.number} is written; its audit is being finished.`,
      );
    }
    const letter = await beginLetter(manager, {
      companyId,
      month,
      timeZone,
      writer,
      trigger: "manual",
      existing,
      now,
    });
    settings.lastError = "";
    settings.nextLetterAt = await computeNextLetterAt(manager, settings, timeZone, now);
    await manager.getRepository(BoardLetterSettings).save(settings);
    return { letter, writer, companyName: name, month };
  });
  announce(companyId);
  await recordAudit({
    companyId,
    actorUserId,
    action: "board_letter.write",
    targetType: "board_letter",
    targetId: claim.letter.id,
    targetLabel: `Letter No. ${claim.letter.number}, ${monthLabel(claim.letter.month)}`,
  });
  return { letter: claim.letter, completion: completeLetter(claim, dependencies) };
}

/**
 * Ask the auditor again, for a letter that has no opinion: one written before
 * an auditor was appointed, or whose audit could not run. A letter that has
 * the auditor's opinion keeps it — asking until the answer changes is not an
 * audit.
 */
export async function auditBoardLetterAgain(
  companyId: string,
  number: number,
  actorUserId: string,
  dependencies: BoardLetterDependencies = {},
): Promise<{ letter: BoardLetter; completion: Promise<void> }> {
  const now = dependencies.now?.() ?? new Date();
  const repo = AppDataSource.getRepository(BoardLetter);
  const letter = await repo.findOneBy({ companyId, number });
  if (!letter) throw new BoardLetterNotFoundError("No such letter.");
  if (letter.status !== "ready") {
    throw new BoardLetterConflictError("The letter is not finished yet.");
  }
  if (letter.auditStatus !== "unverified" && letter.auditStatus !== "not_appointed") {
    throw new BoardLetterConflictError("This letter already has the auditor's opinion.");
  }
  const auditor = await appointedAuditor(companyId, letter.writerEmployeeId);
  if (!auditor)
    throw new BoardLetterValidationError("Appoint an auditor other than the writer first.");
  const claimed = await repo.update(
    { id: letter.id, status: "ready", auditStatus: In(["unverified", "not_appointed"]) },
    {
      status: "auditing",
      auditStatus: "pending",
      startedAt: now,
      auditNote: "",
      auditFindingsJson: "[]",
      auditedAt: null,
      ...auditorColumns(auditor),
    },
  );
  if (claimed.affected !== 1) throw new BoardLetterConflictError("The letter changed; try again.");
  announce(companyId);
  const current = await repo.findOneBy({ id: letter.id });
  if (!current) throw new BoardLetterNotFoundError("No such letter.");
  await recordAudit({
    companyId,
    actorUserId,
    action: "board_letter.audit",
    targetType: "board_letter",
    targetId: letter.id,
    targetLabel: `Letter No. ${letter.number}, ${monthLabel(letter.month)}`,
    metadata: { auditorEmployeeId: auditor.id },
  });
  const figures = parseJson<LetterFigures | null>(letter.figuresJson, null);
  const evidence = parseJson<LetterEvidence | null>(letter.evidenceJson, null);
  const completion = (async () => {
    if (!figures || !evidence) {
      await repo.update(
        { id: letter.id, status: "auditing", auditStatus: "pending" },
        {
          status: "ready",
          auditStatus: "unverified",
          auditNote: "No audit: the letter's figures could not be read.",
          auditedAt: dependencies.now?.() ?? new Date(),
        },
      );
      announce(companyId);
      return;
    }
    await runAuditStep({
      companyId,
      letterId: letter.id,
      auditor,
      writerEmployeeId: letter.writerEmployeeId,
      writerName: letter.writerName,
      context: letterContext(letter, await companyName(companyId), figures, evidence),
      letter: { summary: letter.summary, body: letter.body },
      untraced: untracedOf(tracesOf(letter)),
      dependencies,
    });
  })().catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error(`[board-letters] could not audit letter ${letter.id}:`, error);
  });
  return { letter: current, completion };
}

// ─────────────────────────────── Recovery ────────────────────────────────

/**
 * Settle steps a dead process left behind. A letter still `writing` past the
 * stale window failed (and is retried like any failure); one still `auditing`
 * is finished as unverified — nobody audited it — and sent to the board.
 */
export async function reconcileStaleBoardLetters(
  now: Date = new Date(),
  dependencies: BoardLetterDependencies = {},
): Promise<number> {
  const repo = AppDataSource.getRepository(BoardLetter);
  const stale = await repo.find({
    where: {
      status: In(["writing", "auditing"]),
      startedAt: LessThan(new Date(now.getTime() - STALE_STEP_MS)),
    },
  });
  for (const letter of stale) {
    if (letter.status === "writing") {
      await settleFailed(letter, new Error("Writing was interrupted before it finished."), now);
      continue;
    }
    const finished = await repo.update(
      { id: letter.id, status: "auditing", auditStatus: "pending" },
      {
        status: "ready",
        auditStatus: "unverified",
        auditNote: "No audit: the audit was interrupted before it finished.",
        auditedAt: now,
      },
    );
    if (finished.affected !== 1) continue;
    announce(letter.companyId);
    await (dependencies.deliver ?? deliverBoardLetter)(letter.id, now);
  }
  return stale.length;
}

/**
 * Recompute every enabled company's cursor: at boot, after a restore, or for
 * one company whose time zone just changed (and so whose first of the month
 * moved).
 */
export async function rescheduleBoardLetters(
  now: Date = new Date(),
  companyId?: string,
): Promise<void> {
  const rows = await AppDataSource.getRepository(BoardLetterSettings).find({
    where: companyId ? { companyId, enabled: true } : { enabled: true },
    select: { id: true, companyId: true },
  });
  for (const row of rows) {
    const timeZone = await companyTimeZone(row.companyId);
    await withSerializedTransaction(async (manager) => {
      const settings = await lockedSettings(manager, row.companyId);
      if (!settings?.enabled) return;
      settings.nextLetterAt = await computeNextLetterAt(manager, settings, timeZone, now);
      await manager.getRepository(BoardLetterSettings).save(settings);
    });
  }
}

/**
 * An AI Employee is being deleted. Letters keep their snapshot of it; the
 * settings stop pointing at it, and a deleted writer switches letters off
 * until a person chooses another.
 */
export async function detachEmployeeFromBoardLetters(
  companyId: string,
  employeeId: string,
): Promise<void> {
  await withSerializedTransaction(async (manager) => {
    const settings = await lockedSettings(manager, companyId);
    if (
      settings &&
      (settings.writerEmployeeId === employeeId || settings.auditorEmployeeId === employeeId)
    ) {
      if (settings.writerEmployeeId === employeeId) {
        settings.writerEmployeeId = null;
        settings.enabled = false;
        settings.nextLetterAt = null;
        settings.lastError =
          "The writer was deleted. Choose another AI Employee to write the letters.";
      }
      if (settings.auditorEmployeeId === employeeId) {
        settings.auditorEmployeeId = null;
        settings.auditorAppointedByUserId = null;
        settings.auditorAppointedAt = null;
      }
      await manager.getRepository(BoardLetterSettings).save(settings);
    }
    const letters = manager.getRepository(BoardLetter);
    await letters.update({ companyId, writerEmployeeId: employeeId }, { writerEmployeeId: null });
    await letters.update({ companyId, auditorEmployeeId: employeeId }, { auditorEmployeeId: null });
  });
  announce(companyId);
}

// ─────────────────────────────── Reading ─────────────────────────────────

function writerOf(letter: BoardLetter): BoardLetterEmployee {
  return {
    id: letter.writerEmployeeId,
    name: letter.writerName,
    role: letter.writerRole,
    slug: letter.writerSlug,
    avatarKey: letter.writerAvatarKey,
  };
}

function auditorOf(letter: BoardLetter): BoardLetterEmployee | null {
  if (!letter.auditorName) return null;
  return {
    id: letter.auditorEmployeeId,
    name: letter.auditorName,
    role: letter.auditorRole,
    slug: letter.auditorSlug,
    avatarKey: letter.auditorAvatarKey,
  };
}

export function serializeBoardLetterSummary(letter: BoardLetter): BoardLetterSummaryDTO {
  return {
    id: letter.id,
    number: letter.number,
    month: letter.month,
    monthLabel: monthLabel(letter.month),
    status: letter.status,
    auditStatus: letter.auditStatus,
    summary: letter.summary,
    untracedCount: letter.untracedCount,
    findingsCount: parseJson<AuditFinding[]>(letter.auditFindingsJson, []).length,
    writer: writerOf(letter),
    auditor: auditorOf(letter),
    triggerKind: letter.triggerKind,
    attempts: letter.attempts,
    retryAt: letter.retryAt?.toISOString() ?? null,
    errorMessage: letter.errorMessage,
    createdAt: letter.createdAt.toISOString(),
    writtenAt: letter.writtenAt?.toISOString() ?? null,
    auditedAt: letter.auditedAt?.toISOString() ?? null,
    deliveredAt: letter.deliveredAt?.toISOString() ?? null,
  };
}

export function serializeBoardLetter(letter: BoardLetter): BoardLetterDTO {
  const figures = parseJson<LetterFigures | null>(letter.figuresJson, null);
  const evidence = parseJson<LetterEvidence | null>(letter.evidenceJson, null);
  return {
    ...serializeBoardLetterSummary(letter),
    periodStart: letter.periodStart.toISOString(),
    periodEnd: letter.periodEnd.toISOString(),
    timeZone: letter.timeZone,
    body: letter.body,
    // Empty objects are what a letter claimed but not yet computed stores.
    figures: figures && Array.isArray(figures.figures) ? figures : null,
    evidence: evidence && Array.isArray(evidence.briefings) ? evidence : null,
    trace: tracesOf(letter),
    audit: {
      note: letter.auditNote,
      findings: parseJson<AuditFinding[]>(letter.auditFindingsJson, []),
    },
  };
}

/** Every letter the company has, newest first. One a month, so never many. */
export async function listBoardLetters(companyId: string): Promise<BoardLetterSummaryDTO[]> {
  const letters = await AppDataSource.getRepository(BoardLetter).find({
    where: { companyId },
    order: { number: "DESC" },
    select: {
      id: true,
      companyId: true,
      number: true,
      month: true,
      status: true,
      auditStatus: true,
      summary: true,
      untracedCount: true,
      auditFindingsJson: true,
      writerEmployeeId: true,
      writerName: true,
      writerRole: true,
      writerSlug: true,
      writerAvatarKey: true,
      auditorEmployeeId: true,
      auditorName: true,
      auditorRole: true,
      auditorSlug: true,
      auditorAvatarKey: true,
      triggerKind: true,
      attempts: true,
      retryAt: true,
      errorMessage: true,
      createdAt: true,
      writtenAt: true,
      auditedAt: true,
      deliveredAt: true,
    },
  });
  return letters.map(serializeBoardLetterSummary);
}

export async function getBoardLetter(companyId: string, number: number): Promise<BoardLetterDTO> {
  const letter = await AppDataSource.getRepository(BoardLetter).findOneBy({ companyId, number });
  if (!letter) throw new BoardLetterNotFoundError("No such letter.");
  return serializeBoardLetter(letter);
}
