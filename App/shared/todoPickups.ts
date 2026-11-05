import type { TurnActivitySummary } from "./chatActivity.js";
import type { TurnActivityAccess } from "./turnActivityAccess.js";

/**
 * A pickup is one session an AI Employee spends on one Todo
 * (`server/services/todoPickups.ts`). These are the words the server and the
 * browser share for what started one and how it stands.
 */

export type TodoPickupTrigger =
  /** A Member or an AI Employee handed the Todo over. */
  | "assigned"
  /** A Member pressed Start now, or the employee queued its own Todo. */
  | "start_now"
  /** The Todo entered review and this AI Employee is its reviewer. */
  | "review"
  /** The previous pickup ended with the Todo neither finished nor waiting. */
  | "left_open"
  /** The time it said it would check back on a wait came. */
  | "wait_over"
  /** A new email arrived on a thread linked to the Todo. */
  | "email_reply"
  /** A Project's email intake filed this Todo from an email. */
  | "email_intake"
  /** A Member answered on the thread while it waited on a person. */
  | "member_comment"
  /** A Member ended the wait from the Todo's panel. */
  | "wait_stopped"
  /** The Decision it was waiting on was answered or dismissed. */
  | "decision_answered"
  /** The email or work it proposed for review was discarded, declined, or finished. */
  | "review_outcome"
  /** The Repository work session it was waiting on ended its turn. */
  | "work_session_ended";

/** What an `in_progress` Todo can be waiting on. */
export type TodoWaitKind =
  | "customer"
  | "member"
  | "decision"
  | "mail_review"
  | "work_review"
  | "browser_approval"
  | "work_session"
  | "date";

export const TODO_WAIT_LABEL: Record<TodoWaitKind, string> = {
  customer: "Waiting on customer",
  member: "Waiting on a person",
  decision: "Waiting on a Decision",
  mail_review: "Waiting on email review",
  work_review: "Waiting on work review",
  browser_approval: "Waiting on browser approval",
  work_session: "Waiting on a work session",
  date: "Waiting until a date",
};

export type TodoPickupStatus = "queued" | "running" | "done" | "failed" | "stopped" | "skipped";

/** Why a queued pickup has not started. Null: nothing but its turn in the queue. */
export type TodoPickupHold =
  | "standdown"
  | "model_unavailable"
  | "employee_busy"
  | "thread_busy"
  /** It failed and retries at its `notBeforeAt`. */
  | "retrying";

export const TODO_PICKUP_TRIGGER_LABEL: Record<TodoPickupTrigger, string> = {
  assigned: "Assigned",
  start_now: "Started by hand",
  review: "Up for review",
  left_open: "Left unfinished",
  wait_over: "Checking back",
  email_reply: "New email",
  email_intake: "Filed from email",
  member_comment: "A person answered",
  wait_stopped: "Told to carry on",
  decision_answered: "Decision answered",
  review_outcome: "Review came back",
  work_session_ended: "Work session ended",
};

/** What a queued pickup is held by, in words for its Todo's panel. */
export function todoPickupHoldLabel(hold: TodoPickupHold | null): string {
  switch (hold) {
    case "standdown":
      return "Stood down. It starts when the Standdown is lifted.";
    case "model_unavailable":
      return "The AI Model is unavailable. It starts when the model is back.";
    case "employee_busy":
      return "Working on something else. It starts when that finishes.";
    case "thread_busy":
      return "Replying on this task. It starts when that finishes.";
    case "retrying":
      return "The last try failed. It tries again shortly.";
    default:
      return "Queued. It starts on the next check.";
  }
}

export type TodoPickupView = {
  id: string;
  todoId: string;
  status: TodoPickupStatus;
  trigger: TodoPickupTrigger;
  hold: TodoPickupHold | null;
  employee: { id: string; name: string; slug: string; role: string } | null;
  /** Whose access it runs with. */
  authority: "member" | "employee";
  /** The Member whose authority a `member` pickup runs under. */
  requester: { id: string; name: string } | null;
  /** It can't send mail, use the browser or start other work on its own. */
  preparationOnly: boolean;
  /** Preparing, plus the browser: an owner trusts the sender of the email behind it. */
  withBrowser?: boolean;
  attempt: number;
  /** When it was asked for, ISO with milliseconds. */
  startedAt: string;
  notBeforeAt: string | null;
  endedAt: string | null;
  /** Why it ended the way it did, when it did not simply finish. */
  error: string | null;
  /** "Worked for 2m 14s · 9 steps", once it ended. */
  activity: TurnActivitySummary | null;
  /** What this reader may see of its steps. */
  access: TurnActivityAccess;
};

/** One Todo on an AI Employee's plate (`server/services/todoWorkQueue.ts`). */
export type TodoQueueItem = {
  todoId: string;
  /** `{Project.key}-{Todo.number}`. */
  ref: string;
  title: string;
  /** Nobody at the company wrote this text, so it is a request, not an instruction. */
  untrustedText: boolean;
  /** Outside words started this, so its session works within limits. */
  heldToLimits: boolean;
  projectSlug: string;
  projectName: string;
  status: string;
  priority: string;
  dueAt: string | null;
  /** The session running or queued for it, if there is one. */
  pickup: {
    status: "queued" | "running";
    trigger: TodoPickupTrigger;
    hold: TodoPickupHold | null;
    startedAt: string;
    notBeforeAt: string | null;
    /** Its place among what's due, 1 being next up. */
    position: number | null;
  } | null;
  waiting: {
    on: TodoWaitKind;
    reason: string;
    since: string | null;
    checkAt: string | null;
  } | null;
};

/** The Todos on an AI Employee's plate, limited to Projects the reader can open. */
export type EmployeeTodoQueue = {
  running: TodoQueueItem[];
  queued: TodoQueueItem[];
  queuedCount: number;
  waiting: TodoQueueItem[];
  waitingCount: number;
};
