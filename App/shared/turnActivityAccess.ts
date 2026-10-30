import { describeChatToolCall, type ChatActivityEvent } from "./chatActivity.js";

/**
 * Who may see how an AI turn came to be, beyond the reply it wrote.
 *
 * A turn's activity (`shared/chatActivity.ts`) holds what its tools were asked
 * and what they returned, under whichever authority the turn ran with. In a
 * direct chat only one person can read it — the Member whose turn it was. In a
 * room several people read the same reply, and they do not all hold the same
 * access, so the room sees the steps and the asker sees what is in them:
 *
 *   - `full`  — every step with its arguments, results and the AI Model's
 *               thinking summary: what the direct chat shows its owner.
 *   - `steps` — what was done, how it went and how long it took, with nothing
 *               a tool read or returned: no arguments, no results, no hints
 *               drawn from them, no error text, no thinking. The work is
 *               reported; its subject is not (the rule the work timeline
 *               keeps for a conversation that is not yours).
 *   - `none`  — the reply and nothing else.
 *
 * The rules, in order:
 *
 *   1. Where people outside the company can read the room — a channel shared
 *      with another organization, one nobody could confirm is private, a
 *      customer channel — nothing beyond the reply, for anyone (AGENTS.md §3).
 *   2. Only a Member reads steps. An AI Employee reading the room, or anyone
 *      outside the company, reads replies.
 *   3. A turn under a Member's authority shows everything to that Member and
 *      the steps to everyone else who can read the room.
 *   4. A turn under an AI Employee's own authority shows everything to any
 *      Member who can read the room, as that employee's Run transcripts do; a
 *      turn under nobody's authority reached no company data to begin with.
 *
 * Pure, and shared: the server enforces it on every read, the browser uses it
 * only to say which view it was given.
 */

export type TurnActivityAccess = "full" | "steps" | "none";

/** Whose access the turn ran with. */
export type TurnAuthority =
  | { kind: "member"; userId: string }
  | { kind: "employee" }
  | { kind: "untrusted" };

/**
 * Who can read the room the reply lands in: only the company's own people, or
 * people from another organization too (`groupAudience` in
 * `server/services/chatSurfaces/inbound.ts` decides it for a chat surface; a
 * Workspace channel is always `internal`).
 */
export type TurnAudience = "internal" | "shared" | "unknown";

/** Who is asking to read the turn. */
export type TurnViewer =
  | { kind: "member"; userId: string }
  | { kind: "employee"; employeeId: string }
  | { kind: "outside" };

export function turnActivityAccess(args: {
  audience: TurnAudience;
  authority: TurnAuthority;
  viewer: TurnViewer;
}): TurnActivityAccess {
  if (args.audience !== "internal") return "none";
  if (args.viewer.kind !== "member") return "none";
  if (args.authority.kind !== "member") return "full";
  return args.authority.userId === args.viewer.userId ? "full" : "steps";
}

/**
 * Why a recorded step carries no arguments or results (`detail.withheld`):
 *
 *   - `steps`      — the reader sees the room's view of someone else's turn.
 *   - `discussion` — a discussion bound to a Decision, TLDR or review records
 *                    that it read the record, never what the read returned.
 */
export type ActivityWithheld = "steps" | "discussion";

/**
 * The room's view of one recorded event: the same step, status and timing,
 * with everything a tool read or returned taken out. Labels are recomputed
 * from the tool's name alone, because the recorded summary names its
 * salient argument ("Searched email for “salary review”") and a result's
 * hint names what it found ("“Q3 renewal” · from ana@acme.com").
 */
export function stepsOnlyActivityEvent(event: ChatActivityEvent): ChatActivityEvent {
  const detail = event.detail ?? {};
  switch (event.kind) {
    case "tool_use": {
      const described = describeChatToolCall(event.name, null);
      return {
        ...event,
        summary: described.active,
        detail: { input: null, worker: described.worker, withheld: "steps" },
      };
    }
    case "tool_result": {
      const described = describeChatToolCall(event.name, null);
      const approval =
        detail.approval && typeof detail.approval === "object" ? { approval: detail.approval } : {};
      const outcome = event.isError ? "failed" : approval.approval ? "waiting for approval" : "";
      return {
        ...event,
        summary: [described.done, outcome].filter(Boolean).join(" · "),
        detail: {
          output: null,
          durationMs: typeof detail.durationMs === "number" ? detail.durationMs : null,
          ...(typeof detail.images === "number" ? { images: detail.images } : {}),
          ...approval,
          worker: described.worker,
          withheld: "steps",
        },
      };
    }
    case "reasoning":
      return {
        ...event,
        summary: "",
        detail: {
          text: "",
          block: typeof detail.block === "string" ? detail.block : String(event.ordinal),
          withheld: "steps",
        },
      };
    case "progress": {
      // The employee's own milestone says what it is working on; the room
      // sees how far along it is.
      const percent = typeof detail.percent === "number" ? detail.percent : 0;
      return {
        ...event,
        summary: `${percent}%`,
        detail: { percent, label: "In progress", withheld: "steps" },
      };
    }
    default:
      // Waits, notices, starts, stops and the finish are the server's own
      // words about the turn, never what a tool said.
      return event;
  }
}

/** One event as `access` lets its reader see it; null when it shows nothing. */
export function activityEventFor(
  event: ChatActivityEvent,
  access: TurnActivityAccess,
): ChatActivityEvent | null {
  if (access === "none") return null;
  return access === "full" ? event : stepsOnlyActivityEvent(event);
}

/** Whether a step's arguments and results were left out, and why. */
export function withheldReason(detail: Record<string, unknown> | null): ActivityWithheld | null {
  const value = detail?.withheld;
  return value === "steps" || value === "discussion" ? value : null;
}
