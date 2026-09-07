import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import type { Repository } from "../db/entities/Repository.js";
import {
  RepositoryWorkSession,
  type RepositoryWorkSessionStatus,
} from "../db/entities/RepositoryWorkSession.js";
import { RepositoryWorkSessionEvent } from "../db/entities/RepositoryWorkSessionEvent.js";
import { RepositoryWorkSessionTurn } from "../db/entities/RepositoryWorkSessionTurn.js";

/**
 * What AI Employees have actually done in one Repository.
 *
 * The Repository Overview page used to answer "what is this repository" —
 * default branch, sign-in mode, command mode, a README. Every one of those is
 * a setting somebody chose once, and a page made of them tells a returning
 * reader nothing about the only thing that changes here on its own: the work.
 * This module is the other answer. It reads the rows the server wrote while
 * employees worked — sessions, their turns, and the activity events of a turn
 * in flight — and digests them into the few numbers and sentences a person
 * wants at a glance.
 *
 * Two rules shape it.
 *
 * **The list is slim and the counts are not.** A repository can hold hundreds
 * of sessions, each carrying a 20 KB instruction and a report. Shipping them
 * all to draw four numbers would be absurd, so the tallies are computed from a
 * projection with no prose in it, and only the two dozen sessions the page
 * actually lists come back whole.
 *
 * **A cap is never silent.** {@link RepositoryAiOverview.capped} says when the
 * tallies stopped counting, because a number that quietly means "the first
 * 2,000" is worse than one that says so.
 *
 * Everything below is either a pure function over rows or a thin query that
 * feeds one, which is what makes the wording and the arithmetic testable
 * without a repository on disk.
 */

/** Sessions whose tallies are counted. Beyond this the answer says it stopped. */
export const AI_OVERVIEW_STAT_LIMIT = 2_000;

/** Sessions the page lists at once. The rest are one click away on AI work. */
export const AI_OVERVIEW_LIST_LIMIT = 24;

/** Finished sessions kept in that list — the tail is history, not a queue. */
export const AI_OVERVIEW_RECENT_LIMIT = 6;

/** Activity events read back to describe a turn in flight. */
const ACTIVITY_TAIL = 40;

/**
 * Characters of the opening instruction carried on a listed session.
 *
 * The list uses it for one thing — the title of a session nobody renamed — and
 * an instruction may be twenty thousand characters. This endpoint is re-read on
 * every activity event of a running turn, so shipping the whole brief two dozen
 * times over would put megabytes on the wire to draw a line of text.
 */
const TITLE_FALLBACK_CHARS = 200;

/**
 * The columns the tallies need. No `instruction`, no `reply`, no `error` —
 * the arithmetic never reads prose, and leaving it out is what lets the limit
 * above be two thousand rather than twenty.
 */
export type RepositoryAiSessionStat = {
  id: string;
  employeeId: string;
  status: RepositoryWorkSessionStatus;
  archivedAt: Date | string | null;
  turnCount: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
  /** A `Date` from TypeORM; a string is tolerated because drivers differ. */
  updatedAt: Date | string;
};

/**
 * How many sessions sit in each state.
 *
 * `running`, `attention` and `completed` partition the sessions that are *not*
 * archived, and `archived` is the rest — so the four add up to `total` exactly
 * once. Filing a session away is a statement about a list rather than about
 * the work, which is why it takes the row out of the queues instead of
 * inventing a fifth outcome for it.
 */
export type RepositoryAiCounts = {
  /** Every session ever opened here, archived ones included. */
  total: number;
  /** Turns in flight right now. */
  running: number;
  /** Finished, not filed away, and waiting on a human. */
  attention: number;
  /** Accepted or thrown away — the decision has been made. */
  completed: number;
  /** Filed out of the inbox. Not a state of the work, a state of the list. */
  archived: number;
};

/**
 * What AI work has actually put into this repository.
 *
 * Only `published` sessions count. A branch a Member never accepted changed
 * nothing here, and counting it would turn this into a measure of how much the
 * employees typed rather than how much of it was any good.
 */
export type RepositoryAiLanded = {
  sessions: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
};

/** One employee's tally in this repository, keyed for the client to join. */
export type RepositoryAiEmployeeWork = {
  employeeId: string;
  sessions: number;
  landed: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
  lastActiveAt: string | null;
};

/** Where a turn in flight has got to, as the overview shows it. */
export type RepositoryAiStepProgress = {
  done: number;
  total: number;
  /** The step being worked on, when the employee marked one. */
  current: string | null;
};

/** The live line for one running session. */
export type RepositoryAiActivity = {
  sessionId: string;
  /** The newest thing worth reading: "Ran npm test → Exit 1", "Read src/app.ts". */
  summary: string;
  at: string | null;
  steps: RepositoryAiStepProgress | null;
  /** Tool calls the turn in flight has made. */
  toolCalls: number;
};

/**
 * A session as the overview lists it.
 *
 * Deliberately not the whole row. The page needs a name, a state, a diffstat
 * and a link; it never shows the employee's report, the failure text, or the
 * brief in full — and those three are the only large fields on the entity.
 * `instruction` survives, clipped, because a session nobody renamed is titled
 * from it.
 */
export type RepositoryAiSessionRow = {
  id: string;
  employeeId: string;
  status: RepositoryWorkSessionStatus;
  title: string;
  /** The opening instruction, clipped to {@link TITLE_FALLBACK_CHARS}. */
  instruction: string;
  branch: string | null;
  turnCount: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
  publishedBranch: string | null;
  pullRequestUrl: string | null;
  pullRequestNumber: number | null;
  finishedAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  employee: { id: string; name: string; slug: string; avatarKey: string | null } | null;
};

export type RepositoryAiOverview = {
  counts: RepositoryAiCounts;
  landed: RepositoryAiLanded;
  /** Instructions given across every session, and the work thrown away. */
  totals: { turns: number; discarded: number };
  /** The most recent moment any session here moved. */
  lastActiveAt: string | null;
  employees: RepositoryAiEmployeeWork[];
  /** True when the tallies stopped at {@link AI_OVERVIEW_STAT_LIMIT}. */
  capped: boolean;
  /** The sessions the page lists, already in display order. */
  sessions: RepositoryAiSessionRow[];
  activity: RepositoryAiActivity[];
};

/**
 * Which of the three overview groups a status belongs to.
 *
 * Deliberately the same split the AI work inbox uses: `running` is live,
 * `published` / `discarded` are decided, and everything else — including
 * `empty`, which is a finished answer of "nothing to change" — is a session
 * whose next move belongs to a human.
 */
export function aiOverviewGroup(
  status: RepositoryWorkSessionStatus,
): "running" | "attention" | "completed" {
  if (status === "running") return "running";
  if (status === "published" || status === "discarded") return "completed";
  return "attention";
}

/** Whether a session has been filed out of the inbox. */
function archived(row: { archivedAt: Date | string | null }): boolean {
  return row.archivedAt !== null && row.archivedAt !== undefined;
}

/**
 * The tallies, from the projection alone.
 *
 * The three queue counts skip archived rows for the reason the inbox does:
 * archiving is a Member saying "this wants nothing from me", and a queue that
 * counts them is a queue nobody can empty. `total`, `landed` and the
 * per-employee tallies count everything, because filing a session away does
 * not un-write the commits it landed.
 */
export function summarizeRepositoryAiWork(rows: readonly RepositoryAiSessionStat[]): {
  counts: RepositoryAiCounts;
  landed: RepositoryAiLanded;
  totals: { turns: number; discarded: number };
  lastActiveAt: string | null;
  employees: RepositoryAiEmployeeWork[];
} {
  const counts: RepositoryAiCounts = {
    total: rows.length,
    running: 0,
    attention: 0,
    completed: 0,
    archived: 0,
  };
  const landed: RepositoryAiLanded = { sessions: 0, filesChanged: 0, insertions: 0, deletions: 0 };
  const totals = { turns: 0, discarded: 0 };
  const byEmployee = new Map<string, RepositoryAiEmployeeWork>();
  let lastActive: number | null = null;

  for (const row of rows) {
    const group = aiOverviewGroup(row.status);
    if (archived(row)) counts.archived += 1;
    else counts[group] += 1;

    totals.turns += row.turnCount;
    if (row.status === "discarded") totals.discarded += 1;

    const employee = byEmployee.get(row.employeeId) ?? {
      employeeId: row.employeeId,
      sessions: 0,
      landed: 0,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      lastActiveAt: null,
    };
    employee.sessions += 1;

    if (row.status === "published") {
      landed.sessions += 1;
      landed.filesChanged += row.filesChanged;
      landed.insertions += row.insertions;
      landed.deletions += row.deletions;
      employee.landed += 1;
      employee.filesChanged += row.filesChanged;
      employee.insertions += row.insertions;
      employee.deletions += row.deletions;
    }

    const at = time(row.updatedAt);
    if (at > 0) {
      if (lastActive === null || at > lastActive) lastActive = at;
      const employeeAt = employee.lastActiveAt ? Date.parse(employee.lastActiveAt) : null;
      if (employeeAt === null || at > employeeAt) {
        employee.lastActiveAt = new Date(at).toISOString();
      }
    }
    byEmployee.set(row.employeeId, employee);
  }

  // Busiest first, and a stable tie-break so two employees with the same tally
  // do not swap places between two reads of the same page.
  const employees = [...byEmployee.values()].sort(
    (a, b) =>
      b.landed - a.landed ||
      b.sessions - a.sessions ||
      time(b.lastActiveAt ?? 0) - time(a.lastActiveAt ?? 0) ||
      a.employeeId.localeCompare(b.employeeId),
  );

  return {
    counts,
    landed,
    totals,
    lastActiveAt: lastActive === null ? null : new Date(lastActive).toISOString(),
    employees,
  };
}

/**
 * Which sessions the page lists, in the order it lists them.
 *
 * Live work first, then whatever is waiting on a human, then a short tail of
 * finished work so the page still says something on a repository where
 * everything has been decided. Archived sessions are never listed: they were
 * filed away precisely so they would stop appearing in a queue.
 */
export function pickOverviewSessionIds(rows: readonly RepositoryAiSessionStat[]): string[] {
  const newestFirst = [...rows]
    .filter((row) => !archived(row))
    .sort((a, b) => time(b.updatedAt) - time(a.updatedAt));
  const running = newestFirst.filter((row) => aiOverviewGroup(row.status) === "running");
  const attention = newestFirst.filter((row) => aiOverviewGroup(row.status) === "attention");
  const completed = newestFirst
    .filter((row) => aiOverviewGroup(row.status) === "completed")
    .slice(0, AI_OVERVIEW_RECENT_LIMIT);
  return [...running, ...attention, ...completed].slice(0, AI_OVERVIEW_LIST_LIMIT).map((r) => r.id);
}

/** A comparable instant, or 0 for anything a driver handed back unparseable. */
function time(value: Date | string | number): number {
  const at =
    value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(at) ? at : 0;
}

/**
 * The one line a running session gets, from the tail of its activity feed.
 *
 * Newest first, and the first event that says something a person can read
 * wins. Narration is used only when there is no tool line to show, because
 * "Ran npm test → Exit 1" is a fact and "Now I will check the tests" is an
 * intention. A `steps` event is never the line: its progress is reported
 * separately and its summary would say the same thing twice.
 */
export function activitySummary(
  events: ReadonlyArray<Pick<RepositoryWorkSessionEvent, "kind" | "summary" | "detailJson">>,
): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.kind === "steps") continue;
    const summary = event.summary.trim();
    if (summary) return summary;
    if (event.kind === "text") {
      const text = textOf(event.detailJson);
      if (text) return text;
    }
  }
  return "";
}

function textOf(detailJson: string): string {
  if (!detailJson) return "";
  try {
    const parsed = JSON.parse(detailJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
    const text = (parsed as { text?: unknown }).text;
    if (typeof text !== "string") return "";
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > 160 ? `${flat.slice(0, 159).trimEnd()}…` : flat;
  } catch {
    return "";
  }
}

/**
 * The employee's own plan, as progress.
 *
 * The step list is the employee's, so it is read defensively: anything that is
 * not `{ text, status }` is dropped rather than trusted, and a list with no
 * usable entries is no progress at all rather than "0 of 0".
 */
export function stepProgress(detailJson: string): RepositoryAiStepProgress | null {
  if (!detailJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(detailJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const steps = (parsed as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return null;
  let done = 0;
  let total = 0;
  let current: string | null = null;
  for (const step of steps) {
    if (!step || typeof step !== "object" || Array.isArray(step)) continue;
    const { text, status } = step as { text?: unknown; status?: unknown };
    if (typeof text !== "string" || typeof status !== "string") continue;
    if (status !== "pending" && status !== "in_progress" && status !== "completed") continue;
    total += 1;
    if (status === "completed") done += 1;
    if (status === "in_progress" && current === null) current = text.trim() || null;
  }
  return total === 0 ? null : { done, total, current };
}

/** Narrow a session to what the list draws, with the employee it was given to. */
async function toListRows(
  companyId: string,
  sessions: RepositoryWorkSession[],
): Promise<RepositoryAiSessionRow[]> {
  if (sessions.length === 0) return [];
  const employees = await AppDataSource.getRepository(AIEmployee).find({
    where: { companyId, id: In([...new Set(sessions.map((s) => s.employeeId))]) },
  });
  const byId = new Map(employees.map((e) => [e.id, e]));
  return sessions.map((session) => {
    const employee = byId.get(session.employeeId);
    return {
      id: session.id,
      employeeId: session.employeeId,
      status: session.status,
      title: session.title,
      instruction: clip(session.instruction, TITLE_FALLBACK_CHARS),
      branch: session.branch,
      turnCount: session.turnCount,
      filesChanged: session.filesChanged,
      insertions: session.insertions,
      deletions: session.deletions,
      publishedBranch: session.publishedBranch,
      pullRequestUrl: session.pullRequestUrl,
      pullRequestNumber: session.pullRequestNumber,
      finishedAt: session.finishedAt,
      archivedAt: session.archivedAt,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      employee: employee
        ? {
            id: employee.id,
            name: employee.name,
            slug: employee.slug,
            avatarKey: employee.avatarKey ?? null,
          }
        : null,
    };
  });
}

/** Cut a string to a length the wire can afford, marking that it was cut. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * The live line for each running session.
 *
 * Everything here is scoped to the **turn in flight**, not to the session.
 * Events are never deleted and their ordinals run on across turns, so a
 * session-wide read would answer the second instruction with the first one's
 * finished plan — "Step 5 of 5" over a turn that has only just started — and
 * count tool calls the reader already watched happen. The turn is found first
 * and everything else is asked about it.
 *
 * Three small reads per running session; a session listed as running always
 * gets an entry, so a missing line is only ever "nothing has happened yet".
 */
async function readActivity(sessionIds: string[]): Promise<RepositoryAiActivity[]> {
  const events = AppDataSource.getRepository(RepositoryWorkSessionEvent);
  const turns = AppDataSource.getRepository(RepositoryWorkSessionTurn);
  return Promise.all(
    sessionIds.map(async (sessionId) => {
      const turn = await turns.findOne({
        where: { sessionId },
        order: { ordinal: "DESC" },
        select: { id: true, ordinal: true },
      });
      if (!turn) return { sessionId, summary: "", at: null, steps: null, toolCalls: 0 };
      const [tail, steps, toolCalls] = await Promise.all([
        events.find({
          where: { turnId: turn.id },
          order: { ordinal: "DESC" },
          take: ACTIVITY_TAIL,
        }),
        events.findOne({
          where: { turnId: turn.id, kind: "steps" },
          order: { ordinal: "DESC" },
        }),
        events.count({ where: { turnId: turn.id, kind: "tool_use" } }),
      ]);
      const ascending = [...tail].reverse();
      const newest = ascending.length > 0 ? ascending[ascending.length - 1] : null;
      return {
        sessionId,
        summary: activitySummary(ascending),
        at: newest ? new Date(newest.createdAt).toISOString() : null,
        steps: steps ? stepProgress(steps.detailJson) : null,
        toolCalls,
      };
    }),
  );
}

/**
 * Everything the Repository Overview needs to talk about AI work.
 *
 * One projection read for the arithmetic, one full read for the two dozen
 * sessions the page lists, and a live line per running session. Nothing here
 * touches the checkout on disk — the route mounts it with `workspace: false`
 * for that reason, so an unreachable remote never hides the answer.
 */
export async function repositoryAiOverview(repo: Repository): Promise<RepositoryAiOverview> {
  const sessionRepo = AppDataSource.getRepository(RepositoryWorkSession);
  const stats: RepositoryAiSessionStat[] = await sessionRepo.find({
    where: { repositoryId: repo.id },
    select: {
      id: true,
      employeeId: true,
      status: true,
      archivedAt: true,
      turnCount: true,
      filesChanged: true,
      insertions: true,
      deletions: true,
      updatedAt: true,
    },
    order: { updatedAt: "DESC" },
    take: AI_OVERVIEW_STAT_LIMIT + 1,
  });

  const capped = stats.length > AI_OVERVIEW_STAT_LIMIT;
  const counted = capped ? stats.slice(0, AI_OVERVIEW_STAT_LIMIT) : stats;
  const summary = summarizeRepositoryAiWork(counted);

  const ids = pickOverviewSessionIds(counted);
  const rows = ids.length ? await sessionRepo.find({ where: { id: In(ids) } }) : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered = ids
    .map((id) => byId.get(id))
    .filter((row): row is RepositoryWorkSession => !!row);
  const sessions = await toListRows(repo.companyId, ordered);

  const activity = await readActivity(
    ordered.filter((row) => row.status === "running").map((row) => row.id),
  );

  return { ...summary, capped, sessions, activity };
}
