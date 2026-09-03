import { In, MoreThanOrEqual } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Approval } from "../db/entities/Approval.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Conversation } from "../db/entities/Conversation.js";
import { ConversationMessage } from "../db/entities/ConversationMessage.js";
import { EmployeeWakeup } from "../db/entities/EmployeeWakeup.js";
import { Role } from "../db/entities/Membership.js";
import { RepositoryWorkSession } from "../db/entities/RepositoryWorkSession.js";
import { RepositoryWorkSessionTurn } from "../db/entities/RepositoryWorkSessionTurn.js";
import { Routine } from "../db/entities/Routine.js";
import {
  Run,
  RunChecksVerdict,
  RunOutcomeVerdict,
  RunStatus,
  RunTrigger,
} from "../db/entities/Run.js";
import { RunLesson } from "../db/entities/RunLesson.js";
import { Todo } from "../db/entities/Todo.js";
import { redactApprovalSummary, redactSensitiveText } from "./approvalRedaction.js";
import { isVaultCaptureApproval } from "./approvals.js";
import { listAccessibleProjectIds } from "./projects.js";

/**
 * The **work timeline** — everything one AI Employee (or the whole roster)
 * actually did inside a window, newest first.
 *
 * Home could always say what was *waiting* on a human and never what the
 * workforce had *done*. The three nearest answers were each a different
 * question: the audit log is an admin-only, entitlement-gated investigation
 * tool spanning every actor; an employee's Journal is the employee narrating
 * itself; and the failed-routines alert shows only the runs that broke. A
 * company whose roster ran cleanly all night had no way to see the night.
 *
 * ## Assembled, never stored
 *
 * There is no timeline entity and no migration. The work is already on disk in
 * seven places, and a stored copy is a second record that drifts from the rows
 * it summarises — and, worse, one an employee could be given a tool to write.
 * Every entry here is read back from something the server wrote at a seam.
 *
 * `audit_events` is the spine. Since M58 those rows are the effect ledger, and
 * the `["companyId", "actorEmployeeId", "createdAt"]` index they already carry
 * is exactly this query. Six tables are unioned onto it, each because audit
 * provably misses it:
 *
 *   - `runs` — `services/runner.ts` never calls `recordAudit`, so a *scheduled*
 *     tick (the bulk of all runs) writes no audit row at all, and `status` /
 *     `outcomeVerdict` / `checksVerdict` exist nowhere else;
 *   - assistant `conversation_messages` — `services/chat.ts` audits nothing, so
 *     a chat turn is otherwise invisible;
 *   - `approvals` — creation is unaudited, and "the employee hit a gate and is
 *     blocked" is work;
 *   - fired `employee_wakeups` — `dispatchDueWakeups` audits nothing;
 *   - `run_lessons` — `services/runLessons.ts` audits nothing;
 *   - `repository_work_session_turns` — the outcome of a turn (its diff stats,
 *     its head commit) is never audited.
 *
 * Everything else an employee does — Decisions, Handoffs, Initiatives,
 * Revision proposals, Notes, Memory, mail it wrote, Revenue activity — already
 * writes exactly one `actorEmployeeId` audit row per action, so unioning those
 * tables too would double-count. Journal entries stay out on purpose: they are
 * the employee's own account, and mixing them into the server's record in one
 * list is precisely the confusion this surface exists to end. Notifications are
 * a fan-out of rows already here; Pipelines have no employee owner; a TLDR is a
 * summary *of* the window rather than work *in* it.
 *
 * ## A record, not a queue
 *
 * Every other panel on Home filters for what still needs a human — dismissed
 * failures drop off, a run with a retry pending is not yet news. None of that
 * applies here. A dismissed failure still happened, and a completed run is the
 * thing the reader came to see. Do not copy `getHomeData`'s filters into this
 * file.
 *
 * ## Best effort, by construction
 *
 * `recordAudit` deliberately swallows its own failures, so this is a record of
 * what the server managed to write down, not proof that something did or did
 * not happen. Nothing may gate on it — that is what a {@link RoutineCheck} is
 * for.
 */

/** One audit row the ledger tied to a timeline entry. Mirrors `EffectRow`. */
export type WorkEffect = {
  action: string;
  targetType: string;
  targetId: string | null;
  targetLabel: string;
  at: string;
};

/**
 * What kind of work one entry is. Deliberately small — a timeline is meant to
 * be scanned, and clever subcategories make it noisier rather than clearer.
 */
export type WorkEntryKind =
  /** A Routine Run — scheduled, manual, webhook, event or retry. */
  | "run"
  /** Assistant turns inside one Conversation, collapsed to a single entry. */
  | "chat"
  /** One turn inside a Repository work session. */
  | "work_session"
  /** The employee hit a human gate and queued an Approval. */
  | "approval"
  /** A Wakeup the employee scheduled for itself, fired. */
  | "wakeup"
  /** A Lesson taken from a graded Run. */
  | "lesson"
  /** A ledger row with no Run or Conversation to sit under. */
  | "effect";

export type WorkEmployeeRef = {
  id: string;
  name: string;
  slug: string;
  avatarKey: string | null;
};

/** Everything the Run chips on a `run` entry need, without a second request. */
export type WorkEntryRun = {
  id: string;
  routineId: string;
  routineName: string;
  status: RunStatus;
  exitCode: number | null;
  triggerKind: RunTrigger;
  attempt: number;
  /**
   * Carried through verbatim. `unverified` is not `unclear` and neither is a
   * clean run — see AGENTS.md §3. Never coalesce these.
   */
  outcomeVerdict: RunOutcomeVerdict | null;
  outcomeNote: string | null;
  checksVerdict: RunChecksVerdict | null;
};

export type WorkEntry = {
  /** `${kind}:${sourceRowId}` — stable within one response, safe as a key. */
  id: string;
  kind: WorkEntryKind;
  /** When the work happened. The sort key. */
  at: string;
  /** When it ended, where the source records one. Null while still in flight. */
  endedAt: string | null;
  /** Explicit source-backed live state. Never infer this from `endedAt` alone. */
  active: boolean;
  employee: WorkEmployeeRef;
  /** One line naming the work. Server-written, or redacted on the way out. */
  title: string;
  /** A status word, a verdict, a diff stat. Empty when there is none. */
  detail: string;
  /** Present only on `kind: "run"`. */
  run: WorkEntryRun | null;
  /** The ledger rows this entry owns, oldest first, capped for rendering. */
  effects: WorkEffect[];
  /** What the ledger holds before the cap, so "and 33 more" stays honest. */
  effectCount: number;
};

/**
 * The small, pre-limit preview Home needs for one employee bubble.
 *
 * Returning this separately matters when one noisy employee fills the
 * response's visible timeline slice: the rest of the roster must not be
 * labelled quiet merely because their newest row was number 41.
 */
export type WorkEntryDigest = Pick<WorkEntry, "id" | "kind" | "at" | "title" | "detail" | "active">;

export type WorkEmployeeSummary = {
  employeeId: string;
  entryCount: number;
  latest: WorkEntryDigest | null;
  current: WorkEntryDigest | null;
  waiting: WorkEntryDigest | null;
};

export type WorkTimeline = {
  /** Start of the window, inclusive. */
  since: string;
  /** End of the window — when the read happened. */
  until: string;
  /** The employee this was narrowed to, or null for the whole roster. */
  employeeId: string | null;
  entries: WorkEntry[];
  /** Entries in the window before `limit` sliced them. */
  entryCount: number;
  /** One truthful pre-limit rollup for every employee in this response. */
  employeeSummaries: WorkEmployeeSummary[];
};

/** The product promise: what the roster did today. */
export const WORK_TIMELINE_WINDOW_HOURS = 24;

/** How many entries a caller gets by default. */
export const WORK_TIMELINE_DEFAULT_LIMIT = 40;

/**
 * How many rows each source contributes before it is truncated. Far past a
 * real day's work; it exists so one runaway bulk-import loop cannot make this
 * read the most expensive query on the page.
 */
export const WORK_TIMELINE_SOURCE_CAP = 600;

/** How many effects render under one entry. The count stays truthful. */
export const WORK_EFFECT_CAP = 8;

/**
 * Vault item names are the same class of thing as the vault-capture approvals
 * the approvals inbox already hides below admin, and they arrive here as an
 * ordinary `targetLabel`. Dropped for everyone who could not read them at the
 * source.
 */
const ADMIN_ONLY_ACTION_PREFIXES = ["vault."];

function isAdminRole(role: Role): boolean {
  return role === "owner" || role === "admin";
}

/** ISO with the millisecond resolution `recordAudit` deliberately stamps. */
function iso(d: Date): string {
  return d.toISOString();
}

/**
 * Model- and external-written strings get the same scrubbing every other
 * boundary applies. A `targetLabel` on a `web.download` or a `mail.send` can
 * quote a URL carrying a token the employee happened to see.
 */
function safe(value: string | null | undefined): string {
  if (!value) return "";
  return redactSensitiveText(value);
}

/** "3 replies" / "1 reply". */
function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function runTitle(routineName: string): string {
  return `Ran ${routineName}`;
}

function runDetail(run: Run): string {
  const bits: string[] = [];
  if (run.triggerKind !== "schedule") bits.push(`${run.triggerKind} trigger`);
  if (run.attempt > 1) bits.push(`attempt ${run.attempt}`);
  if (run.missedSlots > 0) bits.push(plural(run.missedSlots, "missed slot", "missed slots"));
  return bits.join(" · ");
}

function workSessionDetail(turn: RepositoryWorkSessionTurn): string {
  if (turn.status === "running") return "in progress";
  if (turn.status === "failed") return safe(turn.error) || "failed";
  if (turn.filesChanged === 0) return "no file changes";
  return [
    plural(turn.filesChanged, "file", "files"),
    `+${turn.insertions}`,
    `−${turn.deletions}`,
  ].join(" · ");
}

/**
 * Everything one AI Employee — or the whole roster — did inside the window.
 *
 * `role` and `userId` are not decoration: the same narrowings `getHomeData`
 * applies are applied here, so a Member never learns from this surface
 * something the page that owns it would refuse them.
 */
export async function getEmployeeWorkTimeline(params: {
  companyId: string;
  /** The caller. Used to resolve project access, never to filter by author. */
  userId: string;
  /** Stamped by `requireCompanyMember` after proving the membership. */
  role: Role;
  /** Narrow to one employee. Omitted = every employee in the company. */
  employeeId?: string | null;
  hours?: number;
  limit?: number;
}): Promise<WorkTimeline> {
  const { companyId, userId, role } = params;
  const hours = params.hours ?? WORK_TIMELINE_WINDOW_HOURS;
  const limit = params.limit ?? WORK_TIMELINE_DEFAULT_LIMIT;
  const employeeId = params.employeeId ?? null;

  const until = new Date();
  const since = new Date(until.getTime() - hours * 60 * 60 * 1000);
  const empty: WorkTimeline = {
    since: iso(since),
    until: iso(until),
    employeeId,
    entries: [],
    entryCount: 0,
    employeeSummaries: [],
  };

  // An employee id from another company narrows to nothing rather than 404ing.
  // This is a feed: you cannot be forbidden from something you were never told
  // about, and `GET /audit?actorEmployeeId=` already behaves this way.
  const employees = await AppDataSource.getRepository(AIEmployee).find({
    where: employeeId ? { companyId, id: employeeId } : { companyId },
    select: ["id", "name", "slug", "avatarKey"],
  });
  if (employees.length === 0) return empty;
  const empIds = employees.map((e) => e.id);
  const empById = new Map<string, WorkEmployeeRef>(
    employees.map((e) => [
      e.id,
      { id: e.id, name: e.name, slug: e.slug, avatarKey: e.avatarKey ?? null },
    ]),
  );

  // `runs` carries no companyId, so the hop through the Routine's employee is
  // what scopes it. Getting this wrong is a cross-tenant leak, not a bug.
  const routines = await AppDataSource.getRepository(Routine).find({
    where: { employeeId: In(empIds) },
    select: ["id", "name", "employeeId"],
  });
  const routineById = new Map(routines.map((r) => [r.id, r]));

  // Conversations are likewise scoped through their employee.
  const conversations = await AppDataSource.getRepository(Conversation).find({
    where: { employeeId: In(empIds) },
    select: ["id", "employeeId", "title", "ownerUserId", "source"],
  });
  const convById = new Map(conversations.map((c) => [c.id, c]));

  const sessions = await AppDataSource.getRepository(RepositoryWorkSession).find({
    where: { companyId, employeeId: In(empIds) },
    select: ["id", "employeeId", "title", "repositoryId"],
  });
  const sessionById = new Map(sessions.map((s) => [s.id, s]));

  const take = WORK_TIMELINE_SOURCE_CAP;
  const [
    runs,
    activeRuns,
    auditRows,
    chatTurns,
    activeChatTurns,
    approvals,
    pendingApprovals,
    wakeups,
    lessons,
    sessionTurns,
    activeSessionTurns,
  ] = await Promise.all([
    routines.length
      ? AppDataSource.getRepository(Run).find({
          where: { routineId: In([...routineById.keys()]), startedAt: MoreThanOrEqual(since) },
          order: { startedAt: "DESC" },
          take,
        })
      : Promise.resolve([] as Run[]),
    routines.length
      ? AppDataSource.getRepository(Run).find({
          where: { routineId: In([...routineById.keys()]), status: "running" },
          select: [
            "id",
            "routineId",
            "startedAt",
            "status",
            "triggerKind",
            "attempt",
            "missedSlots",
          ],
          order: { startedAt: "DESC" },
        })
      : Promise.resolve([] as Run[]),
    AppDataSource.getRepository(AuditEvent).find({
      where: { companyId, actorEmployeeId: In(empIds), createdAt: MoreThanOrEqual(since) },
      order: { createdAt: "DESC", id: "DESC" },
      take,
    }),
    conversations.length
      ? AppDataSource.getRepository(ConversationMessage).find({
          where: [
            {
              conversationId: In([...convById.keys()]),
              role: "assistant",
              createdAt: MoreThanOrEqual(since),
            },
            {
              conversationId: In([...convById.keys()]),
              role: "assistant",
              updatedAt: MoreThanOrEqual(since),
            },
          ],
          order: { updatedAt: "DESC", createdAt: "DESC" },
          take,
        })
      : Promise.resolve([] as ConversationMessage[]),
    conversations.length
      ? AppDataSource.getRepository(ConversationMessage).find({
          where: {
            conversationId: In([...convById.keys()]),
            role: "assistant",
            status: "working",
          },
          select: [
            "id",
            "conversationId",
            "status",
            "updatedAt",
            "progressPercent",
            "progressLabel",
          ],
          order: { updatedAt: "DESC" },
        })
      : Promise.resolve([] as ConversationMessage[]),
    AppDataSource.getRepository(Approval).find({
      where: { companyId, employeeId: In(empIds), requestedAt: MoreThanOrEqual(since) },
      order: { requestedAt: "DESC" },
      take,
    }),
    AppDataSource.getRepository(Approval).find({
      where: { companyId, employeeId: In(empIds), status: "pending" },
      select: [
        "id",
        "employeeId",
        "kind",
        "title",
        "payloadJson",
        "status",
        "requestedAt",
        "decidedAt",
      ],
      order: { requestedAt: "DESC" },
      // `payloadJson` is opaque, so a Member's Vault-capture filter runs in
      // memory just as it does on Home's Approval queue. Past this generous
      // safety ceiling an unusually deep backlog may be summarized
      // incompletely; it never leaks.
      take,
    }),
    AppDataSource.getRepository(EmployeeWakeup).find({
      where: {
        companyId,
        employeeId: In(empIds),
        status: "fired",
        firedAt: MoreThanOrEqual(since),
      },
      order: { firedAt: "DESC" },
      take,
    }),
    AppDataSource.getRepository(RunLesson).find({
      where: { companyId, employeeId: In(empIds), createdAt: MoreThanOrEqual(since) },
      order: { createdAt: "DESC" },
      take,
    }),
    sessions.length
      ? AppDataSource.getRepository(RepositoryWorkSessionTurn).find({
          where: { companyId, sessionId: In([...sessionById.keys()]) },
          order: { createdAt: "DESC" },
          take,
        })
      : Promise.resolve([] as RepositoryWorkSessionTurn[]),
    sessions.length
      ? AppDataSource.getRepository(RepositoryWorkSessionTurn).find({
          where: {
            companyId,
            sessionId: In([...sessionById.keys()]),
            status: "running",
          },
          select: ["id", "sessionId", "status", "createdAt"],
          order: { createdAt: "DESC" },
        })
      : Promise.resolve([] as RepositoryWorkSessionTurn[]),
  ]);

  const canSeeVaultRows = isAdminRole(role);

  // Audit rows naming a todo carry that todo's title. Home narrows every todo
  // query to the projects this Member can reach; a restricted title must not
  // arrive here by a side door instead.
  const todoIds = [
    ...new Set(
      auditRows
        .filter((r) => r.targetType === "todo" && r.targetId)
        .map((r) => r.targetId as string),
    ),
  ];
  let hiddenTodoIds = new Set<string>();
  if (todoIds.length > 0) {
    const [accessibleProjectIds, todos] = await Promise.all([
      listAccessibleProjectIds(companyId, { kind: "user", id: userId, role }),
      AppDataSource.getRepository(Todo).find({
        where: { id: In(todoIds) },
        select: ["id", "projectId"],
      }),
    ]);
    const projectByTodo = new Map(todos.map((t) => [t.id, t.projectId]));
    hiddenTodoIds = new Set(
      todoIds.filter((id) => {
        const projectId = projectByTodo.get(id);
        // A todo the lookup could not resolve is hidden rather than shown: an
        // unknown project is not an accessible one.
        return !projectId || !accessibleProjectIds.has(projectId);
      }),
    );
  }

  const visibleAudit = auditRows.filter((r) => {
    if (!canSeeVaultRows && ADMIN_ONLY_ACTION_PREFIXES.some((p) => r.action.startsWith(p))) {
      return false;
    }
    if (r.targetType === "todo" && r.targetId && hiddenTodoIds.has(r.targetId)) return false;
    return true;
  });

  const entries: WorkEntry[] = [];

  const describeChatTurn = (msg: ConversationMessage, conv: Conversation) => {
    // A transcript is private to the Member who requested it — that is what
    // stops a lower-privilege Member replaying context produced under somebody
    // else's authority. The work is still reported; its subject is not.
    const owned = conv.ownerUserId === userId;
    const subject = owned && conv.title ? safe(conv.title) : "a private conversation";
    const working = msg.status === "working";
    const progress =
      working && owned && msg.progressLabel
        ? `${safe(msg.progressLabel)}${msg.progressPercent !== null ? ` · ${msg.progressPercent}%` : ""}`
        : null;
    return {
      at: iso(msg.updatedAt),
      endedAt: working ? null : iso(msg.updatedAt),
      active: working,
      title: working ? `Working on ${subject}` : `Replied in ${subject}`,
      detail: progress ?? (working ? "Working on a reply" : ""),
    };
  };

  // ── Runs ─────────────────────────────────────────────────────────────────
  // Effects land on the entry that owns them, so the run index is built first.
  const runEntryById = new Map<string, WorkEntry>();
  for (const run of runs) {
    const routine = routineById.get(run.routineId);
    if (!routine) continue;
    const employee = empById.get(routine.employeeId);
    if (!employee) continue;
    const entry: WorkEntry = {
      id: `run:${run.id}`,
      kind: "run",
      at: iso(run.startedAt),
      endedAt: run.finishedAt ? iso(run.finishedAt) : null,
      active: run.status === "running",
      employee,
      title: runTitle(routine.name),
      detail: runDetail(run),
      run: {
        id: run.id,
        routineId: routine.id,
        routineName: routine.name,
        status: run.status,
        exitCode: run.exitCode,
        triggerKind: run.triggerKind,
        attempt: run.attempt,
        outcomeVerdict: run.outcomeVerdict,
        outcomeNote: run.outcomeNote ? safe(run.outcomeNote) : null,
        checksVerdict: run.checksVerdict,
      },
      effects: [],
      effectCount: 0,
    };
    runEntryById.set(run.id, entry);
    entries.push(entry);
  }

  // ── Chat ─────────────────────────────────────────────────────────────────
  // One entry per conversation rather than per turn: fifty replies in one
  // thread is one piece of work, and fifty rows would bury everything else.
  const chatEntryByConversation = new Map<string, WorkEntry>();
  const chatTurnCounts = new Map<string, number>();
  for (const msg of chatTurns) {
    chatTurnCounts.set(msg.conversationId, (chatTurnCounts.get(msg.conversationId) ?? 0) + 1);
    if (chatEntryByConversation.has(msg.conversationId)) continue;
    const conv = convById.get(msg.conversationId);
    if (!conv) continue;
    const employee = empById.get(conv.employeeId);
    if (!employee) continue;
    const presentation = describeChatTurn(msg, conv);
    const entry: WorkEntry = {
      // Newest turn first, so this is the conversation's most recent work.
      id: `chat:${conv.id}`,
      kind: "chat",
      at: presentation.at,
      endedAt: presentation.endedAt,
      active: presentation.active,
      employee,
      title: presentation.title,
      detail: presentation.detail,
      run: null,
      effects: [],
      effectCount: 0,
    };
    chatEntryByConversation.set(conv.id, entry);
    entries.push(entry);
  }
  for (const [conversationId, entry] of chatEntryByConversation) {
    const conv = convById.get(conversationId);
    const replies = plural(chatTurnCounts.get(conversationId) ?? 0, "reply", "replies");
    if (!entry.active) {
      entry.detail =
        conv && conv.source !== "web" && conv.source !== "help"
          ? `${replies} · ${conv.source}`
          : replies;
    }
  }

  // ── Repository work sessions ─────────────────────────────────────────────
  for (const turn of sessionTurns) {
    // Still-running turns have no finish time; they window on when they began.
    const at = turn.finishedAt ?? turn.createdAt;
    if (at < since) continue;
    const session = sessionById.get(turn.sessionId);
    if (!session) continue;
    const employee = empById.get(session.employeeId);
    if (!employee) continue;
    entries.push({
      id: `work_session:${turn.id}`,
      kind: "work_session",
      at: iso(at),
      endedAt: turn.finishedAt ? iso(turn.finishedAt) : null,
      active: turn.status === "running",
      employee,
      title: `Worked in ${safe(session.title) || "a repository"}`,
      detail: workSessionDetail(turn),
      run: null,
      effects: [],
      effectCount: 0,
    });
  }

  // ── Approvals ────────────────────────────────────────────────────────────
  // Same rule the approvals inbox and Home already apply: a vault capture row
  // names the origin a stored credential would be written to.
  for (const approval of approvals) {
    if (!canSeeVaultRows && isVaultCaptureApproval(approval)) continue;
    const employee = empById.get(approval.employeeId);
    if (!employee) continue;
    const title = redactApprovalSummary(approval.title);
    entries.push({
      id: `approval:${approval.id}`,
      kind: "approval",
      at: iso(approval.requestedAt),
      endedAt: approval.decidedAt ? iso(approval.decidedAt) : null,
      active: false,
      employee,
      title: `Approval required: ${title || approval.kind.replaceAll("_", " ")}`,
      detail: approval.status,
      run: null,
      effects: [],
      effectCount: 0,
    });
  }

  // ── Wakeups ──────────────────────────────────────────────────────────────
  for (const wakeup of wakeups) {
    if (!wakeup.firedAt) continue;
    const employee = empById.get(wakeup.employeeId);
    if (!employee) continue;
    entries.push({
      id: `wakeup:${wakeup.id}`,
      kind: "wakeup",
      at: iso(wakeup.firedAt),
      endedAt: null,
      active: false,
      employee,
      title: "Woke itself up to follow something through",
      detail: safe(wakeup.outcomeNote) || safe(wakeup.brief),
      run: null,
      effects: [],
      effectCount: 0,
    });
  }

  // ── Lessons ──────────────────────────────────────────────────────────────
  for (const lesson of lessons) {
    const employee = empById.get(lesson.employeeId);
    if (!employee) continue;
    entries.push({
      id: `lesson:${lesson.id}`,
      kind: "lesson",
      at: iso(lesson.createdAt),
      endedAt: null,
      active: false,
      employee,
      title: `Took a lesson from a run: ${safe(lesson.cause) || "unnamed"}`,
      detail: safe(lesson.advice),
      run: null,
      effects: [],
      effectCount: 0,
    });
  }

  // ── Effects ──────────────────────────────────────────────────────────────
  // Oldest first inside an entry, matching `runEffects.ts`, because a run's
  // ledger reads as a sequence. `visibleAudit` is newest-first, so it is walked
  // backwards.
  for (let i = visibleAudit.length - 1; i >= 0; i--) {
    const row = visibleAudit[i];
    const parent =
      (row.runId ? runEntryById.get(row.runId) : null) ??
      (row.conversationId ? chatEntryByConversation.get(row.conversationId) : null);
    const effect: WorkEffect = {
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      targetLabel: safe(row.targetLabel),
      at: iso(row.createdAt),
    };
    if (parent) {
      parent.effectCount += 1;
      if (parent.effects.length < WORK_EFFECT_CAP) parent.effects.push(effect);
      continue;
    }
    // A row whose Run or Conversation fell outside the window still happened,
    // so it stands on its own rather than going missing.
    const employee = row.actorEmployeeId ? empById.get(row.actorEmployeeId) : undefined;
    if (!employee) continue;
    entries.push({
      id: `effect:${row.id}`,
      kind: "effect",
      at: effect.at,
      endedAt: null,
      active: false,
      employee,
      title: effect.targetLabel || row.targetId || row.action,
      detail: row.action,
      run: null,
      effects: [],
      effectCount: 0,
    });
  }

  // Newest first, with the id as a stable tie-break so the same window never
  // renders in two different orders.
  entries.sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? 1 : -1;
    return a.id < b.id ? 1 : -1;
  });

  const summaryByEmployee = new Map<string, WorkEmployeeSummary>(
    employees.map((employee) => [
      employee.id,
      {
        employeeId: employee.id,
        entryCount: 0,
        latest: null,
        current: null,
        waiting: null,
      },
    ]),
  );
  const digest = (entry: WorkEntry): WorkEntryDigest => ({
    id: entry.id,
    kind: entry.kind,
    at: entry.at,
    title: entry.title,
    detail: entry.detail,
    active: entry.active,
  });
  const isNewer = (candidate: WorkEntryDigest, current: WorkEntryDigest | null): boolean =>
    !current ||
    candidate.at > current.at ||
    (candidate.at === current.at && candidate.id > current.id);
  const rememberCurrent = (employeeId: string, candidate: WorkEntryDigest): void => {
    const summary = summaryByEmployee.get(employeeId);
    if (summary && isNewer(candidate, summary.current)) summary.current = candidate;
  };
  const rememberWaiting = (employeeId: string, candidate: WorkEntryDigest): void => {
    const summary = summaryByEmployee.get(employeeId);
    if (summary && isNewer(candidate, summary.waiting)) summary.waiting = candidate;
  };
  for (const entry of entries) {
    const summary = summaryByEmployee.get(entry.employee.id);
    if (!summary) continue;
    summary.entryCount += 1;
    summary.latest ??= digest(entry);
    if (!summary.current && entry.active) {
      summary.current = digest(entry);
    }
    if (
      !summary.waiting &&
      entry.kind === "approval" &&
      entry.detail === "pending" &&
      !entry.endedAt
    ) {
      summary.waiting = digest(entry);
    }
  }

  // Current work and unresolved human gates outlive the 24-hour history
  // window. They do not change `entryCount` or `latest` — those still describe
  // the window — but they must keep the roster from calling someone quiet
  // while they are visibly still working or waiting for a Member.
  for (const run of activeRuns) {
    const routine = routineById.get(run.routineId);
    if (!routine) continue;
    rememberCurrent(routine.employeeId, {
      id: `run:${run.id}`,
      kind: "run",
      at: iso(run.startedAt),
      title: runTitle(routine.name),
      detail: runDetail(run),
      active: true,
    });
  }
  for (const msg of activeChatTurns) {
    const conv = convById.get(msg.conversationId);
    if (!conv) continue;
    const presentation = describeChatTurn(msg, conv);
    rememberCurrent(conv.employeeId, {
      id: `chat:${conv.id}`,
      kind: "chat",
      at: presentation.at,
      title: presentation.title,
      detail: presentation.detail,
      active: true,
    });
  }
  for (const turn of activeSessionTurns) {
    const session = sessionById.get(turn.sessionId);
    if (!session) continue;
    rememberCurrent(session.employeeId, {
      id: `work_session:${turn.id}`,
      kind: "work_session",
      at: iso(turn.createdAt),
      title: `Worked in ${safe(session.title) || "a repository"}`,
      detail: workSessionDetail(turn),
      active: true,
    });
  }
  for (const approval of pendingApprovals) {
    if (approval.decidedAt || (!canSeeVaultRows && isVaultCaptureApproval(approval))) continue;
    const title = redactApprovalSummary(approval.title);
    rememberWaiting(approval.employeeId, {
      id: `approval:${approval.id}`,
      kind: "approval",
      at: iso(approval.requestedAt),
      title: `Approval required: ${title || approval.kind.replaceAll("_", " ")}`,
      detail: approval.status,
      active: false,
    });
  }

  return {
    since: iso(since),
    until: iso(until),
    employeeId,
    entries: entries.slice(0, limit),
    entryCount: entries.length,
    employeeSummaries: [...summaryByEmployee.values()],
  };
}
