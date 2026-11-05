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
  | "left_open";

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
