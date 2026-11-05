import { randomUUID } from "node:crypto";
import {
  In,
  IsNull,
  LessThanOrEqual,
  MoreThan,
  MoreThanOrEqual,
  Not,
  type ObjectLiteral,
  type SelectQueryBuilder,
} from "typeorm";

import { config } from "../../config.js";
import { recordAudit } from "./audit.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { BrowserSession } from "../db/entities/BrowserSession.js";
import { Company } from "../db/entities/Company.js";
import { ConversationActivityEvent } from "../db/entities/ConversationActivityEvent.js";
import { Membership, type FinanceAccess } from "../db/entities/Membership.js";
import { Project } from "../db/entities/Project.js";
import { Todo, type TodoStatus } from "../db/entities/Todo.js";
import { TodoComment } from "../db/entities/TodoComment.js";
import { TodoPickup } from "../db/entities/TodoPickup.js";
import { User } from "../db/entities/User.js";
import type { TurnActivitySummary } from "../../shared/chatActivity.js";
import { parseTurnActivitySummary } from "../../shared/chatActivity.js";
import type { TodoPickupHold, TodoPickupTrigger, TodoPickupView } from "../../shared/todoPickups.js";
import {
  activityEventFor,
  turnActivityAccess,
  type TurnActivityAccess,
} from "../../shared/turnActivityAccess.js";
import type { AgentProgress } from "./agent/types.js";
import {
  CHAT_HARD_TIMEOUT_MS,
  streamChatWithEmployee,
  type ChatOptions,
  type ChatResult,
} from "./chat.js";
import {
  ChatTurnActivityRecorder,
  listChatActivity,
  nextChatActivityOrdinal,
  summarizeChatActivity,
} from "./chatTurnActivity.js";
import { followChatTurn, type FollowSource } from "./chatTurnFollow.js";
import { openLiveTurn, releaseLiveTurn, type LiveTurn } from "./chatTurnLive.js";
import { createReplyTextSnapshotter } from "./chatTurnProgress.js";
import type { MailDeliveryMode } from "./mail/deliveryPolicy.js";
import { isModelAvailable } from "./modelAvailability.js";
import { getActiveModel } from "./models.js";
import { createNotifications } from "./notifications.js";
import { hasProjectAccess } from "./projects.js";
import { emitResourceChange } from "./resourceEvents.js";
import { workBlocked } from "./standdowns.js";
import { jsonBoundedString } from "./mail/promptBounds.js";
import { todoDiscussionHistory } from "./todoCommentAttachments.js";
import { presentTodoLinks } from "./todoLinks.js";
import { composeTodoPickupBrief } from "./todoPickupBrief.js";
import { captureTurnActionsForAuthority } from "./turnActions.js";
import { bindAttachmentsToMessage } from "./uploads.js";
import { EmployeeWorkloadBusyError, releaseChatWorkloadLeaseByOwner } from "./workloadLeases.js";

/**
 * Pickups: an AI Employee working a Todo, durably, one at a time.
 *
 * Handing a Todo to an AI Employee used to start a fire-and-forget session. A
 * restart stranded the card `in_progress` with a spinner on its thread forever.
 * A Standdown or an unavailable AI Model ended in "I couldn't work on this" and
 * never tried again. Twenty assignments were twenty sessions at once. Only a
 * person in a browser could start one at all, so a Todo one AI Employee handed
 * another was never worked by anybody.
 *
 * Now a Todo handed over becomes a {@link TodoPickup}, a queued row, and that
 * table is the work queue:
 *
 *  - **It waits rather than fails.** A Standdown and an unavailable AI Model
 *    leave it queued, saying why, and it starts by itself afterwards. Neither
 *    records a failure (AGENTS.md §3). A real error backs off and tries again a
 *    bounded number of times.
 *  - **A restart hands it on.** A worker holds a short lease it renews; a lapsed
 *    one goes back in the queue as the same pickup, told what the first attempt
 *    already changed.
 *  - **One at a time per AI Employee**, highest priority first. A person can see
 *    what is queued and why, and press Stop.
 *  - **It runs with what it was given.** Authority and ceilings are stored on the
 *    row, set by whoever asked, so a colleague's turn under a review-only or
 *    tainted ceiling cannot shed it by handing the work over. A person's request
 *    runs under that person. An AI Employee's own request runs as itself.
 *  - **It costs nothing to check.** The heartbeat is a query. A company with
 *    nothing due spends no model turn, and this is why it isn't a Routine.
 *  - **It stays bounded.** Chains of AI-created Todos stop at a depth, and each
 *    Todo gets a limited number of automatic pickups a day, so two AI Employees
 *    or an auto-responder can't loop.
 *
 * Existing Todos start nothing on upgrade: only a new assignment or a person's
 * Start now creates a pickup.
 */

/** A worker renews this often, and a claim lapses this long after its last renewal. */
const LEASE_MS = 30_000;
const RENEW_MS = 10_000;
/** How long a pickup that lost the thread to an @-mention reply waits to look again. */
const BUSY_RETRY_MS = 15_000;
/** Sessions at once in one process. One per AI Employee is the rule that matters. */
const MAX_RUNNING_PER_PROCESS = 4;
/** How many due pickups one pass of the queue looks at. */
const DISPATCH_WINDOW = 50;
/** How much a session may do. A chat reply's default is too small for real work. */
const PICKUP_MAX_STEPS = 200;
/** How often the reply so far is saved while it streams. */
const REPLY_SNAPSHOT_MS = 2_000;
/** The automatic pickups one Todo may have in a day before it waits for a person. */
export const MAX_AUTOMATIC_PICKUPS_PER_DAY = 10;
/** How deep a chain of AI-created Todos may start itself. */
export const MAX_TODO_CHAIN_DEPTH = 5;
/** Real failures before a pickup gives up, and the wait after each. */
const RETRY_DELAYS_MS = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
/** A restart cutting the same pickup off this often means it never finishes. */
const MAX_ATTEMPTS = 6;
/** Longest note a pickup keeps from those who asked for it. */
const NOTE_CHARS = 16_000;
const COMMENT_CHARS = 10_000;
const DAY_MS = 24 * 60 * 60_000;
const CAPPED_MESSAGE = "It reached its limit of automatic sessions for today.";
const HANDED_OVER = "It was handed to someone else.";

/** Follow-up checks with no reply before a person has to decide. */
const MAX_FOLLOW_UP_CHECKS = 3;
/** Sessions that carry on work already started, rather than a person starting it. */
const CONTINUATIONS: readonly TodoPickupTrigger[] = [
  "left_open",
  "wait_over",
  "email_reply",
  "email_intake",
  "decision_answered",
  "review_outcome",
  "work_session_ended",
];
/** The statuses a Todo can be picked up from, by its assignee. */
const WORKABLE: readonly TodoStatus[] = ["backlog", "todo", "in_progress"];

export type TodoPickupAuthority =
  | { kind: "member"; userId: string; sessionVersion: number }
  | { kind: "employee" };

/**
 * What a pickup inherits from whatever asked for it. Each can only narrow, and a
 * Todo remembers the narrowest it has been held to (`Todo.ceilingJson`).
 */
export type TodoPickupCeiling = {
  mailDeliveryMode?: MailDeliveryMode | null;
  proactiveReview?: boolean;
  tainted?: boolean;
  mailThreadId?: string | null;
  /**
   * An owner named this email's sender on the Project's intake and the receiving
   * server verified it. Trust isn't inherited: a colleague handed this Todo, or a
   * stranger's reply on the same thread, doesn't have it.
   */
  trustedSender?: boolean;
};

export type TodoPickupRequest = {
  companyId: string;
  todoId: string;
  employeeId: string;
  trigger: TodoPickupTrigger;
  authority: TodoPickupAuthority;
  ceiling?: TodoPickupCeiling;
  /** A person asked for this directly, so the automatic limits don't apply. */
  byMember?: boolean;
  /**
   * A person chose, on this Todo, to give one session their own access past what the
   * Todo is held to (`Todo.ceilingJson`). Only that choice sets this. A comment, an
   * assignment or ending a wait grants nothing, whoever does it.
   */
  overLimits?: boolean;
  note?: string;
  notBeforeAt?: Date;
  /**
   * The Todo went to someone else, so whatever the last assignee still has
   * running stops. Left out when an employee hands work on from its own session:
   * that session goes on to finish and write its report, and the next one starts
   * after it.
   */
  stopOtherAssignee?: boolean;
};

export type TodoPickupOutcome =
  | { started: true; pickup: TodoPickup }
  | {
      started: false;
      reason: "gone" | "not_assigned" | "closed" | "no_access" | "no_model" | "too_deep" | "capped";
    };

const repo = () => AppDataSource.getRepository(TodoPickup);

// ───────────────────────────── running in this process

/** Sessions this process is running, for Stop and for its share of the queue. */
const localRuns = new Map<string, { abort: () => void; stop: (by: StoppedBy) => boolean }>();
const inFlight = new Set<Promise<unknown>>();

type StoppedBy = { userId: string; name: string | null };

function track<T>(work: Promise<T>): Promise<T> {
  inFlight.add(work);
  void work.finally(() => inFlight.delete(work)).catch(() => undefined);
  return work;
}

/** Resolves once every pickup this process started has stopped running. Tests. */
export async function settleTodoPickupsForTests(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

// ───────────────────────────── asking

function narrowestDelivery(
  left: string | null | undefined,
  right: string | null | undefined,
): string | null {
  // Triage reaches less than review, and review less than reply.
  const order = ["triage", "review", "draft", "reply"];
  const candidates = [left, right].filter((mode): mode is string => Boolean(mode));
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
}

/** Between one note and the next. JSON evidence can't contain a raw line break, so can't fake it. */
const NOTE_BREAK = "\n\n---\n\n";

/**
 * A note too long to keep loses its end, never its start: the start is the part that
 * says the rest is untrusted, and an email is at the end.
 */
function boundNote(note: string): string {
  return note.length <= NOTE_CHARS ? note : note.slice(0, NOTE_CHARS);
}

/**
 * Add to a pickup's notes. They're dropped whole, never cut, so a long email can't
 * push out what frames it. The first stays, because that's the owner's instruction
 * when there is one, and the newest stays, because that's what this session is for.
 */
function appendNote(existing: string, addition: string | undefined): string {
  const added = addition?.trim();
  if (!added || existing.includes(added)) return existing;
  const notes = [...existing.split(NOTE_BREAK).filter(Boolean), boundNote(added)];
  const size = () => notes.join(NOTE_BREAK).length;
  while (notes.length > 2 && size() > NOTE_CHARS) notes.splice(1, 1);
  if (size() > NOTE_CHARS) notes.splice(0, notes.length - 1);
  return notes.join(NOTE_BREAK);
}

function isRestricted(ceiling: TodoPickupCeiling): boolean {
  return (
    ceiling.proactiveReview === true || Boolean(ceiling.mailDeliveryMode) || ceiling.tainted === true
  );
}

function readFloor(todo: Pick<Todo, "ceilingJson">): TodoPickupCeiling | null {
  if (!todo.ceilingJson) return null;
  try {
    return JSON.parse(todo.ceilingJson) as TodoPickupCeiling;
  } catch {
    // A floor nobody can read still means this Todo was held to one.
    return { proactiveReview: true, mailDeliveryMode: "review" };
  }
}

/** A restricted turn's limits, to hold what it creates to them. Null when it has none. */
export function ceilingJsonFor(ceiling: TodoPickupCeiling): string | null {
  return isRestricted(ceiling) ? JSON.stringify(ceiling) : null;
}

/** What limits this Todo to preparing or to review, when it is. Taint alone isn't one. */
export function todoLimits(todo: Pick<Todo, "ceilingJson">): TodoPickupCeiling | null {
  const floor = readFloor(todo);
  return floor && (floor.proactiveReview === true || Boolean(floor.mailDeliveryMode))
    ? floor
    : null;
}

/** Whether what this Todo was already held to has no sender's trust in it. */
export function todoHeldWithoutTrust(todo: Pick<Todo, "ceilingJson">): boolean {
  const floor = readFloor(todo);
  return floor !== null && floor.trustedSender !== true;
}

/**
 * Words from a particular email are on this Todo now, and a later session replays them.
 * So later sessions are held to the same limits, and a person's earlier choice to lend
 * their access no longer stands: it was made before these words. Call it before saving
 * `todo`, or the save puts back what it loaded.
 */
export async function holdTodoToTurn(todo: Todo, ceiling: TodoPickupCeiling): Promise<void> {
  if (!ceiling.mailThreadId) return;
  await heldToFloor(todo, ceiling);
  await dropLiftsOn(todo.id);
}

/**
 * Whatever was lent on this Todo goes back within its limits the next time a session
 * starts: a queued row, a retry of the one running, and any rerun they carry.
 */
export async function dropLiftsOn(todoId: string): Promise<void> {
  const active = await repo().find({
    where: { todoId, status: In(["queued", "running"]) },
    select: { id: true, overLimits: true, rerunJson: true },
  });
  for (const row of active) {
    const changes: { overLimits?: boolean; rerunJson?: string } = {};
    if (row.overLimits) changes.overLimits = false;
    if (row.rerunJson) {
      const stored = JSON.parse(row.rerunJson) as StoredRerun;
      if (stored.overLimits) {
        changes.rerunJson = JSON.stringify({ ...stored, overLimits: false });
      }
    }
    if (Object.keys(changes).length > 0) await repo().update({ id: row.id }, changes);
  }
}

/**
 * What a row may do now, given what its Todo is held to. Applied as a session starts,
 * because a row can sit queued for a month, and the Todo can be held in that time.
 */
function rowHeldToFloor(pickup: TodoPickup, todo: Pick<Todo, "ceilingJson">) {
  const floor = pickup.overLimits ? null : readFloor(todo);
  if (!floor || !isRestricted(floor)) return null;
  return {
    mailDeliveryMode: narrowestDelivery(pickup.mailDeliveryMode, floor.mailDeliveryMode),
    proactiveReview: pickup.proactiveReview || floor.proactiveReview === true,
    tainted: pickup.tainted || floor.tainted === true,
    mailThreadId: floor.mailThreadId ?? pickup.mailThreadId,
    trustedSender: pickup.trustedSender && floor.trustedSender === true,
  };
}

/** Todos held to limits that preparing turns may add to a company in a day. */
export const MAX_HELD_TODOS_PER_COMPANY_PER_DAY = 200;

export async function heldTodosSince(companyId: string, since: Date): Promise<number> {
  const projects = await AppDataSource.getRepository(Project).find({
    where: { companyId },
    select: { id: true },
  });
  if (projects.length === 0) return 0;
  return AppDataSource.getRepository(Todo).countBy({
    projectId: In(projects.map((project) => project.id)),
    ceilingJson: Not(IsNull()),
    createdAt: MoreThanOrEqual(since),
  });
}

/**
 * Hold an automatic request to what this Todo has already been held to, and remember
 * the result. Trust is asked for each time and never carried: a session only has it
 * when this request says so and nothing has taken it from the Todo.
 */
async function heldToFloor(
  todo: Todo,
  asked: TodoPickupCeiling,
): Promise<TodoPickupCeiling> {
  const floor = readFloor(todo);
  const held: TodoPickupCeiling = floor
    ? {
        mailDeliveryMode: narrowestDelivery(
          floor.mailDeliveryMode,
          asked.mailDeliveryMode,
        ) as MailDeliveryMode | null,
        proactiveReview: floor.proactiveReview === true || asked.proactiveReview === true,
        tainted: floor.tainted === true || asked.tainted === true,
        // The thread this work came from stays the one it may reply on.
        mailThreadId: floor.mailThreadId ?? asked.mailThreadId,
        trustedSender: floor.trustedSender === true && asked.trustedSender === true,
      }
    : asked;
  // Remembered for the Todo only with outside words behind it. A Routine that could only
  // prepare posting a status doesn't hold a person's Todo: that one request stays limited.
  if (isRestricted(held) && (floor || asked.mailThreadId || asked.tainted)) {
    const trustLeft = floor
      ? floor.trustedSender === true && asked.trustedSender !== false
      : asked.trustedSender === true;
    const next = JSON.stringify({ ...held, trustedSender: trustLeft });
    if (next !== todo.ceilingJson) {
      await AppDataSource.getRepository(Todo).update({ id: todo.id }, { ceilingJson: next });
      todo.ceilingJson = next;
    }
  }
  return held;
}

function requestColumns(request: TodoPickupRequest) {
  return {
    trigger: request.trigger,
    authority: request.authority.kind,
    requesterUserId: request.authority.kind === "member" ? request.authority.userId : null,
    requesterSessionVersion:
      request.authority.kind === "member" ? request.authority.sessionVersion : null,
    startedByMember: request.byMember === true,
    overLimits: request.overLimits === true,
    mailDeliveryMode: request.ceiling?.mailDeliveryMode ?? null,
    proactiveReview: request.ceiling?.proactiveReview === true,
    tainted: request.ceiling?.tainted === true,
    mailThreadId: request.ceiling?.mailThreadId ?? null,
    trustedSender: request.ceiling?.trustedSender === true,
  };
}

/**
 * Put work on a queued pickup that already exists. A person's own request is
 * theirs to make, so it replaces who the session runs for. Anything else can
 * only narrow it: an event never lends a session authority it did not have.
 * Taint is never shed, because the thread it replays has not changed.
 */
function mergedIntoQueued(row: TodoPickup, request: TodoPickupRequest) {
  const asked = requestColumns(request);
  const soonest =
    request.notBeforeAt && row.notBeforeAt && request.notBeforeAt > row.notBeforeAt
      ? row.notBeforeAt
      : (request.notBeforeAt ?? new Date());
  const note = appendNote(row.note, request.note);
  if (request.byMember) {
    return { ...asked, tainted: row.tainted || asked.tainted, note, notBeforeAt: soonest };
  }
  return {
    trigger: row.trigger === "review" ? row.trigger : asked.trigger,
    overLimits: false,
    mailDeliveryMode: narrowestDelivery(row.mailDeliveryMode, asked.mailDeliveryMode),
    proactiveReview: row.proactiveReview || asked.proactiveReview,
    tainted: row.tainted || asked.tainted,
    mailThreadId: row.mailThreadId ?? asked.mailThreadId,
    trustedSender: row.trustedSender && asked.trustedSender,
    note,
    notBeforeAt: soonest,
  };
}

/**
 * Queue a session for an AI Employee on a Todo. If one is already queued it
 * takes this request as well, and if one is running it runs again afterwards, so
 * a burst of events is one session and none is lost.
 *
 * Refuses quietly when the employee has no AI Model, which is what lets a fresh
 * install use Tasks with placeholder employees, and when it would pass a limit.
 */
export async function requestTodoPickup(asked: TodoPickupRequest): Promise<TodoPickupOutcome> {
  let request = asked;
  const todo = await AppDataSource.getRepository(Todo).findOneBy({ id: request.todoId });
  const project = todo
    ? await AppDataSource.getRepository(Project).findOneBy({
        id: todo.projectId,
        companyId: request.companyId,
      })
    : null;
  if (!todo || !project) return { started: false, reason: "gone" };
  // Everything is held to the Todo's floor, before any limit below can return, so a
  // capped reply still narrows it. A person's explicit choice is what goes past it, and
  // the words behind that floor are still on the thread, so that session starts tainted.
  if (request.overLimits) {
    if (todo.ceilingJson) request = { ...request, ceiling: { ...request.ceiling, tainted: true } };
  } else {
    request = { ...request, ceiling: await heldToFloor(todo, request.ceiling ?? {}) };
  }
  if (request.trigger === "review") {
    if (todo.reviewerEmployeeId !== request.employeeId) {
      return { started: false, reason: "not_assigned" };
    }
    if (todo.status !== "in_review") return { started: false, reason: "closed" };
  } else {
    if (todo.assigneeEmployeeId !== request.employeeId) {
      return { started: false, reason: "not_assigned" };
    }
    if (!WORKABLE.includes(todo.status)) return { started: false, reason: "closed" };
  }
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: request.employeeId,
    companyId: request.companyId,
  });
  if (!employee) return { started: false, reason: "gone" };
  if (!(await hasProjectAccess(project, { kind: "ai", id: employee.id }, "read"))) {
    return { started: false, reason: "no_access" };
  }
  // No model, no session: an assignee with no brain just records the assignee.
  if (!(await getActiveModel(employee.id))) return { started: false, reason: "no_model" };

  if (!request.byMember) {
    if (todo.aiChainDepth > MAX_TODO_CHAIN_DEPTH) return { started: false, reason: "too_deep" };
    const recent = await repo().countBy({
      todoId: todo.id,
      startedByMember: false,
      createdAt: MoreThan(new Date(Date.now() - DAY_MS)),
    });
    if (recent >= MAX_AUTOMATIC_PICKUPS_PER_DAY) {
      await noticeCapped(todo, project, employee);
      return { started: false, reason: "capped" };
    }
  }

  // Twice at most: losing the insert to a racing request means there is now an
  // active row to join, unless it ended in between.
  for (let tries = 0; tries < 2; tries += 1) {
    const active = await repo().findOne({
      where: { todoId: todo.id, status: In(["queued", "running"]) },
    });
    if (active?.status === "running") {
      // One at a time on a thread: remember the newest request for when it ends.
      const held = active.rerunJson ? (JSON.parse(active.rerunJson) as StoredRerun) : null;
      await repo().update(
        { id: active.id, status: "running" },
        { rerunJson: JSON.stringify(mergedRerun(held, request)) },
      );
      if (request.stopOtherAssignee && active.employeeId !== request.employeeId) {
        await stopTodoPickup({ pickup: active, by: null, reason: HANDED_OVER });
      }
      return { started: true, pickup: active };
    }
    if (active && active.employeeId !== request.employeeId) {
      await endWithoutRunning(active, "skipped", HANDED_OVER);
    } else if (active) {
      await repo().update({ id: active.id, status: "queued" }, mergedIntoQueued(active, request));
      announce(active.companyId, todo.projectId);
      schedulePass();
      return { started: true, pickup: active };
    }
    try {
      const now = new Date();
      const pickup = await repo().save(
        repo().create({
          ...requestColumns(request),
          companyId: request.companyId,
          todoId: todo.id,
          employeeId: employee.id,
          status: "queued",
          note: boundNote(request.note ?? ""),
          notBeforeAt: request.notBeforeAt ?? now,
          acceptedAt: now,
        }),
      );
      announce(pickup.companyId, todo.projectId);
      schedulePass();
      return { started: true, pickup };
    } catch (error) {
      // The one active pickup per Todo is an index: only that is worth a retry.
      if (!/unique|duplicate/i.test(String(error))) throw error;
    }
  }
  return { started: false, reason: "gone" };
}

type StoredRerun = {
  employeeId: string;
  trigger: TodoPickupTrigger;
  authority: TodoPickupAuthority;
  ceiling: TodoPickupCeiling;
  byMember: boolean;
  overLimits?: boolean;
  note: string;
  /** When it should start, for a check-back asked for while the session still runs. */
  notBeforeAt?: string;
};

function mergedRerun(held: StoredRerun | null, request: TodoPickupRequest): StoredRerun {
  const ceiling = request.ceiling ?? {};
  // A request for someone else isn't narrowed by what the last one was held to,
  // beyond taint: that thread is the one the next session replays.
  if (!held || request.byMember || held.employeeId !== request.employeeId) {
    return {
      employeeId: request.employeeId,
      trigger: request.trigger,
      authority: request.authority,
      ceiling: { ...ceiling, tainted: ceiling.tainted || held?.ceiling.tainted },
      byMember: request.byMember === true,
      overLimits: request.overLimits === true,
      note: appendNote(held?.note ?? "", request.note),
      notBeforeAt: request.notBeforeAt?.toISOString(),
    };
  }
  return {
    employeeId: request.employeeId,
    trigger: request.trigger,
    authority: held.authority,
    ceiling: {
      mailDeliveryMode: narrowestDelivery(
        held.ceiling.mailDeliveryMode,
        ceiling.mailDeliveryMode,
      ) as MailDeliveryMode | null,
      proactiveReview: held.ceiling.proactiveReview || ceiling.proactiveReview,
      tainted: held.ceiling.tainted || ceiling.tainted,
      mailThreadId: held.ceiling.mailThreadId ?? ceiling.mailThreadId,
      trustedSender: held.ceiling.trustedSender === true && ceiling.trustedSender === true,
    },
    byMember: held.byMember,
    note: appendNote(held.note, request.note),
    // Whatever arrives soonest decides: a reply while it waits starts it now.
    notBeforeAt:
      held.notBeforeAt && request.notBeforeAt
        ? new Date(
            Math.min(Date.parse(held.notBeforeAt), request.notBeforeAt.getTime()),
          ).toISOString()
        : undefined,
  };
}

// ───────────────────────────── the queue

let passing = false;
let passAgain = false;

/** Look at the queue soon, however many things asked. */
function schedulePass(): void {
  // Tests start each pickup themselves, so what they assert isn't racing it.
  if (!autoStart) return;
  void track(
    dispatchTodoPickups().catch((error) => {
      // eslint-disable-next-line no-console
      console.error("[todo-pickups] queue pass failed", error);
    }),
  );
}

let autoStart = true;

/** Tests drive the queue by hand. */
export function setTodoPickupAutoStartForTests(enabled: boolean): void {
  autoStart = enabled;
}

const PRIORITY_RANK =
  "CASE WHEN todo.priority = 'urgent' THEN 0 WHEN todo.priority = 'high' THEN 1 WHEN todo.priority = 'medium' THEN 2 WHEN todo.priority = 'low' THEN 3 ELSE 4 END";

/**
 * The order the heartbeat starts queued pickups in. Anything saying what's next
 * reads this, so it can't disagree with what happens.
 */
export function inDispatchOrder<T extends ObjectLiteral>(
  query: SelectQueryBuilder<T>,
): SelectQueryBuilder<T> {
  return query
    .orderBy(PRIORITY_RANK, "ASC")
    .addOrderBy("CASE WHEN todo.dueAt IS NULL THEN 1 ELSE 0 END", "ASC")
    .addOrderBy("todo.dueAt", "ASC")
    .addOrderBy("pickup.acceptedAt", "ASC")
    .addOrderBy("pickup.id", "ASC");
}

/**
 * One pass of the queue: for each AI Employee with nothing running, start its
 * next due pickup, highest priority first. Runs on the heartbeat and whenever a
 * pickup is asked for or ends.
 */
export async function dispatchTodoPickups(now: Date = new Date()): Promise<void> {
  if (passing) {
    passAgain = true;
    return;
  }
  passing = true;
  try {
    do {
      passAgain = false;
      await reclaimLapsedPickups(now);
      await startDuePickups(now);
    } while (passAgain);
  } finally {
    passing = false;
  }
}

/**
 * Each AI Employee's next due pickup, once a pass. It reads a window at a time and
 * leaves out everyone already looked at, so one employee with a long queue, in any
 * company, can't hide everyone else's work behind it.
 */
async function startDuePickups(now: Date): Promise<void> {
  const running = await repo().find({
    where: { status: "running", leaseExpiresAt: MoreThan(now) },
    select: { id: true, employeeId: true },
  });
  const busy = new Set(running.map((row) => row.employeeId));
  await holdAllDue([...busy], "employee_busy", now);
  const seen = new Set(busy);
  for (;;) {
    const query = repo()
      .createQueryBuilder("pickup")
      .innerJoin(Todo, "todo", "CAST(todo.id AS text) = pickup.todoId")
      .where("pickup.status = :queued", { queued: "queued" })
      .andWhere("pickup.notBeforeAt <= :now", { now });
    if (seen.size > 0) {
      query.andWhere("pickup.employeeId NOT IN (:...seen)", { seen: [...seen] });
    }
    const due = await inDispatchOrder(query).limit(DISPATCH_WINDOW).getMany();
    if (due.length === 0) return;
    for (const pickup of due) {
      if (seen.has(pickup.employeeId)) continue;
      seen.add(pickup.employeeId);
      if (workBlocked(pickup.companyId, { employeeId: pickup.employeeId }).blocked) {
        await holdAllDue([pickup.employeeId], "standdown", now);
        continue;
      }
      const model = await getActiveModel(pickup.employeeId).catch(() => null);
      if (!model) {
        await endWithoutRunning(pickup, "skipped", "The AI Employee has no AI Model connected.");
        // It may have more queued, and they end the same way on the next pass.
        seen.delete(pickup.employeeId);
        continue;
      }
      if (!isModelAvailable(model)) {
        await holdAllDue([pickup.employeeId], "model_unavailable", now);
        continue;
      }
      if (localRuns.size >= MAX_RUNNING_PER_PROCESS) return;
      void track(
        executeTodoPickup(pickup.id).catch((error) => {
          // eslint-disable-next-line no-console
          console.error(`[todo-pickups] pickup ${pickup.id} failed`, error);
        }),
      );
      await holdAllDue([pickup.employeeId], "employee_busy", now, pickup.id);
    }
  }
}

/** Say why these employees' due pickups aren't running, where that changed. */
async function holdAllDue(
  employeeIds: string[],
  hold: TodoPickupHold,
  now: Date,
  except?: string,
): Promise<void> {
  if (employeeIds.length === 0) return;
  const these = {
    employeeId: In(employeeIds),
    status: "queued" as const,
    notBeforeAt: LessThanOrEqual(now),
    ...(except ? { id: Not(except) } : {}),
  };
  // Not() alone would miss the ones holding nothing yet.
  await repo().update({ ...these, hold: IsNull() }, { hold });
  await repo().update({ ...these, hold: Not(hold) }, { hold });
}

/** A claim nobody renewed died with its process: back in the queue as the same pickup. */
async function reclaimLapsedPickups(now: Date): Promise<void> {
  const lapsed = await repo().find({
    where: { status: "running", leaseExpiresAt: LessThanOrEqual(now) },
    take: DISPATCH_WINDOW,
  });
  for (const pickup of lapsed) {
    if (pickup.attempt >= MAX_ATTEMPTS) {
      await endWithoutRunning(
        pickup,
        "failed",
        "It kept being cut off before it could finish.",
        "running",
      );
      continue;
    }
    await repo().update(
      { id: pickup.id, status: "running", leaseExpiresAt: LessThanOrEqual(now) },
      { status: "queued", workerId: null, leaseExpiresAt: null, notBeforeAt: now, hold: null },
    );
  }
}

/**
 * Pick the queue back up after migrations. SQLite is one process, so every claim
 * it finds is dead. Postgres may have live sibling replicas, so it leaves theirs
 * to lapse.
 */
export async function bootTodoPickups(): Promise<void> {
  if (config.db.driver !== "postgres") {
    await repo().update(
      { status: "running" },
      { status: "queued", workerId: null, leaseExpiresAt: null, notBeforeAt: new Date(), hold: null },
    );
  }
  schedulePass();
}

// ───────────────────────────── running one

/** Whether the Member a pickup runs under may still lend it their authority. */
async function memberAuthorityStands(pickup: TodoPickup): Promise<boolean> {
  if (pickup.authority !== "member") return true;
  if (!pickup.requesterUserId) return false;
  const [membership, user] = await Promise.all([
    AppDataSource.getRepository(Membership).findOneBy({
      companyId: pickup.companyId,
      userId: pickup.requesterUserId,
    }),
    AppDataSource.getRepository(User).findOneBy({ id: pickup.requesterUserId }),
  ]);
  return Boolean(
    membership && user && user.sessionVersion === pickup.requesterSessionVersion,
  );
}

/** What the delegating Member's Finance access lets this session's links say. */
async function delegatingFinanceAccess(pickup: TodoPickup): Promise<FinanceAccess> {
  if (pickup.authority !== "member" || !pickup.requesterUserId) return "full";
  const membership = await AppDataSource.getRepository(Membership).findOneBy({
    companyId: pickup.companyId,
    userId: pickup.requesterUserId,
  });
  if (!membership) return "none";
  return membership.role === "owner" || membership.role === "admin"
    ? "full"
    : membership.financeAccess;
}

/** Every runtime callback a session's activity listens to, wired into one recorder. */
function recorderCallbacks(
  recorder: ChatTurnActivityRecorder,
): NonNullable<ChatOptions["activity"]> {
  return {
    onToolUse: (name, input, callId) => recorder.toolUse(name, input, callId),
    onToolResult: (name, result, callId) => recorder.toolResult(name, result, callId),
    onReasoning: (delta, block) => recorder.reasoning(delta, block),
    onReasoningEnd: (block) => recorder.reasoningEnd(block),
    onModelRetry: (retry) => recorder.modelRetry(retry),
    onModelOutage: (outage) => recorder.modelOutage(outage),
    onRuntimeWait: (wait) => recorder.runtimeWait(wait),
    onCompact: (info) => recorder.compact(info),
    onApiKeyFailover: (change) => recorder.apiKeyFailover(change),
    onServedModelChange: (change) => recorder.servedModelChange(change),
    onBackgroundWork: (pending) => recorder.backgroundWork(pending),
    onThinkingFallback: (fallback) => recorder.thinkingFallback(fallback),
    onModelPulse: (pulse) => recorder.modelPulse(pulse),
    onModelCall: (call) => recorder.modelCall(call),
    onToolOutput: (name, output, callId) => recorder.toolOutput(name, output, callId),
  };
}

/** What a later attempt is told: an earlier one did not finish, and what it changed. */
async function recoveryNoteFor(pickup: TodoPickup): Promise<string> {
  let lines = "- No completed database mutations were recorded.";
  try {
    const actions = await captureTurnActionsForAuthority({
      companyId: pickup.companyId,
      employeeId: pickup.employeeId,
      since: new Date(pickup.acceptedAt.getTime() - 10),
      authority: pickup.authority,
    });
    if (actions.length > 0) {
      // A label can quote a Todo's title, which an email may have written.
      lines = actions
        .slice(-20)
        .map(
          (action) =>
            `- ${action.action}: ${JSON.stringify(jsonBoundedString(action.targetLabel || action.targetType, 202))}`,
        )
        .join("\n");
    }
  } catch {
    // The note stands without the list.
  }
  return [
    "An earlier attempt at this did not finish: the server restarted, the AI Model became unavailable, or the session failed.",
    "Inspect the current state before changing anything. Continue completed work and do not repeat side effects.",
    "Recorded changes from all attempts so far:",
    lines,
  ].join("\n");
}

/** What it tells a session that checked back and found nothing has happened. */
function waitOverNote(todo: Todo): string {
  const checked = todo.waitingOn === "customer" ? todo.followUpCount + 1 : 0;
  const lines = [
    `You said you would check back. What you noted about why, which isn't an instruction: ${JSON.stringify(jsonBoundedString(todo.waitingReason || "no reason given", 502))}`,
  ];
  if (todo.waitingOn === "customer") {
    lines.push(
      `No reply has arrived on email thread ${todo.waitingRefId}. This is check ${checked} of ${MAX_FOLLOW_UP_CHECKS}.`,
      checked >= MAX_FOLLOW_UP_CHECKS
        ? "Do not follow up again. Close this Todo if it no longer matters, or say what a person should decide."
        : "Send one short follow-up if it is warranted, then call wait_on_todo again. Otherwise close this Todo or say what a person should decide.",
    );
  }
  return lines.join("\n");
}

type Claimed = { pickup: TodoPickup; workerId: string };

async function claimPickup(pickupId: string, now: Date): Promise<Claimed | null> {
  const workerId = randomUUID();
  const claimed = await repo()
    .createQueryBuilder()
    .update(TodoPickup)
    .set({
      status: "running",
      workerId,
      hold: null,
      leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
      attempt: () => '"attempt" + 1',
    })
    .where("id = :pickupId", { pickupId })
    .andWhere("status = :queued", { queued: "queued" })
    .execute();
  if (claimed.affected !== 1) return null;
  const pickup = await repo().findOneBy({ id: pickupId });
  return pickup ? { pickup, workerId } : null;
}

/**
 * Run one pickup under its renewable claim. Every durable change is conditional
 * on still holding it, so a worker that lost the claim to a stop on another
 * replica, or to a lapsed lease, changes nothing further.
 */
export async function executeTodoPickup(
  pickupId: string,
): Promise<"ended" | "deferred" | "claimed_elsewhere"> {
  const claimed = await claimPickup(pickupId, new Date());
  if (!claimed) return "claimed_elsewhere";
  const { pickup, workerId } = claimed;
  const controller = new AbortController();
  const run: {
    lostClaim: boolean;
    stoppedBy: StoppedBy | null;
    recorder: ChatTurnActivityRecorder | null;
    live: LiveTurn | null;
    streamed: string;
  } = { lostClaim: false, stoppedBy: null, recorder: null, live: null, streamed: "" };

  const loseClaim = () => {
    run.lostClaim = true;
    controller.abort();
  };
  localRuns.set(pickup.id, {
    abort: loseClaim,
    // Keeps the claim, so this worker writes the end itself.
    stop: (by) => {
      if (run.lostClaim) return false;
      run.stoppedBy = by;
      run.recorder?.stopped(by.name);
      controller.abort();
      return true;
    },
  });

  let renewing = false;
  const renew = async () => {
    if (renewing || run.lostClaim) return;
    renewing = true;
    try {
      const renewed = await repo().update(
        { id: pickup.id, status: "running", workerId },
        { leaseExpiresAt: new Date(Date.now() + LEASE_MS) },
      );
      if (renewed.affected !== 1) loseClaim();
    } catch {
      // Carrying on while the database can't renew would let another worker
      // claim the same session. Stop, and let recovery take it back.
      loseClaim();
    } finally {
      renewing = false;
    }
  };
  const renewal = setInterval(() => void renew(), RENEW_MS);
  renewal.unref?.();

  const snapshot = createReplyTextSnapshotter({
    intervalMs: REPLY_SNAPSHOT_MS,
    save: (text) =>
      repo().update({ id: pickup.id, status: "running", workerId }, { replyText: text }),
    onPersistenceError: (error) => {
      // eslint-disable-next-line no-console
      console.error(`[todo-pickups] reply snapshot failed pickup=${pickup.id}`, error);
    },
  });

  const letGo = async (): Promise<"claimed_elsewhere"> => {
    await run.recorder?.close();
    run.live?.detach();
    return "claimed_elsewhere";
  };

  /** Back in the queue, a wait and not a failure. */
  const requeue = async (hold: TodoPickupHold, at: Date, reachedModel: boolean) => {
    snapshot.cancel();
    const moved = await repo().update(
      { id: pickup.id, status: "running", workerId },
      {
        status: "queued",
        hold,
        workerId: null,
        leaseExpiresAt: null,
        notBeforeAt: at,
        replyText: "",
        ...(reachedModel ? {} : { attempt: Math.max(0, pickup.attempt - 1) }),
      },
    );
    await run.recorder?.close();
    run.live?.detach();
    announce(pickup.companyId, null);
    return moved.affected === 1 ? ("deferred" as const) : ("claimed_elsewhere" as const);
  };

  const end = (outcome: EndOutcome) =>
    finishPickup({ pickup, workerId, outcome, recorder: run.recorder, live: run.live, snapshot });

  /** A real failure: try again later, a bounded number of times. */
  const retryOrFail = async (message: string, projectId: string) => {
    const failures = pickup.failures + 1;
    const delay = RETRY_DELAYS_MS[failures - 1];
    if (delay === undefined) return end({ status: "failed", error: message });
    snapshot.cancel();
    const moved = await repo().update(
      { id: pickup.id, status: "running", workerId },
      {
        status: "queued",
        hold: "retrying",
        failures,
        errorMessage: message.slice(0, COMMENT_CHARS),
        workerId: null,
        leaseExpiresAt: null,
        notBeforeAt: new Date(Date.now() + delay),
        replyText: "",
      },
    );
    await run.recorder?.close();
    run.live?.detach();
    announce(pickup.companyId, projectId);
    return moved.affected === 1 ? ("deferred" as const) : ("claimed_elsewhere" as const);
  };

  try {
    const [todo, employee] = await Promise.all([
      AppDataSource.getRepository(Todo).findOneBy({ id: pickup.todoId }),
      AppDataSource.getRepository(AIEmployee).findOneBy({
        id: pickup.employeeId,
        companyId: pickup.companyId,
      }),
    ]);
    const project = todo
      ? await AppDataSource.getRepository(Project).findOneBy({
          id: todo.projectId,
          companyId: pickup.companyId,
        })
      : null;

    const live = openLiveTurn(pickup.id, pickup.todoId);
    const recorder = new ChatTurnActivityRecorder(
      {
        companyId: pickup.companyId,
        conversationId: pickup.todoId,
        messageId: pickup.id,
        attempt: Math.max(1, pickup.attempt),
      },
      await nextChatActivityOrdinal(pickup.id),
      { live },
    );
    run.recorder = recorder;
    run.live = live;

    if (!todo || !project || !employee) {
      recorder.notice("ended", "The Todo or the AI Employee is gone");
      return await end({ status: "skipped", error: "The Todo or the AI Employee is gone." });
    }
    // It may have moved on while it queued. Nothing here is a failure.
    const stillFor =
      pickup.trigger === "review"
        ? todo.reviewerEmployeeId === employee.id && todo.status === "in_review"
        : todo.assigneeEmployeeId === employee.id && WORKABLE.includes(todo.status);
    if (!stillFor) {
      recorder.notice("ended", "This Todo has moved on");
      return await end({ status: "skipped", error: "This Todo has moved on." });
    }
    if (!(await hasProjectAccess(project, { kind: "ai", id: employee.id }, "read"))) {
      recorder.notice("ended", "The AI Employee can no longer open this Project");
      return await end({
        status: "failed",
        error: `${employee.name} can no longer open this Project.`,
      });
    }
    // A Standdown placed while it queued wins. It stays queued and starts after
    // the lift, as a Wakeup does: a stop must never lose work somebody asked for.
    if (workBlocked(pickup.companyId, { employeeId: employee.id }).blocked) {
      return await requeue("standdown", new Date(), false);
    }
    const model = await getActiveModel(employee.id);
    if (!model) {
      recorder.notice("ended", "No AI Model connected");
      return await end({
        status: "skipped",
        error: `${employee.name} has no AI Model connected.`,
      });
    }
    if (!isModelAvailable(model)) return await requeue("model_unavailable", new Date(), false);
    if (!(await memberAuthorityStands(pickup))) {
      // Carrying on with work already started shouldn't die with a sign-out, so
      // it continues as the employee itself, only preparing. Nobody started this
      // one by hand, so nobody's access is being borrowed.
      if (!CONTINUATIONS.includes(pickup.trigger)) {
        recorder.notice("ended", "The Member who asked can no longer lend their access");
        return await end({
          status: "failed",
          error:
            "The Member who started this signed out everywhere or left the company, so it can't run under their access. Assign it again to start it.",
        });
      }
      pickup.authority = "employee";
      pickup.requesterUserId = null;
      pickup.requesterSessionVersion = null;
      pickup.proactiveReview = true;
      pickup.trustedSender = false;
      pickup.mailDeliveryMode = narrowestDelivery(pickup.mailDeliveryMode, "review");
      await repo().update(
        { id: pickup.id, status: "running", workerId },
        {
          authority: "employee",
          requesterUserId: null,
          requesterSessionVersion: null,
          proactiveReview: true,
          trustedSender: false,
          mailDeliveryMode: pickup.mailDeliveryMode,
        },
      );
    }

    // The check-back it asked for came. If a reply already ended the wait there
    // is nothing to check, and if it's still waiting this is one more follow-up.
    if (pickup.trigger === "wait_over") {
      if (!todo.waitingOn) {
        recorder.notice("ended", "The wait already ended");
        return await end({ status: "skipped", error: "The wait already ended." });
      }
      pickup.note = waitOverNote(todo);
      if (todo.waitingOn === "customer") todo.followUpCount += 1;
    }
    if (todo.waitingOn) {
      todo.waitingOn = null;
      todo.waitingRefId = null;
      todo.waitingReason = "";
      todo.waitingSince = null;
      todo.waitingCheckAt = null;
      // Only what changed, so this can't put back limits it loaded before they narrowed.
      await AppDataSource.getRepository(Todo).update(
        { id: todo.id },
        {
          waitingOn: null,
          waitingRefId: null,
          waitingReason: "",
          waitingSince: null,
          waitingCheckAt: null,
          followUpCount: todo.followUpCount,
        },
      );
    }

    // What it may do is decided now, not when it was queued.
    const held = rowHeldToFloor(pickup, todo);
    if (held) {
      Object.assign(pickup, held);
      await repo().update({ id: pickup.id, status: "running", workerId }, held);
    }

    if (run.stoppedBy) return await end({ status: "stopped", reply: "" });

    // The board shows the pickup at once. Going back is decided at the end, and
    // only if nothing happened.
    let priorStatus = pickup.priorStatus;
    if (pickup.trigger !== "review" && todo.status !== "in_progress") {
      priorStatus = priorStatus ?? todo.status;
      todo.status = "in_progress";
      await AppDataSource.getRepository(Todo).save(todo);
      await repo().update({ id: pickup.id, status: "running", workerId }, { priorStatus });
      pickup.priorStatus = priorStatus;
    }

    const links =
      (
        await presentTodoLinks(pickup.companyId, [todo.id], {
          kind: "employee",
          employeeId: employee.id,
          financeAccessLimit: await delegatingFinanceAccess(pickup),
        })
      ).get(todo.id) ?? [];
    const assignee =
      pickup.trigger === "review" && todo.assigneeEmployeeId
        ? await AppDataSource.getRepository(AIEmployee).findOneBy({
            id: todo.assigneeEmployeeId,
            companyId: pickup.companyId,
          })
        : null;
    const brief = composeTodoPickupBrief({
      project,
      todo,
      trigger: pickup.trigger,
      note: pickup.note,
      links,
      assignee,
      // A trusted sender's session has real work to do in the browser.
      preparationOnly: pickup.proactiveReview && !pickup.trustedSender,
      recoveryNote: pickup.attempt > 1 ? await recoveryNoteFor(pickup) : null,
    });
    const startTainted = pickup.tainted || todo.tainted;
    if (startTainted !== pickup.tainted) {
      pickup.tainted = startTainted;
      await repo().update({ id: pickup.id, status: "running", workerId }, { tainted: true });
    }
    const history = await todoDiscussionHistory(pickup.companyId, todo.id, employee.id, "");

    const base: Omit<ChatOptions, "requesterUserId" | "requesterSessionVersion" | "toolAuthority"> = {
      workloadKey: pickup.id,
      throwOnWorkloadUnavailable: true,
      maxSteps: PICKUP_MAX_STEPS,
      timeoutMs: CHAT_HARD_TIMEOUT_MS,
      signal: controller.signal,
      wasInterrupted: () => run.stoppedBy !== null,
      startTainted,
      reasoningSummaries: true,
      mailDeliveryMode: (pickup.mailDeliveryMode as MailDeliveryMode | null) ?? null,
      proactiveReview: pickup.proactiveReview,
      // Trust comes from an email, for the employee itself. A Member's own session
      // has what that Member has instead.
      trustedSender: pickup.trustedSender && pickup.authority === "employee",
      browserSessionKey: pickup.todoId,
      mailThreadId: pickup.mailThreadId,
      todoPickupId: pickup.id,
      extraToolset: ["get_todo", "add_todo_comment"],
      onProgress: (progress: AgentProgress) => {
        recorder.progress(progress);
        live.progress(progress);
      },
      onWorkStarted: () => {
        recorder.turnStarted(pickup.attempt > 1 ? "resume" : "start");
        announce(pickup.companyId, todo.projectId);
        if (pickup.attempt <= 1) void auditPickup(pickup, "start", project);
      },
      onSensitiveValues: (values) => recorder.setSensitiveValues(values),
      onPayloadsWithheld: (why) => recorder.withholdPayloads(why),
      activity: recorderCallbacks(recorder),
    };
    const options: ChatOptions =
      pickup.authority === "member" &&
      pickup.requesterUserId &&
      typeof pickup.requesterSessionVersion === "number"
        ? {
            ...base,
            requesterUserId: pickup.requesterUserId,
            requesterSessionVersion: pickup.requesterSessionVersion,
          }
        : { ...base, toolAuthority: "employee" };

    let result: ChatResult;
    try {
      result = await streamChatWithEmployee(
        pickup.companyId,
        employee.id,
        brief,
        history,
        (chunk) => {
          run.streamed += chunk;
          live.appendText(chunk);
          snapshot.report(run.streamed);
        },
        {
          ...options,
          // The Todo's thread is the transcript it replays, so that is what it
          // serializes on: an @-mention reply and a pickup never answer at once.
          workloadScope: `todo:${todo.id}`,
        },
      );
    } catch (error) {
      if (run.stoppedBy) {
        return await end({ status: "stopped", reply: run.streamed.trim() });
      }
      if (run.lostClaim) return await letGo();
      if (error instanceof EmployeeWorkloadBusyError) {
        return await requeue("thread_busy", new Date(Date.now() + BUSY_RETRY_MS), false);
      }
      throw error;
    }

    await snapshot.flush();
    if (!run.lostClaim) await renew();
    if (run.lostClaim && !run.stoppedBy) return await letGo();
    if (run.stoppedBy) {
      return await end({
        status: "stopped",
        reply: result.reply.trim() || run.streamed.trim(),
        attachmentIds: result.attachmentIds,
        tainted: result.tainted === true,
      });
    }
    // The AI Model went down under it: a wait, not a failure.
    if (result.status === "error" && result.unavailable) {
      return await requeue("model_unavailable", new Date(), true);
    }
    // A Standdown landing as the turn started reads as an error from the seam.
    if (result.status !== "ok" && workBlocked(pickup.companyId, { employeeId: employee.id }).blocked) {
      return await requeue("standdown", new Date(), false);
    }
    if (result.status === "ok") {
      return await end({
        status: "done",
        reply: result.finalText?.trim() || result.reply.trim(),
        attachmentIds: result.attachmentIds,
        tainted: result.tainted === true,
      });
    }
    return await retryOrFail(result.reply || "The session failed.", todo.projectId);
  } catch (error) {
    if (run.stoppedBy) return end({ status: "stopped", reply: run.streamed.trim() });
    if (run.lostClaim) return letGo();
    // eslint-disable-next-line no-console
    console.error(`[todo-pickups] pickup failed pickup=${pickup.id}`, error);
    const detail = (error instanceof Error ? error.message : String(error))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
    return end({ status: "failed", error: `Genosyn couldn't finish this. ${detail}` });
  } finally {
    snapshot.cancel();
    clearInterval(renewal);
    localRuns.delete(pickup.id);
    if (run.live) {
      run.live.detach();
      releaseLiveTurn(run.live);
    }
    // Its place in the queue is free for the next one.
    schedulePass();
  }
}

type EndOutcome = {
  status: "done" | "failed" | "stopped" | "skipped";
  reply?: string;
  error?: string;
  attachmentIds?: string[];
  tainted?: boolean;
};

/** Post the session's report on its Todo. Never fails the pickup. */
async function postReport(
  pickup: Pick<TodoPickup, "id" | "todoId" | "employeeId" | "companyId">,
  body: string,
  attachmentIds: string[] = [],
): Promise<void> {
  try {
    const comments = AppDataSource.getRepository(TodoComment);
    const comment = await comments.save(
      comments.create({
        todoId: pickup.todoId,
        authorUserId: null,
        authorEmployeeId: pickup.employeeId,
        body: body.slice(0, COMMENT_CHARS),
        pending: false,
        pickupId: pickup.id,
      }),
    );
    await bindAttachmentsToMessage(attachmentIds, comment.id, pickup.companyId);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[todo-pickups] could not post the report of ${pickup.id}`, error);
  }
}

/**
 * End a pickup: the row first, conditional on the claim, so only the worker that
 * holds it writes the end. Then the activity's summary, the report on the thread,
 * and whatever follows: the Todo back where it was if nothing happened, the
 * retry for work left open, a page when it needs a person, and any run that was
 * asked for while this one ran.
 */
/**
 * Close this Todo's browser and finish its recording when the session ends, unless the
 * next turn is about to need that page: it's waiting on a browser approval, which fires
 * there, or the answer already came and the next session is on its way. Its video then
 * ends when the page does, and covers the submit. It never fails the session it follows.
 */
async function finishTodoBrowserWork(pickup: TodoPickup): Promise<void> {
  const { todoId } = pickup;
  try {
    if (!(await AppDataSource.getRepository(BrowserSession).existsBy({ todoId }))) return;
    const todo = await AppDataSource.getRepository(Todo).findOne({
      where: { id: todoId },
      select: { id: true, waitingOn: true },
    });
    if (todo?.waitingOn === "browser_approval") return;
    const ending = await repo().findOne({
      where: { id: pickup.id },
      select: { id: true, rerunJson: true },
    });
    if (ending?.rerunJson) return;
    if (await repo().existsBy({ todoId, status: "queued", notBeforeAt: LessThanOrEqual(new Date()) })) {
      return;
    }
    const { closeBrowserSessionsForTodo } = await import("./browserSessions.js");
    await closeBrowserSessionsForTodo(todoId);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[todo-pickups] could not finish browser work on ${todoId}`, error);
  }
}

/** What a Todo's History says about a session. It never fails the session it records. */
async function auditPickup(
  pickup: TodoPickup,
  what: "start" | "done" | "failed" | "stopped",
  known?: Project | null,
): Promise<void> {
  try {
    const todo = await AppDataSource.getRepository(Todo).findOneBy({ id: pickup.todoId });
    if (!todo) return;
    const project =
      known ?? (await AppDataSource.getRepository(Project).findOneBy({ id: todo.projectId }));
    await recordAudit({
      companyId: pickup.companyId,
      actorEmployeeId: pickup.employeeId,
      action: `todo.pickup.${what}`,
      targetType: "todo",
      targetId: todo.id,
      targetLabel: project ? `${project.key}-${todo.number}: ${todo.title}` : todo.title,
      metadata: { trigger: pickup.trigger },
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[todo-pickups] could not audit pickup ${pickup.id}`, error);
  }
}

async function finishPickup(args: {
  pickup: TodoPickup;
  workerId: string;
  outcome: EndOutcome;
  recorder: ChatTurnActivityRecorder | null;
  live: LiveTurn | null;
  snapshot: { flush: () => Promise<void>; cancel: () => void };
}): Promise<"ended" | "claimed_elsewhere"> {
  const { pickup, outcome, recorder, live } = args;
  args.snapshot.cancel();
  await args.snapshot.flush();
  const stopped = outcome.status === "stopped";
  const summary =
    recorder?.summarize({
      status: outcome.status === "done" ? "ok" : stopped ? "interrupted" : "error",
      startedAt: pickup.acceptedAt,
    }) ?? null;
  const finalized = await repo().update(
    { id: pickup.id, status: "running", workerId: args.workerId },
    {
      status: outcome.status,
      hold: null,
      workerId: null,
      leaseExpiresAt: null,
      notBeforeAt: null,
      endedAt: new Date(),
      errorMessage: (outcome.error ?? "").slice(0, COMMENT_CHARS),
      replyText: (outcome.reply ?? "").slice(0, COMMENT_CHARS),
      tainted: pickup.tainted || outcome.tainted === true,
      ...(summary ? { activityJson: JSON.stringify(summary) } : {}),
    },
  );
  if (finalized.affected !== 1) {
    await recorder?.close();
    live?.detach();
    return "claimed_elsewhere";
  }
  if (recorder && summary) await recorder.finish(summary);
  await releaseChatWorkloadLeaseByOwner(pickup.id).catch(() => undefined);
  if (outcome.status !== "skipped") await auditPickup(pickup, outcome.status);
  await finishTodoBrowserWork(pickup);

  if (outcome.tainted === true) await markTodoTainted(pickup.todoId);
  if (outcome.status === "done") {
    await postReport(pickup, outcome.reply || "Finished without writing a report.", outcome.attachmentIds);
  } else if (stopped && outcome.reply) {
    await postReport(pickup, outcome.reply, outcome.attachmentIds);
  } else if (outcome.status === "failed" && outcome.error) {
    await postReport(pickup, `I couldn't work on this — ${outcome.error}`);
  }

  // Read now: a request that arrived while it ran wrote this until the row ended.
  const ended = await repo().findOneBy({ id: pickup.id });
  await afterPickupEnded({
    pickup: ended ?? pickup,
    status: outcome.status,
    error: outcome.error ?? "",
    rerun: ended?.rerunJson ?? null,
  });
  live?.finish();
  announce(pickup.companyId, null);
  return "ended";
}

/** A pickup ended before any session ran, or a person stopped one nobody is running. */
async function endWithoutRunning(
  pickup: TodoPickup,
  status: "skipped" | "stopped" | "failed",
  error: string,
  from: "queued" | "running" = "queued",
): Promise<void> {
  const ended = await repo().update(
    { id: pickup.id, status: from },
    {
      status,
      hold: null,
      workerId: null,
      leaseExpiresAt: null,
      notBeforeAt: null,
      endedAt: new Date(),
      errorMessage: error,
    },
  );
  if (ended.affected !== 1) return;
  await releaseChatWorkloadLeaseByOwner(pickup.id).catch(() => undefined);
  if (status === "failed") {
    await postReport(pickup, `I couldn't work on this — ${error}`);
    await afterPickupEnded({ pickup, status, error, rerun: pickup.rerunJson });
  } else if (pickup.rerunJson) {
    await afterPickupEnded({ pickup, status, error, rerun: pickup.rerunJson });
  }
  announce(pickup.companyId, null);
}

/** What a finished pickup means for its Todo. */
async function afterPickupEnded(args: {
  pickup: TodoPickup;
  status: "done" | "failed" | "stopped" | "skipped";
  error: string;
  rerun: string | null;
}): Promise<void> {
  const { pickup, status } = args;
  const todos = AppDataSource.getRepository(Todo);
  const todo = await todos.findOneBy({ id: pickup.todoId });
  if (!todo) return;
  // Done with this row: what it asked for next is decided here, once.
  if (args.rerun) await repo().update({ id: pickup.id }, { rerunJson: null });

  // Nothing happened: put the card back where it was, unless the employee moved
  // it itself, in which case its word stands.
  if (
    (status === "failed" || status === "stopped") &&
    pickup.priorStatus &&
    pickup.trigger !== "review" &&
    todo.status === "in_progress" &&
    todo.assigneeEmployeeId === pickup.employeeId
  ) {
    todo.status = pickup.priorStatus as TodoStatus;
    await todos.save(todo);
  }

  const project = await AppDataSource.getRepository(Project).findOneBy({
    id: todo.projectId,
    companyId: pickup.companyId,
  });
  if (!project) return;

  if (status === "failed") {
    await pageSomeone(pickup, todo, project, {
      title: `Couldn't finish ${project.key}-${todo.number}`,
      body: args.error,
    });
  }

  if (args.rerun) {
    const stored = JSON.parse(args.rerun) as StoredRerun;
    await requestTodoPickup({
      companyId: pickup.companyId,
      todoId: pickup.todoId,
      employeeId: stored.employeeId,
      trigger: stored.trigger,
      authority: stored.authority,
      ceiling: stored.ceiling,
      byMember: stored.byMember,
      overLimits: stored.overLimits === true,
      note: stored.note,
      notBeforeAt: stored.notBeforeAt ? new Date(stored.notBeforeAt) : undefined,
    });
    return;
  }

  // It finished its session without finishing the Todo or saying what it needs.
  // That is one retry, told so; a second time a person hears, and it stops.
  if (
    status === "done" &&
    pickup.trigger !== "review" &&
    todo.status === "in_progress" &&
    !todo.waitingOn &&
    todo.assigneeEmployeeId === pickup.employeeId
  ) {
    if (pickup.trigger === "left_open") {
      await postReport(
        pickup,
        "I left this open twice without finishing it, so I've stopped. It needs someone to look at it.",
      );
      await pageSomeone(pickup, todo, project, {
        title: `${project.key}-${todo.number} needs a look`,
        body: "The AI Employee working on it ended twice without finishing it or saying what it needs.",
      });
      return;
    }
    await requestTodoPickup({
      companyId: pickup.companyId,
      todoId: pickup.todoId,
      employeeId: pickup.employeeId,
      trigger: "left_open",
      authority: authorityOfRow(pickup),
      ceiling: ceilingOfRow(pickup),
      byMember: false,
      note: "Your last session ended with this todo still open. Finish it now, or if you can't, say exactly what you need and move it back to \"todo\" with `update_todo`.",
    });
  }
}

function authorityOfRow(pickup: TodoPickup): TodoPickupAuthority {
  return pickup.authority === "member" &&
    pickup.requesterUserId &&
    typeof pickup.requesterSessionVersion === "number"
    ? {
        kind: "member",
        userId: pickup.requesterUserId,
        sessionVersion: pickup.requesterSessionVersion,
      }
    : { kind: "employee" };
}

function ceilingOfRow(pickup: TodoPickup): TodoPickupCeiling {
  return {
    mailDeliveryMode: pickup.mailDeliveryMode as MailDeliveryMode | null,
    proactiveReview: pickup.proactiveReview,
    tainted: pickup.tainted,
    mailThreadId: pickup.mailThreadId,
    trustedSender: pickup.trustedSender,
  };
}

/** The Member who should hear about this Todo: who asked, who filed it, or the owners. */
async function pageSomeone(
  pickup: TodoPickup,
  todo: Todo,
  project: Project,
  message: { title: string; body: string },
): Promise<void> {
  try {
    const memberships = AppDataSource.getRepository(Membership);
    const candidates = [pickup.requesterUserId, todo.createdById].filter(
      (id): id is string => Boolean(id),
    );
    let userIds: string[] = [];
    for (const userId of candidates) {
      if (await memberships.existsBy({ companyId: pickup.companyId, userId })) {
        userIds = [userId];
        break;
      }
    }
    if (userIds.length === 0) {
      const admins = await memberships.find({
        where: { companyId: pickup.companyId, role: In(["owner", "admin"]) },
      });
      userIds = admins.map((row) => row.userId);
    }
    const company = await AppDataSource.getRepository(Company).findOneBy({ id: pickup.companyId });
    if (!company || userIds.length === 0) return;
    await createNotifications(
      userIds.map((userId) => ({
        companyId: pickup.companyId,
        userId,
        kind: "todo_needs_attention" as const,
        title: message.title,
        body: message.body.slice(0, 300),
        link: `/c/${company.slug}/tasks/p/${project.slug}?todo=${encodeURIComponent(todo.id)}`,
        actorKind: "ai" as const,
        actorId: pickup.employeeId,
        entityKind: "todo" as const,
        entityId: todo.id,
      })),
    );
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[todo-pickups] could not page about ${pickup.todoId}`, error);
  }
}

/** Past its daily limit, a Todo waits for a person, who hears once a day. */
async function noticeCapped(todo: Todo, project: Project, employee: AIEmployee): Promise<void> {
  const already = await repo().existsBy({
    todoId: todo.id,
    status: "skipped",
    errorMessage: CAPPED_MESSAGE,
    endedAt: MoreThan(new Date(Date.now() - DAY_MS)),
  });
  if (already) return;
  const now = new Date();
  const row = await repo().save(
    repo().create({
      companyId: project.companyId,
      todoId: todo.id,
      employeeId: employee.id,
      trigger: "assigned",
      status: "skipped",
      authority: "employee",
      errorMessage: CAPPED_MESSAGE,
      acceptedAt: now,
      endedAt: now,
    }),
  );
  await postReport(row, `I've picked this up ${MAX_AUTOMATIC_PICKUPS_PER_DAY} times today, so I've stopped until someone looks at it. Press Start now to send me back.`);
  await pageSomeone(row, todo, project, {
    title: `${project.key}-${todo.number} needs a look`,
    body: "It reached its limit of automatic sessions for today, so it waits for a person.",
  });
}

/** Words a tainted turn wrote are on this Todo's thread: every later session starts tainted. */
export async function markTodoTainted(todoId: string): Promise<void> {
  await AppDataSource.getRepository(Todo).update({ id: todoId, tainted: false }, { tainted: true });
}

function announce(companyId: string, projectId: string | null): void {
  emitResourceChange(companyId, "todo", projectId ?? undefined, { trigger: false });
}

// ───────────────────────────── stopping

/**
 * Stop a pickup, queued or running. What it already did stays, and whatever it
 * had written becomes its report. `by` is null when the server stops it because
 * the Todo went to someone else.
 */
export async function stopTodoPickup(args: {
  pickup: TodoPickup;
  by: StoppedBy | null;
  reason?: string;
}): Promise<boolean> {
  const { pickup, by } = args;
  const stopper = by ?? { userId: "", name: null };
  if (localRuns.get(pickup.id)?.stop(stopper)) {
    if (by) await repo().update({ id: pickup.id }, { stoppedByUserId: by.userId });
    return true;
  }
  const current = await repo().findOneBy({ id: pickup.id });
  if (!current || !["queued", "running"].includes(current.status)) return false;

  const recorder = new ChatTurnActivityRecorder(
    {
      companyId: pickup.companyId,
      conversationId: pickup.todoId,
      messageId: pickup.id,
      attempt: Math.max(1, current.attempt),
    },
    await nextChatActivityOrdinal(pickup.id),
  );
  recorder.stopped(by?.name ?? null);
  await recorder.flush();
  const endedAt = new Date();
  const summary = await summarizeChatActivity({
    messageId: pickup.id,
    status: "interrupted",
    startedAt: current.acceptedAt,
    endedAt,
  });
  // Leaving `running` is also the stop signal to a worker on another replica:
  // its next renewal fails and it lets the session go.
  const finalized = await repo().update(
    { id: pickup.id, status: In(["queued", "running"]) },
    {
      status: "stopped",
      hold: null,
      workerId: null,
      leaseExpiresAt: null,
      notBeforeAt: null,
      endedAt,
      stoppedByUserId: by?.userId ?? null,
      errorMessage: args.reason ?? "",
      activityJson: JSON.stringify(summary),
    },
  );
  if (finalized.affected !== 1) {
    await recorder.close();
    return false;
  }
  await releaseChatWorkloadLeaseByOwner(pickup.id).catch(() => undefined);
  await recorder.finish(summary);
  if (current.replyText.trim()) await postReport(current, current.replyText);
  await afterPickupEnded({ pickup: current, status: "stopped", error: "", rerun: current.rerunJson });
  announce(pickup.companyId, null);
  return true;
}

/** Whatever is queued or running for this Todo stops: a person moved it on. */
export async function stopTodoPickupsFor(todoId: string, reason: string): Promise<void> {
  const active = await repo().findOneBy({ todoId, status: In(["queued", "running"]) });
  if (active) await stopTodoPickup({ pickup: active, by: null, reason });
}

/** Delete every pickup on these Todos, for when the Todos themselves go. */
export async function deleteTodoPickups(todoIds: readonly string[]): Promise<void> {
  if (todoIds.length === 0) return;
  const running = await repo().find({
    where: { todoId: In([...todoIds]), status: "running" },
    select: { id: true },
  });
  for (const row of running) localRuns.get(row.id)?.abort();
  const { deleteBrowserRecordingsForTodoIds } = await import("./browserRecordings.js");
  await deleteBrowserRecordingsForTodoIds(todoIds);
  await repo().delete({ todoId: In([...todoIds]) });
  await AppDataSource.getRepository(ConversationActivityEvent).delete({
    conversationId: In([...todoIds]),
  });
}

// ───────────────────────────── reading

async function viewsOf(
  companyId: string,
  rows: TodoPickup[],
  viewerUserId: string,
): Promise<TodoPickupView[]> {
  if (rows.length === 0) return [];
  const [employees, users] = await Promise.all([
    AppDataSource.getRepository(AIEmployee).find({
      where: { id: In([...new Set(rows.map((row) => row.employeeId))]), companyId },
    }),
    (async () => {
      const ids = [
        ...new Set(rows.flatMap((row) => (row.requesterUserId ? [row.requesterUserId] : []))),
      ];
      return ids.length ? AppDataSource.getRepository(User).findBy({ id: In(ids) }) : [];
    })(),
  ]);
  const employeeById = new Map(employees.map((row) => [row.id, row]));
  const userById = new Map(users.map((row) => [row.id, row]));
  return rows.map((row): TodoPickupView => {
    const employee = employeeById.get(row.employeeId);
    const user = row.requesterUserId ? userById.get(row.requesterUserId) : null;
    const activity: TurnActivitySummary | null = parseTurnActivitySummary(row.activityJson);
    return {
      id: row.id,
      todoId: row.todoId,
      status: row.status,
      trigger: row.trigger,
      hold: row.hold,
      employee: employee
        ? { id: employee.id, name: employee.name, slug: employee.slug, role: employee.role }
        : null,
      authority: row.authority,
      requester: user ? { id: user.id, name: user.name || user.email } : null,
      preparationOnly: row.proactiveReview,
      withBrowser: row.trustedSender,
      attempt: row.attempt,
      startedAt: row.acceptedAt.toISOString(),
      notBeforeAt: row.notBeforeAt?.toISOString() ?? null,
      endedAt: row.endedAt?.toISOString() ?? null,
      error: row.errorMessage || null,
      activity,
      access: accessOf(row, viewerUserId),
    };
  });
}

function accessOf(row: TodoPickup, viewerUserId: string): TurnActivityAccess {
  return turnActivityAccess({
    audience: "internal",
    authority:
      row.authority === "member" && row.requesterUserId
        ? { kind: "member", userId: row.requesterUserId }
        : { kind: "employee" },
    viewer: { kind: "member", userId: viewerUserId },
  });
}

/** One Todo's current pickup and its recent ones, newest first. */
export async function listTodoPickups(args: {
  companyId: string;
  todoId: string;
  viewerUserId: string;
}): Promise<{ active: TodoPickupView | null; recent: TodoPickupView[] }> {
  const [active, recent] = await Promise.all([
    repo().findOneBy({
      companyId: args.companyId,
      todoId: args.todoId,
      status: In(["queued", "running"]),
    }),
    repo().find({
      where: {
        companyId: args.companyId,
        todoId: args.todoId,
        status: Not(In(["queued", "running"])),
      },
      order: { createdAt: "DESC", id: "DESC" },
      take: 10,
    }),
  ]);
  const rows = [...(active ? [active] : []), ...recent];
  const views = await viewsOf(args.companyId, rows, args.viewerUserId);
  return active
    ? { active: views[0], recent: views.slice(1) }
    : { active: null, recent: views };
}

/** The pickups these comments reported, as this reader sees them. */
export async function presentCommentPickups(
  companyId: string,
  pickupIds: readonly string[],
  viewerUserId: string,
): Promise<Map<string, TodoPickupView>> {
  if (pickupIds.length === 0) return new Map();
  const rows = await repo().findBy({ id: In([...new Set(pickupIds)]), companyId });
  const views = await viewsOf(companyId, rows, viewerUserId);
  return new Map(views.map((view) => [view.id, view]));
}

export async function loadTodoPickup(
  companyId: string,
  todoId: string,
  pickupId: string,
): Promise<TodoPickup | null> {
  return repo().findOneBy({ id: pickupId, companyId, todoId });
}

/** One page of a pickup's steps, as this Member may see them. */
export async function readTodoPickupActivity(args: {
  pickup: TodoPickup;
  viewerUserId: string;
  after: number;
  limit: number;
}) {
  const access = accessOf(args.pickup, args.viewerUserId);
  const rows = await listChatActivity(args.pickup.id, args.after, args.limit + 1);
  return {
    events: rows
      .slice(0, args.limit)
      .map((event) => activityEventFor(event, access))
      .filter((event) => event !== null),
    more: rows.length > args.limit,
    status: args.pickup.status,
    access,
  };
}

/** Follow one pickup live, from the reader's cursor to its end. */
export async function followTodoPickup(args: {
  pickup: TodoPickup;
  viewerUserId: string;
  after: number;
  send: (event: string, data: unknown) => void;
  signal: AbortSignal;
}): Promise<void> {
  const access = accessOf(args.pickup, args.viewerUserId);
  const source: FollowSource = {
    async read() {
      const row = await repo().findOneBy({ id: args.pickup.id });
      if (!row) return null;
      return {
        id: row.id,
        // What a follower reads as still going: the feed's word, not the row's.
        status: row.status === "queued" || row.status === "running" ? "working" : row.status,
        text: row.replyText,
        startedAt: row.acceptedAt,
        attempt: row.attempt,
        progress: null,
        extra: { employeeId: row.employeeId, hold: row.hold, access },
      };
    },
    async finalFrames() {
      const row = await repo().findOneBy({ id: args.pickup.id });
      if (!row) return [];
      const [pickup] = await viewsOf(row.companyId, [row], args.viewerUserId);
      return [{ event: "final", data: { pickup } }];
    },
  };
  await followChatTurn({
    messageId: args.pickup.id,
    after: args.after,
    send: args.send,
    signal: args.signal,
    source,
    present: (event) => activityEventFor(event, access),
    presentProgress: (progress) => (access === "none" ? null : progress),
    showPulse: access !== "none",
    showToolOutput: access === "full",
  });
}
