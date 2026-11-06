import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { In, IsNull, Not } from "typeorm";

import {
  INPUT_REQUEST_ANSWER_CHARS,
  INPUT_REQUEST_ANSWER_WINDOW_MS,
  INPUT_REQUEST_BODY_CHARS,
  INPUT_REQUEST_CODE_CHARS,
  INPUT_REQUEST_ESCALATE_AT_REMINDER,
  INPUT_REQUEST_EXPIRY_MS,
  INPUT_REQUEST_MIN_WINDOW_MS,
  INPUT_REQUEST_READY_WAIT_MS,
  INPUT_REQUEST_TITLE_CHARS,
  MAX_CODES_PER_INPUT_REQUEST,
  MAX_OPEN_INPUT_REQUESTS_PER_EMPLOYEE,
  OPEN_INPUT_REQUEST_STATUSES,
  inputRequestPageOrigin,
  inputRequestReminderDelayMs,
  isInputRequestOpen,
  type InputRequestKind,
  type InputRequestStatus,
  type InputRequestView,
} from "../../shared/inputRequests.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { InputRequest } from "../db/entities/InputRequest.js";
import { MemberBrowser } from "../db/entities/MemberBrowser.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Project } from "../db/entities/Project.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { Todo } from "../db/entities/Todo.js";
import { TodoPickup } from "../db/entities/TodoPickup.js";
import { User } from "../db/entities/User.js";
import { VaultItem } from "../db/entities/VaultItem.js";
import { decryptSecretWithStrongKeys, encryptSecret } from "../lib/secret.js";
import { redactApprovalSummary } from "./approvalRedaction.js";
import { recordAudit } from "./audit.js";
import { sendEmail } from "./email.js";
import { createNotifications, markEntityNotificationsRead } from "./notifications.js";
import { getPublicUrl } from "./publicUrl.js";
import { emitResourceChange } from "./resourceEvents.js";
import { pauseRunForPerson } from "./runPause.js";
import { workBlocked } from "./standdowns.js";

/**
 * Input requests: an AI Employee needs something only a person has, and the work
 * carries on when they come, however long that takes.
 *
 * Two things shape all of this. **People are not there when the work needs them**,
 * and **a one-time code dies within seconds**, along with the sign-in page that
 * asked for it. Asking for a code and holding it until the work comes back would
 * only ever deliver a dead code. So a request separates the person turning up from
 * the code they give:
 *
 *   1. A session reaches a page that wants a code and asks (`asking`). It holds the
 *      page open, for a few minutes, and whoever is around can type a code straight
 *      in. It goes into the page and is submitted, and the AI Model never sees it.
 *   2. Nobody came (`waiting`). The work stops, costing nothing: a Run pauses as
 *      itself, a Todo waits. Reminders back off from an hour to a day.
 *   3. Hours later a person presses **I'm ready** (`ready`). That is all they say,
 *      and it has no code in it. The same work starts again and signs in from the
 *      start, because the old page is long gone.
 *   4. It reaches the code prompt and asks again (`asking`), and only now does the
 *      person get a box, with a push to say so. A code given now can still work.
 *      Gone again? Back to 2, as many times as it takes, each one needing a person.
 *
 * A request ends when someone gives what it asked for, says they can't, or nobody
 * came within a week, and the work is told which and carries on. It also ends by
 * itself when the work ends without it.
 *
 * What this is not: a request grants nothing. The session that comes back has what
 * the last one had, under whichever Approvals and Grants apply then, because a
 * person pressing a button here is saying they are present, not widening anything.
 *
 * A code is never returned by any read, never stored in the clear, and never put in
 * a transcript, an audit row, a notification or a log. It waits encrypted on the row
 * only until the session holding the page takes it, usually for a second, and the
 * sweep clears it if the session never does.
 */

export class InputRequestError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "InputRequestError";
  }
}

const repo = () => AppDataSource.getRepository(InputRequest);

/** How often a session holding a page looks for an answer. A primary-key read. */
const ANSWER_POLL_MS = 1_000;
/** A window this far past its end means the session holding it has gone. */
const STALE_ASKING_GRACE_MS = 60_000;
/** An attempt this soon after the last code means that code was just refused. */
const REFUSED_RETRY_WINDOW_MS = 10 * 60_000;
/** Someone who gave a code this recently is looking at the page, so don't page them. */
const STILL_HERE_MS = 2 * 60_000;
/** A Run keeps this much of its limit for what comes after a person answers. */
const RUN_MARGIN_MS = 60_000;

export type InputRequestWork = {
  runId?: string | null;
  routineId?: string | null;
  todoId?: string | null;
  conversationId?: string | null;
  browserSessionId?: string | null;
};

/** The one key a piece of work asks under, so a session that comes back finds its request. */
export function inputRequestWorkKey(work: InputRequestWork): string {
  if (work.runId) return `run:${work.runId}`;
  if (work.todoId) return `todo:${work.todoId}`;
  if (work.conversationId) return `chat:${work.conversationId}`;
  if (work.browserSessionId) return `session:${work.browserSessionId}`;
  throw new InputRequestError("This work has nothing a person could come back to.", 400);
}

/**
 * Whether the work can stop and start again with nobody watching. A Run and a Pickup
 * can. A chat can't, and doesn't need to: the person is in the conversation, and
 * saying they're ready starts the next turn by itself.
 */
function resumable(row: Pick<InputRequest, "runId" | "todoId">): boolean {
  return Boolean(row.runId || row.todoId);
}

function clip(value: string, chars: number): string {
  return (redactApprovalSummary(value) ?? "").replace(/\s+\n/g, "\n").trim().slice(0, chars);
}

/** Only a Member can be asked, and a silently dropped name would look like it worked. */
async function memberNamed(companyId: string, named: string): Promise<string> {
  const needle = named.trim().toLowerCase().replace(/^@/, "");
  const memberships = await AppDataSource.getRepository(Membership).find({
    where: { companyId },
    select: { id: true, userId: true },
  });
  const users = memberships.length
    ? await AppDataSource.getRepository(User).find({
        where: { id: In(memberships.map((m) => m.userId)) },
        select: { id: true, handle: true, email: true },
      })
    : [];
  const match = users.find(
    (user) =>
      user.id === named ||
      (user.handle ?? "").toLowerCase() === needle ||
      user.email.toLowerCase() === needle,
  );
  if (!match) {
    throw new InputRequestError(
      `No Member matches "${named}". Leave the person out and Genosyn asks the company's owners and admins.`,
      404,
    );
  }
  return match.id;
}

async function isMember(companyId: string, userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  return AppDataSource.getRepository(Membership).existsBy({ companyId, userId });
}

/**
 * Who to ask, most specific first: whoever the employee named; the owner of the
 * browser, who is sitting at it; the Member this turn runs for; whoever saved the
 * login, who most likely holds the phone; whoever filed the Todo. With none of those
 * it goes to the owners and admins, the same as a Run's other alerts.
 */
async function chooseAssignee(args: {
  companyId: string;
  named?: string | null;
  requesterUserId?: string | null;
  vaultItemId?: string | null;
  memberBrowserId?: string | null;
  todoId?: string | null;
}): Promise<string | null> {
  if (args.named?.trim()) return memberNamed(args.companyId, args.named);
  if (args.memberBrowserId) {
    const browser = await AppDataSource.getRepository(MemberBrowser).findOne({
      where: { id: args.memberBrowserId, companyId: args.companyId },
      select: { id: true, ownerUserId: true },
    });
    if (await isMember(args.companyId, browser?.ownerUserId)) return browser!.ownerUserId;
  }
  if (await isMember(args.companyId, args.requesterUserId)) return args.requesterUserId!;
  if (args.vaultItemId) {
    const item = await AppDataSource.getRepository(VaultItem).findOne({
      where: { id: args.vaultItemId, companyId: args.companyId },
      select: { id: true, createdByUserId: true },
    });
    if (await isMember(args.companyId, item?.createdByUserId)) return item!.createdByUserId;
  }
  if (args.todoId) {
    const todo = await AppDataSource.getRepository(Todo).findOne({
      where: { id: args.todoId },
      select: { id: true, createdById: true },
    });
    if (await isMember(args.companyId, todo?.createdById)) return todo!.createdById;
  }
  return null;
}

async function assertRoomForAnother(companyId: string, employeeId: string): Promise<void> {
  const open = await repo().countBy({
    companyId,
    employeeId,
    status: In([...OPEN_INPUT_REQUEST_STATUSES]),
  });
  if (open >= MAX_OPEN_INPUT_REQUESTS_PER_EMPLOYEE) {
    throw new InputRequestError(
      `You already have ${open} requests waiting for people, and an AI Employee may hold ${MAX_OPEN_INPUT_REQUESTS_PER_EMPLOYEE} at once. Nobody was asked. Say what is blocked in your report instead.`,
      409,
    );
  }
}

function announce(row: Pick<InputRequest, "companyId">): void {
  // Open pages follow it. A person waiting for the code box is the whole point, and
  // it's no event a Routine could start on, so it stays out of the Trigger stream.
  emitResourceChange(row.companyId, "input_request", undefined, { trigger: false });
}

/** How much a person can give a session in a Run, given the time that Run has left. */
async function windowForWork(work: InputRequestWork, now: Date): Promise<number> {
  if (!work.runId) return INPUT_REQUEST_ANSWER_WINDOW_MS;
  const run = await AppDataSource.getRepository(Run).findOne({
    where: { id: work.runId },
    select: { id: true, continuationDeadlineAt: true },
  });
  const deadline = run?.continuationDeadlineAt?.getTime();
  if (!deadline) return INPUT_REQUEST_ANSWER_WINDOW_MS;
  return Math.min(INPUT_REQUEST_ANSWER_WINDOW_MS, deadline - now.getTime() - RUN_MARGIN_MS);
}

/**
 * A page is waiting for a person. Ask on the work's own request, if it has one, so
 * someone who said they're ready gets their box rather than a second card.
 */
export async function openPageInputRequest(args: {
  companyId: string;
  employeeId: string;
  kind: "code" | "action";
  title: string;
  body?: string;
  named?: string | null;
  requesterUserId?: string | null;
  work: InputRequestWork;
  vaultItemId?: string | null;
  memberBrowserId?: string | null;
  pageUrl: string;
  tainted?: boolean;
  /** Submitting needs an Approval on this browser, so answering takes an owner or admin. */
  adminOnly?: boolean;
  now?: Date;
}): Promise<InputRequest> {
  const now = args.now ?? new Date();
  const pageOrigin = inputRequestPageOrigin(args.pageUrl);
  if (!pageOrigin) {
    throw new InputRequestError("A person can only be asked about a page on an http(s) site.", 400);
  }
  const title = clip(args.title, INPUT_REQUEST_TITLE_CHARS);
  if (!title) throw new InputRequestError("Say in a few words what you need from them.", 400);
  const body = clip(args.body ?? "", INPUT_REQUEST_BODY_CHARS);
  const workKey = inputRequestWorkKey(args.work);
  const [latest] = await repo().find({
    where: {
      companyId: args.companyId,
      workKey,
      kind: In<InputRequestKind>(["code", "action"]),
      status: Not(In<InputRequestStatus>(["closed"])),
    },
    order: { createdAt: "DESC" },
    take: 1,
  });
  // A Run is one occurrence, told a person couldn't help. A Todo or a chat goes on
  // for days, and someone may well be able to help the next time it asks.
  if (args.work.runId && latest && ["declined", "expired"].includes(latest.status)) {
    throw new InputRequestError(
      latest.status === "declined"
        ? "A person already said they can't give you this. Do not ask again in this Run: do what you can without it, or report what is blocked with mark_run_failed."
        : "Nobody answered this in time. Do not ask again in this Run: do what you can without it, or report what is blocked with mark_run_failed.",
      409,
    );
  }
  // The same site asking again straight after a code means that code didn't work. A
  // different site is just the next sign-in in the same piece of work.
  const recentlyAnswered =
    latest?.status === "submitted" &&
    latest.pageOrigin === pageOrigin &&
    latest.answeredAt !== null &&
    now.getTime() - latest.answeredAt.getTime() < REFUSED_RETRY_WINDOW_MS;
  if (recentlyAnswered && latest.codesGiven >= MAX_CODES_PER_INPUT_REQUEST) {
    throw new InputRequestError(
      `${MAX_CODES_PER_INPUT_REQUEST} codes have gone in without the page accepting one, and wrong codes lock accounts. Do not ask again. Report what the page says.`,
      409,
    );
  }
  const reusable =
    latest && (isInputRequestOpen(latest.status) || latest.status === "submitted") ? latest : null;
  if (!reusable) await assertRoomForAnother(args.companyId, args.employeeId);

  const windowMs = await windowForWork(args.work, now);
  const canHold = windowMs >= INPUT_REQUEST_MIN_WINDOW_MS;
  const row =
    reusable ??
    repo().create({
      id: randomUUID(),
      companyId: args.companyId,
      employeeId: args.employeeId,
      workKey,
      createdAt: now,
    });
  const wasReady = reusable?.status === "ready";
  const assignee =
    (args.named?.trim() ? undefined : reusable?.assigneeUserId) ??
    (await chooseAssignee({
      companyId: args.companyId,
      named: args.named,
      requesterUserId: args.requesterUserId,
      vaultItemId: args.vaultItemId,
      memberBrowserId: args.memberBrowserId,
      todoId: args.work.todoId,
    }));
  Object.assign(row, {
    kind: args.kind,
    status: canHold ? "asking" : "waiting",
    title,
    body,
    assigneeUserId: assignee,
    runId: args.work.runId ?? null,
    routineId: args.work.routineId ?? null,
    todoId: args.work.todoId ?? null,
    conversationId: args.work.conversationId ?? null,
    browserSessionId: args.work.browserSessionId ?? null,
    vaultItemId: args.vaultItemId ?? null,
    pageOrigin,
    tainted: (reusable?.tainted ?? false) || args.tainted === true,
    adminOnly: args.adminOnly === true,
    askingUntil: canHold ? new Date(now.getTime() + windowMs) : null,
    attempts: (reusable?.attempts ?? 0) + 1,
    codesGiven: recentlyAnswered ? latest.codesGiven : 0,
    lastCodeRefused: recentlyAnswered,
    answerText: null,
    encryptedAnswer: null,
    nextReminderAt: canHold ? null : new Date(now.getTime() + inputRequestReminderDelayMs(0)),
    expiresAt:
      reusable && isInputRequestOpen(reusable.status)
        ? reusable.expiresAt
        : new Date(now.getTime() + INPUT_REQUEST_EXPIRY_MS),
    closedAt: null,
    closeReason: "",
  });
  await repo().save(row);
  await recordAudit({
    companyId: row.companyId,
    actorEmployeeId: row.employeeId,
    action: "input_request.ask",
    targetType: "input_request",
    targetId: row.id,
    targetLabel: row.title,
    runId: row.runId ?? undefined,
    metadata: { kind: row.kind, origin: row.pageOrigin, attempt: row.attempts },
  });
  // Whoever just gave a code is on the card and can see it asking again.
  if (!recentlyAnswered || now.getTime() - latest.answeredAt!.getTime() >= STILL_HERE_MS) {
    pingSoon(row, wasReady ? "asking_after_ready" : "asking");
  }
  announce(row);
  return row;
}

/**
 * Something the work needs in words. Nothing is holding a page, so there is nothing
 * to rush for: the work stops at once and the answer waits for it.
 */
export async function openAnswerInputRequest(args: {
  companyId: string;
  employeeId: string;
  title: string;
  body?: string;
  named?: string | null;
  requesterUserId?: string | null;
  work: InputRequestWork;
  tainted?: boolean;
  now?: Date;
}): Promise<{ request: InputRequest; alreadyWaiting: boolean }> {
  const now = args.now ?? new Date();
  if (!resumable({ runId: args.work.runId ?? null, todoId: args.work.todoId ?? null })) {
    throw new InputRequestError(
      "Only a Routine Run or a Todo can stop and wait for a person. In a chat, just ask them. Anywhere else, say what you need in your report.",
      400,
    );
  }
  const title = clip(args.title, INPUT_REQUEST_TITLE_CHARS);
  if (!title) throw new InputRequestError("Say in a few words what you need from them.", 400);
  const workKey = inputRequestWorkKey(args.work);
  const waiting = await repo().findOneBy({
    companyId: args.companyId,
    workKey,
    kind: "answer",
    status: "waiting",
  });
  if (waiting) return { request: waiting, alreadyWaiting: true };
  const settled = args.work.runId
    ? await repo().findOneBy({
        companyId: args.companyId,
        workKey,
        kind: "answer",
        status: In<InputRequestStatus>(["declined", "expired"]),
        title,
      })
    : null;
  if (settled) {
    throw new InputRequestError(
      "You already asked this in this Run and nobody could help. Do not ask again: do what you can without it, or report what is blocked with mark_run_failed.",
      409,
    );
  }
  await assertRoomForAnother(args.companyId, args.employeeId);
  const row = repo().create({
    id: randomUUID(),
    companyId: args.companyId,
    employeeId: args.employeeId,
    kind: "answer",
    status: "waiting",
    workKey,
    title,
    body: clip(args.body ?? "", INPUT_REQUEST_BODY_CHARS),
    assigneeUserId: await chooseAssignee({
      companyId: args.companyId,
      named: args.named,
      requesterUserId: args.requesterUserId,
      todoId: args.work.todoId,
    }),
    runId: args.work.runId ?? null,
    routineId: args.work.routineId ?? null,
    todoId: args.work.todoId ?? null,
    conversationId: args.work.conversationId ?? null,
    tainted: args.tainted === true,
    attempts: 1,
    nextReminderAt: new Date(now.getTime() + inputRequestReminderDelayMs(0)),
    expiresAt: new Date(now.getTime() + INPUT_REQUEST_EXPIRY_MS),
    createdAt: now,
  });
  await repo().save(row);
  await recordAudit({
    companyId: row.companyId,
    actorEmployeeId: row.employeeId,
    action: "input_request.ask",
    targetType: "input_request",
    targetId: row.id,
    targetLabel: row.title,
    runId: row.runId ?? undefined,
    metadata: { kind: row.kind },
  });
  if (row.todoId) await parkTodo(row);
  pingSoon(row, "asking");
  announce(row);
  return { request: row, alreadyWaiting: false };
}

// ───────────────────────────── a session holding a page

export type PageAnswer =
  /** A person gave a code. It is the only place the plaintext ever comes out. */
  | { outcome: "code"; code: string; request: InputRequest }
  /** A person did what the page needed. */
  | { outcome: "done"; request: InputRequest }
  | { outcome: "declined"; request: InputRequest }
  /** Nobody came within the window. */
  | { outcome: "lapsed"; request: InputRequest }
  /** The request ended some other way: the work is over, or it expired. */
  | { outcome: "ended"; request: InputRequest | null }
  /** The session holding the page went away first. */
  | { outcome: "aborted"; request: InputRequest | null };

function codeScope(row: Pick<InputRequest, "id" | "companyId">): string {
  return `company:${row.companyId}:input-request:${row.id}`;
}

/**
 * Hold the page until a person answers or the window ends. Whichever process holds
 * the browser reads the row, so it doesn't matter which one the person's answer
 * reached. A code is claimed by clearing it, so it comes out exactly once.
 */
export async function awaitPersonAtPage(args: {
  requestId: string;
  companyId: string;
  signal?: AbortSignal;
  pollMs?: number;
}): Promise<PageAnswer> {
  const pollMs = args.pollMs ?? ANSWER_POLL_MS;
  for (;;) {
    const row = await repo().findOneBy({ id: args.requestId, companyId: args.companyId });
    if (!row) return { outcome: "ended", request: null };
    if (row.status === "declined") return { outcome: "declined", request: row };
    if (row.status === "submitted") return { outcome: "done", request: row };
    // A Run with too little of its limit left to hold the page asks without holding it.
    if (row.status === "waiting") return { outcome: "lapsed", request: row };
    if (row.status !== "asking") return { outcome: "ended", request: row };
    if (row.encryptedAnswer) {
      const taken = await repo().update(
        { id: row.id, status: "asking", encryptedAnswer: row.encryptedAnswer },
        {
          status: "submitted",
          encryptedAnswer: null,
          askingUntil: null,
          nextReminderAt: null,
          codesGiven: row.codesGiven + 1,
        },
      );
      if (taken.affected === 1) {
        const code = decryptSecretWithStrongKeys(row.encryptedAnswer);
        announce(row);
        return {
          outcome: "code",
          code,
          request: { ...row, status: "submitted", encryptedAnswer: null } as InputRequest,
        };
      }
      continue;
    }
    if (args.signal?.aborted) {
      return { outcome: "aborted", request: await stopHoldingPage(row, false) };
    }
    if (!row.askingUntil || row.askingUntil.getTime() <= Date.now()) {
      const lapsed = await stopHoldingPage(row, true);
      if (lapsed) return { outcome: "lapsed", request: lapsed };
      continue;
    }
    try {
      await sleep(pollMs, undefined, args.signal ? { signal: args.signal } : undefined);
    } catch {
      // Aborted while asleep. The next pass settles it.
    }
  }
}

/**
 * The page stops waiting with nobody having answered. Work that can come back waits
 * for them. Work that can't is told so, and the request ends: a chat's next message
 * asks again by itself.
 */
async function stopHoldingPage(row: InputRequest, park: boolean): Promise<InputRequest | null> {
  const now = new Date();
  const comesBack = resumable(row);
  // A person who came and went starts the reminders again from the beginning.
  const reminders = row.readyAt ? 0 : row.reminders;
  const moved = await repo().update(
    { id: row.id, status: "asking", encryptedAnswer: IsNull() },
    comesBack
      ? {
          status: "waiting",
          askingUntil: null,
          reminders,
          nextReminderAt: new Date(now.getTime() + inputRequestReminderDelayMs(reminders)),
        }
      : {
          status: "closed",
          askingUntil: null,
          closedAt: now,
          closeReason: "Nobody answered while the page was waiting.",
        },
  );
  if (moved.affected !== 1) return null;
  const current = await repo().findOneBy({ id: row.id });
  if (!current) return null;
  if (!comesBack) {
    await clearBells(current);
  } else if (park) {
    if (current.todoId) await parkTodo(current);
    pingSoon(current, "lapsed");
  }
  announce(current);
  return current;
}

/**
 * Stop this Run's turn, once the session holding the page has been answered: the
 * runner puts it back in the queue as itself, held for this request. Called after
 * the reply goes out, because finishing a Run's browser waits for its requests.
 */
export function parkRunForRequest(request: Pick<InputRequest, "id" | "runId">): boolean {
  return request.runId ? pauseRunForPerson(request.runId, request.id) : false;
}

async function parkTodo(row: InputRequest): Promise<void> {
  try {
    const { waitTodoOnInputRequest } = await import("./todoWaits.js");
    await waitTodoOnInputRequest(row);
  } catch (error) {
    // The sweep still reminds people, and a Pickup that ends without a wait comes back.
    // eslint-disable-next-line no-console
    console.error(`[input-requests] could not mark the Todo waiting on ${row.id}:`, error);
  }
}

/** The session filled and submitted the code, or couldn't. Either is for the audit log. */
export async function recordCodeUse(args: {
  request: InputRequest;
  filled: boolean;
  actorEmployeeId: string;
}): Promise<void> {
  await recordAudit({
    companyId: args.request.companyId,
    actorEmployeeId: args.actorEmployeeId,
    action: args.filled ? "input_request.fill" : "input_request.fill_failed",
    targetType: "input_request",
    targetId: args.request.id,
    targetLabel: args.request.title,
    runId: args.request.runId ?? undefined,
    metadata: { origin: args.request.pageOrigin },
  });
}

// ───────────────────────────── what a person does

export type InputRequestActor = { userId: string; role: Role };

function administers(actor: InputRequestActor): boolean {
  return actor.role === "owner" || actor.role === "admin";
}

export function canAnswerInputRequest(
  row: Pick<InputRequest, "adminOnly" | "assigneeUserId">,
  actor: InputRequestActor,
): boolean {
  if (administers(actor)) return true;
  if (row.adminOnly) return false;
  return row.assigneeUserId === actor.userId;
}

async function loadForActor(
  companyId: string,
  id: string,
  actor: InputRequestActor,
): Promise<InputRequest> {
  const row = await repo().findOneBy({ id, companyId });
  // Somebody else's request reads the same as none: its title can name a site they
  // have no business knowing the company signs in to.
  if (!row || !canAnswerInputRequest(row, actor)) {
    throw new InputRequestError("Input request not found.", 404);
  }
  return row;
}

/**
 * "I'm ready." It carries no code on purpose: whatever code they have now would be
 * dead by the time the work has signed in again, so this only says they're here.
 */
export async function readyInputRequest(args: {
  companyId: string;
  id: string;
  actor: InputRequestActor;
  now?: Date;
}): Promise<InputRequest> {
  const now = args.now ?? new Date();
  const row = await loadForActor(args.companyId, args.id, args.actor);
  if (row.kind === "answer") {
    throw new InputRequestError(
      "This one needs an answer, so there's nothing to get ready for.",
      400,
    );
  }
  if (row.status === "asking" || row.status === "ready") return row;
  if (row.status !== "waiting") throw new InputRequestError(settledMessage(row), 409);
  if (!resumable(row)) {
    throw new InputRequestError("This work has ended. Ask in its chat to start it again.", 409);
  }
  const moved = await repo().update(
    { id: row.id, status: "waiting" },
    { status: "ready", readyAt: now, readyByUserId: args.actor.userId, nextReminderAt: null },
  );
  if (moved.affected !== 1) {
    return (await repo().findOneBy({ id: row.id })) ?? row;
  }
  const current = (await repo().findOneByOrFail({ id: row.id })) as InputRequest;
  await recordAudit({
    companyId: row.companyId,
    actorUserId: args.actor.userId,
    action: "input_request.ready",
    targetType: "input_request",
    targetId: row.id,
    targetLabel: row.title,
  });
  await bringWorkBack(current);
  announce(current);
  return current;
}

function settledMessage(row: Pick<InputRequest, "status">): string {
  switch (row.status) {
    case "submitted":
      return "A code has already gone in for this.";
    case "answered":
      return "Someone has already answered this.";
    case "declined":
      return "Someone has already said they can't help with this.";
    case "expired":
      return "This waited as long as it could and has given up.";
    default:
      return "This work no longer needs it.";
  }
}

/**
 * A person gives what was asked for. A code is taken only while a page is really
 * waiting: at any other time it would be a dead code, and pretending otherwise is the
 * failure this whole design exists to prevent.
 */
export async function answerInputRequest(args: {
  companyId: string;
  id: string;
  actor: InputRequestActor;
  value?: string;
  now?: Date;
}): Promise<InputRequest> {
  const now = args.now ?? new Date();
  const row = await loadForActor(args.companyId, args.id, args.actor);
  if (!isInputRequestOpen(row.status)) throw new InputRequestError(settledMessage(row), 409);

  if (row.kind === "answer") {
    const answer = (args.value ?? "").trim();
    if (!answer) throw new InputRequestError("Write an answer first.", 400);
    if (answer.length > INPUT_REQUEST_ANSWER_CHARS) {
      throw new InputRequestError("That answer is too long.", 400);
    }
    return settle(row, args.actor, now, {
      status: "answered",
      answerText: answer,
      answeredAt: now,
      answeredByUserId: args.actor.userId,
      closeReason: "Answered.",
    });
  }

  const waiting = row.status === "asking" && (row.askingUntil?.getTime() ?? 0) > now.getTime();
  if (!waiting) {
    throw new InputRequestError(
      "The page isn't waiting right now, so anything you give it wouldn't work. Press I'm ready first.",
      409,
    );
  }

  if (row.kind === "action") {
    const moved = await repo().update(
      { id: row.id, status: "asking" },
      {
        status: "submitted",
        askingUntil: null,
        answeredAt: now,
        answeredByUserId: args.actor.userId,
      },
    );
    if (moved.affected !== 1) throw new InputRequestError(settledMessage(row), 409);
  } else {
    const code = (args.value ?? "").trim();
    if (!code) throw new InputRequestError("Type the code first.", 400);
    if (code.length > INPUT_REQUEST_CODE_CHARS || /[\r\n]/.test(code)) {
      throw new InputRequestError("That doesn't look like a one-time code.", 400);
    }
    const moved = await repo().update(
      { id: row.id, status: "asking", encryptedAnswer: IsNull() },
      {
        encryptedAnswer: encryptSecret(code, codeScope(row)),
        answeredAt: now,
        answeredByUserId: args.actor.userId,
      },
    );
    if (moved.affected !== 1) {
      throw new InputRequestError("A code is already on its way to the page.", 409);
    }
  }
  await recordAudit({
    companyId: row.companyId,
    actorUserId: args.actor.userId,
    action: "input_request.answer",
    targetType: "input_request",
    targetId: row.id,
    targetLabel: row.title,
    // Never the value. Its kind says everything anyone reading this needs.
    metadata: { kind: row.kind, origin: row.pageOrigin },
  });
  await clearBells(row);
  announce(row);
  return (await repo().findOneBy({ id: row.id })) ?? row;
}

/** "I can't." The work is told, and goes on without it. */
export async function declineInputRequest(args: {
  companyId: string;
  id: string;
  actor: InputRequestActor;
  note?: string;
  now?: Date;
}): Promise<InputRequest> {
  const now = args.now ?? new Date();
  const row = await loadForActor(args.companyId, args.id, args.actor);
  if (!isInputRequestOpen(row.status)) throw new InputRequestError(settledMessage(row), 409);
  const note = (args.note ?? "").trim().slice(0, INPUT_REQUEST_ANSWER_CHARS);
  return settle(row, args.actor, now, {
    status: "declined",
    answerText: note || null,
    answeredAt: now,
    answeredByUserId: args.actor.userId,
    closeReason: "A person said they can't help with this.",
  });
}

/** End an open request with a person's answer, and bring the work back to it. */
async function settle(
  row: InputRequest,
  actor: InputRequestActor,
  now: Date,
  values: Partial<InputRequest> & { status: InputRequestStatus },
): Promise<InputRequest> {
  const moved = await repo().update({ id: row.id, status: row.status }, {
    ...values,
    encryptedAnswer: null,
    askingUntil: null,
    nextReminderAt: null,
    closedAt: now,
  } as Parameters<ReturnType<typeof repo>["update"]>[1]);
  if (moved.affected !== 1) throw new InputRequestError(settledMessage(row), 409);
  const current = await repo().findOneByOrFail({ id: row.id });
  await recordAudit({
    companyId: row.companyId,
    actorUserId: actor.userId,
    action: values.status === "declined" ? "input_request.decline" : "input_request.answer",
    targetType: "input_request",
    targetId: row.id,
    targetLabel: row.title,
    metadata: { kind: row.kind },
  });
  await clearBells(current);
  // A session holding the page sees this itself on its next look.
  if (row.status !== "asking") await bringWorkBack(current);
  announce(current);
  return current;
}

async function clearBells(row: Pick<InputRequest, "id" | "companyId">): Promise<void> {
  await markEntityNotificationsRead({
    companyId: row.companyId,
    entityKind: "input_request",
    entityId: row.id,
  }).catch(() => undefined);
}

// ───────────────────────────── bringing the work back

async function firstNameOf(userId: string | null): Promise<string> {
  if (!userId) return "A person";
  const user = await AppDataSource.getRepository(User).findOne({
    where: { id: userId },
    select: { id: true, name: true, email: true },
  });
  return user?.name?.trim() || user?.email || "A person";
}

/**
 * What a session that comes back is told. A Member's own words are theirs to give,
 * and what the employee wrote itself earlier comes back as data, in JSON, since it
 * may have been written with outside words in front of it.
 */
export async function inputRequestResumeNote(row: InputRequest): Promise<string> {
  const asked = JSON.stringify(row.title);
  const person = await firstNameOf(row.answeredByUserId ?? row.readyByUserId ?? row.assigneeUserId);
  switch (row.status) {
    case "ready": {
      const site = row.pageOrigin || "the site";
      const login = row.vaultItemId
        ? `Use the Vault login ${row.vaultItemId} to sign in.`
        : "Sign in the way you did before.";
      return [
        `You asked for ${row.kind === "code" ? "a one-time code" : "a person's help at a page"} (your words: ${asked}) and nobody could answer in time.`,
        `${person} has just said they're ready, and they are waiting for you now.`,
        "Any sign-in page from before has almost certainly timed out, and a code for it would be dead, which is why they have given you nothing yet. Do this first, and nothing else before it:",
        `1. Open ${site} and sign in again from the start. ${login}`,
        "2. As soon as the page asks for what you need, call browser_ask_person on that prompt. They get a box for it the moment you do.",
        "If you get in without needing them after all, just carry on.",
      ].join("\n");
    }
    case "answered":
      return [
        `You asked (your words): ${asked}`,
        `${person} answered: ${JSON.stringify(row.answerText ?? "")}`,
        "Carry on with the work it unblocks. If it changed what you should do, do the changed thing. Don't ask again what has just been answered.",
      ].join("\n");
    case "declined":
      return [
        `You asked (your words): ${asked}`,
        `${person} said they can't help with this.${row.answerText ? ` Their note: ${JSON.stringify(row.answerText)}` : ""}`,
        "Don't ask again. Do what you can without it, and say plainly what stayed undone.",
      ].join("\n");
    case "expired":
      return [
        `You asked (your words): ${asked}`,
        "Nobody answered, after a week of reminders. Don't ask again. Do what you can without it, and say plainly what stayed undone.",
      ].join("\n");
    default:
      return "";
  }
}

/** The note for a Run that paused for a person, when it resumes. */
export async function inputRequestBriefForRun(runId: string): Promise<string> {
  const [row] = await repo().find({
    where: { workKey: `run:${runId}` },
    order: { createdAt: "DESC" },
    take: 1,
  });
  return row ? inputRequestResumeNote(row) : "";
}

/**
 * Let the work go. A Run leaves the hold and the queue starts it first, as any paused
 * Run. A Todo stops waiting and its next session starts. Neither is a new grant: each
 * runs under what it had.
 */
async function bringWorkBack(row: InputRequest): Promise<void> {
  if (row.runId) {
    const released = await AppDataSource.getRepository(Run).update(
      { id: row.runId, status: "queued", waitingOnInputRequestId: row.id },
      { routineId: row.routineId ?? undefined, waitingOnInputRequestId: null },
    );
    if (released.affected === 1) {
      const { dispatchQueuedRoutineRuns } = await import("./routineQueue.js");
      void dispatchQueuedRoutineRuns().catch(() => undefined);
    }
    return;
  }
  if (row.todoId) {
    const note = await inputRequestResumeNote(row);
    const { wakeTodoForInputRequest } = await import("./todoWaits.js");
    await wakeTodoForInputRequest(row, note).catch((error) => {
      // eslint-disable-next-line no-console
      console.error(`[input-requests] could not wake the Todo for ${row.id}:`, error);
    });
  }
}

/**
 * The request this Run's turn just left a person holding, if one is. A turn that ends
 * with this set never reaches its verdict: the work isn't finished, it's waiting.
 */
export async function openInputRequestHoldingRun(runId: string): Promise<string | null> {
  const row = await repo().findOne({
    where: { workKey: `run:${runId}`, status: "waiting" },
    select: { id: true },
    order: { createdAt: "DESC" },
  });
  return row?.id ?? null;
}

/**
 * A Run landed its pause after a person already answered. Without this it would wait
 * for someone who has already come. Called by the runner, right after the pause.
 */
export async function releaseRunIfAlreadyAnswered(runId: string, requestId: string): Promise<void> {
  const row = await repo().findOneBy({ id: requestId });
  if (!row || row.status === "waiting") return;
  await bringWorkBack(row);
}

// ───────────────────────────── pinging people

const pingsInFlight = new Set<Promise<void>>();

/** Never in the way of the work: a slow mail server shouldn't hold up a person's box. */
function pingSoon(row: InputRequest, phase: PingPhase, widen = false): void {
  const ping = pingPeople(row, phase, widen).finally(() => pingsInFlight.delete(ping));
  pingsInFlight.add(ping);
}

/** Test seam: wait for the pings already on their way. */
export async function settleInputRequestPingsForTests(): Promise<void> {
  await Promise.all([...pingsInFlight]);
}

type PingPhase = "asking" | "asking_after_ready" | "lapsed" | "reminder" | "expired";

async function ownersAndAdmins(companyId: string): Promise<string[]> {
  const rows = await AppDataSource.getRepository(Membership).find({
    where: { companyId, role: In(["owner", "admin"]) },
    select: { id: true, userId: true },
  });
  return rows.map((row) => row.userId);
}

/** Who can actually answer it right now, read from live memberships. */
async function recipientsFor(
  row: Pick<InputRequest, "companyId" | "assigneeUserId" | "adminOnly">,
  widen: boolean,
): Promise<string[]> {
  const admins = await ownersAndAdmins(row.companyId);
  const named =
    row.assigneeUserId && !row.adminOnly && (await isMember(row.companyId, row.assigneeUserId))
      ? row.assigneeUserId
      : row.assigneeUserId && admins.includes(row.assigneeUserId)
        ? row.assigneeUserId
        : null;
  if (!named) return admins;
  return widen ? [...new Set([named, ...admins])] : [named];
}

function needsWord(kind: InputRequestKind): string {
  if (kind === "code") return "a code";
  if (kind === "action") return "your help";
  return "an answer";
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function inputRequestLink(slug: string, id: string): string {
  return `/c/${slug}/decisions#input-${id}`;
}

function pingCopy(
  row: InputRequest,
  phase: PingPhase,
  employeeName: string,
): { title: string; body: string } {
  const site = row.pageOrigin ? hostOf(row.pageOrigin) : "";
  const about = site ? `${row.title} (${site})` : row.title;
  switch (phase) {
    case "asking":
      return { title: `${employeeName} needs ${needsWord(row.kind)} from you`, body: about };
    case "asking_after_ready":
      return {
        title: `${site || employeeName} is asking now`,
        body:
          row.kind === "code"
            ? `Enter the code for ${row.title} while the page is waiting.`
            : `${row.title}. The page is waiting for you.`,
      };
    case "lapsed":
      return {
        title: `${employeeName} is waiting for you`,
        body: `${about}. Press I'm ready when you have a moment.`,
      };
    case "reminder":
      return {
        title: `${employeeName} is still waiting for you`,
        body: row.kind === "answer" ? about : `${about}. Press I'm ready when you have a moment.`,
      };
    case "expired":
      return {
        title: `${employeeName} stopped waiting`,
        body: `Nobody answered in time: ${row.title}`,
      };
  }
}

/** Email is for when someone isn't looking. It never carries a way to answer. */
function emailText(row: InputRequest, phase: PingPhase, employeeName: string, url: string): string {
  const lines = [`${employeeName} is waiting for you at your company on Genosyn.`, "", row.title];
  if (row.body) lines.push("", row.body);
  if (row.pageOrigin) lines.push("", `Site: ${row.pageOrigin}`);
  if (phase === "expired") {
    lines.push("", "Nobody answered in time, so it has carried on without this.", "", url);
  } else if (row.kind === "answer") {
    lines.push("", "Answer it here, and the work carries on by itself:", url);
  } else {
    lines.push(
      "",
      "When you have what it needs to hand, open this page and press I'm ready. It will sign in again and ask you then, so nothing you have right now will go stale.",
      url,
    );
  }
  lines.push("", "Genosyn never asks for a code by email. Don't reply to this message with one.");
  return lines.join("\n");
}

/**
 * A bell and a push, and an email unless the page is waiting right now, when a
 * person would never get to it in time. One failing never stops the others, and
 * neither ever stops the work.
 */
async function pingPeople(row: InputRequest, phase: PingPhase, widen = false): Promise<void> {
  try {
    const [company, employee] = await Promise.all([
      AppDataSource.getRepository(Company).findOne({
        where: { id: row.companyId },
        select: { id: true, slug: true },
      }),
      AppDataSource.getRepository(AIEmployee).findOne({
        where: { id: row.employeeId },
        select: { id: true, name: true },
      }),
    ]);
    if (!company || !employee) return;
    const userIds = await recipientsFor(row, widen);
    if (userIds.length === 0) return;
    const copy = pingCopy(row, phase, employee.name);
    const link = inputRequestLink(company.slug, row.id);
    await createNotifications(
      userIds.map((userId) => ({
        companyId: row.companyId,
        userId,
        kind: "input_request" as const,
        title: copy.title.slice(0, 240),
        body: copy.body.slice(0, 300),
        link,
        actorKind: "ai" as const,
        actorId: employee.id,
        entityKind: "input_request" as const,
        entityId: row.id,
      })),
    );
    if (phase === "asking" && row.kind !== "answer") return;
    if (phase === "asking_after_ready") return;
    const users = await AppDataSource.getRepository(User).find({
      where: { id: In(userIds) },
      select: { id: true, email: true },
    });
    const url = `${getPublicUrl()}${link}`;
    await Promise.all(
      users.map((user) =>
        sendEmail({
          to: user.email,
          subject: copy.title.slice(0, 200),
          text: emailText(row, phase, employee.name, url),
          companyId: row.companyId,
          purpose: "other",
        }).catch((error: unknown) => {
          // eslint-disable-next-line no-console
          console.error(`[input-requests] could not email about ${row.id}:`, error);
        }),
      ),
    );
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[input-requests] could not ping anyone about ${row.id}:`, error);
  }
}

// ───────────────────────────── the sweep

/** Whether the work this request belongs to has ended without it. */
async function workHasEnded(row: InputRequest): Promise<string | null> {
  const employee = await AppDataSource.getRepository(AIEmployee).existsBy({
    id: row.employeeId,
    companyId: row.companyId,
  });
  if (!employee) return "The AI Employee that asked was removed.";
  if (row.runId) {
    const run = await AppDataSource.getRepository(Run).findOne({
      where: { id: row.runId },
      select: { id: true, status: true, routineId: true, employeeId: true },
    });
    if (!run) return "The Run that asked is gone.";
    if (run.status !== "queued" && run.status !== "running") {
      return "The Run finished without it.";
    }
    return null;
  }
  if (row.todoId) {
    const todo = await AppDataSource.getRepository(Todo).findOne({
      where: { id: row.todoId },
      select: {
        id: true,
        status: true,
        assigneeEmployeeId: true,
        waitingOn: true,
        waitingRefId: true,
      },
    });
    if (!todo) return "The Todo that asked is gone.";
    if (todo.assigneeEmployeeId !== row.employeeId) return "The Todo was given to someone else.";
    if (!["backlog", "todo", "in_progress", "in_review"].includes(todo.status)) {
      return "The Todo was closed.";
    }
    if (todo.waitingOn === "input_request" && todo.waitingRefId === row.id) return null;
    const active = await AppDataSource.getRepository(TodoPickup).existsBy({
      todoId: todo.id,
      status: In(["queued", "running"]),
    });
    return active ? null : "The Todo stopped waiting for it.";
  }
  // Nothing can come back to the others once their page has stopped waiting.
  return row.status === "asking" ? null : "The work ended without it.";
}

/** A Routine turned off or handed on while its Run waited: the queue ends the Run. */
async function releaseRunOfDisabledRoutine(row: InputRequest): Promise<boolean> {
  if (!row.runId || !row.routineId || row.status !== "waiting") return false;
  const routine = await AppDataSource.getRepository(Routine).findOne({
    where: { id: row.routineId },
    select: { id: true, enabled: true, employeeId: true },
  });
  if (routine && routine.enabled && routine.employeeId === row.employeeId) return false;
  await closeRequest(row, "The Routine was turned off while this waited.");
  await bringWorkBack(row);
  return true;
}

async function closeRequest(row: InputRequest, reason: string): Promise<void> {
  const moved = await repo().update(
    { id: row.id, status: row.status },
    {
      status: "closed",
      encryptedAnswer: null,
      askingUntil: null,
      nextReminderAt: null,
      closedAt: new Date(),
      closeReason: reason,
    },
  );
  if (moved.affected !== 1) return;
  await clearBells(row);
  announce(row);
}

async function expireRequest(row: InputRequest, now: Date): Promise<void> {
  const moved = await repo().update(
    { id: row.id, status: row.status },
    {
      status: "expired",
      encryptedAnswer: null,
      askingUntil: null,
      nextReminderAt: null,
      closedAt: now,
      closeReason: "Nobody answered in time.",
    },
  );
  if (moved.affected !== 1) return;
  const current = await repo().findOneByOrFail({ id: row.id });
  await recordAudit({
    companyId: row.companyId,
    actorKind: "system",
    action: "input_request.expire",
    targetType: "input_request",
    targetId: row.id,
    targetLabel: row.title,
  });
  await clearBells(current);
  pingSoon(current, "expired");
  await bringWorkBack(current);
  announce(current);
}

/**
 * Keep every open request honest, on the scheduler heartbeat. Each step is a
 * conditional claim on the row, so two schedulers or a retried pass can't double up,
 * and each row is on its own, so one broken row can't silence the rest.
 *
 *  - A session that died holding a page leaves it `asking`: put it back to waiting,
 *    and clear any code it never took.
 *  - Work that ended without it closes the request.
 *  - Someone said they were ready and nothing came of it: wait for them again.
 *  - Past its week, it gives up, and the work is told.
 *  - Due a reminder: remind them, backing off, and bring in the owners and admins
 *    once the named person has had a day.
 *
 * A Standdown holds all of this but the first two: nobody should be asked to hurry
 * for work that can't start, and the week doesn't run out while it can't.
 */
export async function sweepInputRequests(
  now: Date = new Date(),
  assertLeaseHeld: () => void = () => undefined,
): Promise<void> {
  const open = await repo().find({
    where: { status: In([...OPEN_INPUT_REQUEST_STATUSES]) },
    order: { createdAt: "ASC" },
  });
  for (const row of open) {
    assertLeaseHeld();
    try {
      await sweepOne(row, now);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`[input-requests] sweep failed for ${row.id}:`, error);
    }
  }
  assertLeaseHeld();
  await freeStrandedWork();
}

/**
 * Work held for a request nobody is coming to any more. A person's answer and the work
 * being let go are two writes, and a process can die between them. Without this, that
 * Run waits forever for someone who has already been and gone. So each pass looks from
 * the other side: everything held, and whether what it's held for still is waiting.
 */
async function freeStrandedWork(): Promise<void> {
  const runs = await AppDataSource.getRepository(Run).find({
    // Through `status`: what's queued is few, however long the history.
    where: { status: "queued", waitingOnInputRequestId: Not(IsNull()) },
    select: { id: true, routineId: true, waitingOnInputRequestId: true },
  });
  for (const run of runs) {
    const row = await repo().findOneBy({ id: run.waitingOnInputRequestId! });
    if (row?.status === "waiting") continue;
    await AppDataSource.getRepository(Run).update(
      { id: run.id, status: "queued", waitingOnInputRequestId: run.waitingOnInputRequestId! },
      { routineId: run.routineId, waitingOnInputRequestId: null },
    );
    const { dispatchQueuedRoutineRuns } = await import("./routineQueue.js");
    void dispatchQueuedRoutineRuns().catch(() => undefined);
  }
  const todos = await AppDataSource.getRepository(Todo).find({
    where: { waitingOn: "input_request" },
    select: { id: true, waitingRefId: true },
  });
  for (const todo of todos) {
    const row = todo.waitingRefId ? await repo().findOneBy({ id: todo.waitingRefId }) : null;
    if (row?.status === "waiting") continue;
    if (row) {
      await bringWorkBack(row);
    } else {
      const { endTodoWait } = await import("./todoWaits.js");
      await endTodoWait(todo.id);
    }
  }
}

async function sweepOne(row: InputRequest, now: Date): Promise<void> {
  if (
    row.status === "asking" &&
    (!row.askingUntil || row.askingUntil.getTime() + STALE_ASKING_GRACE_MS < now.getTime())
  ) {
    await repo().update({ id: row.id, status: "asking" }, { encryptedAnswer: null });
    const moved = await stopHoldingPage({ ...row, encryptedAnswer: null } as InputRequest, true);
    if (!moved) return;
    row = moved;
  }
  if (!isInputRequestOpen(row.status)) return;

  const ended = await workHasEnded(row);
  if (ended) {
    await closeRequest(row, ended);
    return;
  }
  if (await releaseRunOfDisabledRoutine(row)) return;
  if (
    workBlocked(row.companyId, {
      employeeId: row.employeeId,
      routineId: row.routineId ?? undefined,
    }).blocked
  ) {
    return;
  }
  if (row.status === "ready") {
    if ((row.readyAt?.getTime() ?? 0) + INPUT_REQUEST_READY_WAIT_MS > now.getTime()) return;
    await repo().update(
      { id: row.id, status: "ready" },
      {
        status: "waiting",
        reminders: 0,
        nextReminderAt: new Date(now.getTime() + inputRequestReminderDelayMs(0)),
      },
    );
    announce(row);
    return;
  }
  if (row.status !== "waiting") return;
  if (row.expiresAt.getTime() <= now.getTime()) {
    await expireRequest(row, now);
    return;
  }
  if (!row.nextReminderAt || row.nextReminderAt.getTime() > now.getTime()) return;
  const sent = row.reminders + 1;
  const widen = sent > INPUT_REQUEST_ESCALATE_AT_REMINDER && row.assigneeUserId !== null;
  const claimed = await repo().update(
    { id: row.id, status: "waiting", reminders: row.reminders },
    {
      reminders: sent,
      nextReminderAt: new Date(now.getTime() + inputRequestReminderDelayMs(sent)),
    },
  );
  if (claimed.affected !== 1) return;
  pingSoon(row, "reminder", widen);
}

// ───────────────────────────── reading

type ViewContext = {
  employees: Map<string, Pick<AIEmployee, "id" | "name" | "slug" | "avatarKey">>;
  users: Map<string, Pick<User, "id" | "name" | "email">>;
  routines: Map<string, Pick<Routine, "id" | "name" | "slug">>;
  todos: Map<string, Pick<Todo, "id" | "title" | "projectId">>;
  projects: Map<string, Pick<Project, "id" | "slug">>;
};

async function viewContext(rows: InputRequest[]): Promise<ViewContext> {
  const ids = <K extends keyof InputRequest>(key: K): string[] => [
    ...new Set(rows.flatMap((row) => (row[key] ? [row[key] as string] : []))),
  ];
  const [employees, users, routines, todos] = await Promise.all([
    ids("employeeId").length
      ? AppDataSource.getRepository(AIEmployee).find({
          where: { id: In(ids("employeeId")) },
          select: { id: true, name: true, slug: true, avatarKey: true },
        })
      : [],
    ids("assigneeUserId").length
      ? AppDataSource.getRepository(User).find({
          where: { id: In(ids("assigneeUserId")) },
          select: { id: true, name: true, email: true },
        })
      : [],
    ids("routineId").length
      ? AppDataSource.getRepository(Routine).find({
          where: { id: In(ids("routineId")) },
          select: { id: true, name: true, slug: true },
        })
      : [],
    ids("todoId").length
      ? AppDataSource.getRepository(Todo).find({
          where: { id: In(ids("todoId")) },
          select: { id: true, title: true, projectId: true },
        })
      : [],
  ]);
  const projectIds = [...new Set(todos.map((todo) => todo.projectId))];
  const projects = projectIds.length
    ? await AppDataSource.getRepository(Project).find({
        where: { id: In(projectIds) },
        select: { id: true, slug: true },
      })
    : [];
  return {
    employees: new Map(employees.map((row) => [row.id, row])),
    users: new Map(users.map((row) => [row.id, row])),
    routines: new Map(routines.map((row) => [row.id, row])),
    todos: new Map(todos.map((row) => [row.id, row])),
    projects: new Map(projects.map((row) => [row.id, row])),
  };
}

function viewOf(
  row: InputRequest,
  slug: string,
  context: ViewContext,
  actor: InputRequestActor,
): InputRequestView {
  const employee = context.employees.get(row.employeeId);
  const assignee = row.assigneeUserId ? context.users.get(row.assigneeUserId) : null;
  const routine = row.routineId ? context.routines.get(row.routineId) : null;
  const todo = row.todoId ? context.todos.get(row.todoId) : null;
  const project = todo ? context.projects.get(todo.projectId) : null;
  const work: InputRequestView["work"] =
    row.runId && routine && employee
      ? {
          kind: "run",
          id: row.runId,
          label: routine.name,
          link: `/c/${slug}/routines/${employee.slug}/${routine.slug}?run=${row.runId}`,
        }
      : row.todoId && todo && project
        ? {
            kind: "todo",
            id: row.todoId,
            label: todo.title,
            link: `/c/${slug}/tasks/p/${project.slug}?todo=${encodeURIComponent(row.todoId)}`,
          }
        : row.conversationId && employee
          ? {
              kind: "chat",
              id: row.conversationId,
              label: `Chat with ${employee.name}`,
              link: `/c/${slug}/employees/${employee.slug}/chat?conversation=${encodeURIComponent(row.conversationId)}`,
            }
          : { kind: "other", id: null, label: "", link: null };
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    title: row.title,
    body: row.body,
    employee: {
      id: row.employeeId,
      name: employee?.name ?? "An AI Employee",
      slug: employee?.slug ?? "",
      avatarKey: employee?.avatarKey ?? null,
    },
    assignee: assignee ? { id: assignee.id, name: assignee.name || assignee.email } : null,
    pageOrigin: row.pageOrigin,
    browserSessionId: administers(actor) ? row.browserSessionId : null,
    vaultItemId: row.vaultItemId,
    askingUntil: row.askingUntil?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    answerPending: row.encryptedAnswer !== null,
    lastCodeRefused: row.lastCodeRefused,
    tainted: row.tainted,
    adminOnly: row.adminOnly,
    work,
    vaultLink: `/c/${slug}/vault${row.vaultItemId ? `?item=${encodeURIComponent(row.vaultItemId)}` : ""}`,
    canAnswer: canAnswerInputRequest(row, actor),
    heldByStanddown: workBlocked(row.companyId, {
      employeeId: row.employeeId,
      routineId: row.routineId ?? undefined,
    }).blocked,
    closeReason: row.closeReason,
  };
}

/**
 * The open requests this reader may answer. Everything else reads as if it weren't
 * there. Open requests are few by construction, three to an AI Employee, so this has
 * no page to cut: it is always all of them, and it's filtered inside the query.
 */
export async function listOpenInputRequests(args: {
  companyId: string;
  actor: InputRequestActor;
  work?: { runId?: string; todoId?: string; conversationId?: string };
}): Promise<InputRequestView[]> {
  const where = {
    companyId: args.companyId,
    status: In([...OPEN_INPUT_REQUEST_STATUSES]),
    ...(args.work?.runId ? { runId: args.work.runId } : {}),
    ...(args.work?.todoId ? { todoId: args.work.todoId } : {}),
    ...(args.work?.conversationId ? { conversationId: args.work.conversationId } : {}),
  };
  const rows = await repo().find({
    where: administers(args.actor)
      ? where
      : { ...where, assigneeUserId: args.actor.userId, adminOnly: false },
    order: { createdAt: "ASC" },
  });
  return viewsOf(rows, args.companyId, args.actor);
}

export async function getInputRequest(args: {
  companyId: string;
  id: string;
  actor: InputRequestActor;
}): Promise<InputRequestView> {
  const row = await loadForActor(args.companyId, args.id, args.actor);
  const [view] = await viewsOf([row], args.companyId, args.actor);
  return view;
}

export async function viewsOf(
  rows: InputRequest[],
  companyId: string,
  actor: InputRequestActor,
): Promise<InputRequestView[]> {
  if (rows.length === 0) return [];
  const [company, context] = await Promise.all([
    AppDataSource.getRepository(Company).findOne({
      where: { id: companyId },
      select: { id: true, slug: true },
    }),
    viewContext(rows),
  ]);
  return rows.map((row) => viewOf(row, company?.slug ?? "", context, actor));
}

/** How many requests wait on this reader, for the count beside the stack. */
export async function countOpenInputRequests(
  companyId: string,
  actor: InputRequestActor,
): Promise<number> {
  const where = { companyId, status: In([...OPEN_INPUT_REQUEST_STATUSES]) };
  return repo().countBy(
    administers(actor) ? where : { ...where, assigneeUserId: actor.userId, adminOnly: false },
  );
}
