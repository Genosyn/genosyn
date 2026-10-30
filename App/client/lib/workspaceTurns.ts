import { turnActivityAccess, type TurnActivityAccess } from "../../shared/turnActivityAccess";
import type {
  WorkspaceMessage,
  WorkspaceMessageTurn,
  WorkspaceTurn,
} from "./workspace";

/**
 * The arithmetic of AI turns in a Workspace room: which turns are still
 * running, what each live card says above its steps, what a reader may see of
 * them, and which failed replies can be asked again. The server decides all
 * of it for real (`services/channelTurns.ts`, `shared/turnActivityAccess.ts`);
 * this only keeps the room's picture in step. Pure, so
 * `workspaceTurns.test.ts` can drive it without a DOM.
 */

/** Fold a turn's update into the room's running turns: kept while it works, gone once it ends. */
export function applyTurnUpdate(running: WorkspaceTurn[], turn: WorkspaceTurn): WorkspaceTurn[] {
  const index = running.findIndex((candidate) => candidate.id === turn.id);
  if (turn.status !== "working") {
    return index === -1 ? running : running.filter((candidate) => candidate.id !== turn.id);
  }
  if (index === -1) {
    return [...running, turn].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  }
  const current = running[index];
  if (
    current.waitingFor === turn.waitingFor &&
    current.attempt === turn.attempt &&
    current.status === turn.status
  ) {
    return running;
  }
  const next = running.slice();
  next[index] = turn;
  return next;
}

/** A turn's reply landing in the room is the end of that turn. */
export function dropAnsweredTurns(
  running: WorkspaceTurn[],
  message: Pick<WorkspaceMessage, "aiTurn">,
): WorkspaceTurn[] {
  const turnId = message.aiTurn?.id;
  if (!turnId || !running.some((turn) => turn.id === turnId)) return running;
  return running.filter((turn) => turn.id !== turnId);
}

/** What this Member may see of a turn's steps — the server's rule, for presentation. */
export function turnAccessFor(
  turn: Pick<WorkspaceTurn, "authority" | "requester">,
  meId: string,
): TurnActivityAccess {
  return turnActivityAccess({
    audience: "internal",
    authority:
      turn.authority === "member" && turn.requester
        ? { kind: "member", userId: turn.requester.id }
        : turn.authority === "employee"
          ? { kind: "employee" }
          : { kind: "untrusted" },
    viewer: { kind: "member", userId: meId },
  });
}

/**
 * The line under the AI Employee's name on its live card: what the turn is
 * for. A discussion turn says which round it is; a reply says whose message
 * it answers.
 */
export function turnCardContext(
  turn: Pick<WorkspaceTurn, "kind" | "authority" | "requester" | "round" | "attempt">,
  options: { meId: string; rounds?: number | null },
): string {
  if (turn.kind === "discussion") {
    const round = turn.round && turn.round > 0 ? turn.round : 1;
    return options.rounds
      ? `Round ${round} of ${options.rounds} · group discussion`
      : `Round ${round} · group discussion`;
  }
  if (turn.kind === "follow_through") return "Doing its share of the outcome";
  const again = turn.attempt > 1 ? " · picked up again" : "";
  if (turn.authority === "member" && turn.requester) {
    return turn.requester.id === options.meId
      ? `Replying to you${again}`
      : `Replying to ${turn.requester.name}${again}`;
  }
  return turn.authority === "employee"
    ? `Replying to an AI colleague’s @mention${again}`
    : `Replying to an incoming webhook message${again}`;
}

/**
 * What the card says about the steps this reader is shown, when it is not
 * everything. Null when the reader sees every step in full.
 */
export function stepsVisibilityNote(
  access: TurnActivityAccess,
  turn: Pick<WorkspaceTurn, "requester">,
): string | null {
  if (access === "full") return null;
  if (access === "none") return "Only the reply is shown here.";
  const who = turn.requester?.name ?? "the Member who asked";
  return `It works with ${who}’s access, so only ${who} sees what each step read and returned.`;
}

/**
 * The failed replies this room can ask again: the newest reply to each
 * message from each AI Employee, while that employee is not replying here.
 * The server checks the same before it starts anything.
 */
export function retryableTurnIds(
  messages: WorkspaceMessage[],
  running: WorkspaceTurn[],
): Set<string> {
  const newest = new Map<string, { turn: WorkspaceMessageTurn; at: number }>();
  for (const message of messages) {
    const turn = message.aiTurn;
    if (!turn || turn.kind !== "reply" || message.author?.kind !== "ai") continue;
    const key = `${message.author.id}|${turn.triggerMessageId ?? ""}`;
    const at = Date.parse(message.createdAt);
    const seen = newest.get(key);
    if (!seen || at >= seen.at) newest.set(key, { turn, at });
  }
  const busy = new Set(
    running
      .filter((turn) => turn.kind === "reply" && turn.employee)
      .map((turn) => turn.employee!.id),
  );
  const out = new Set<string>();
  for (const [key, { turn }] of newest) {
    if (turn.status !== "error" && turn.status !== "skipped") continue;
    const employeeId = key.slice(0, key.indexOf("|"));
    if (busy.has(employeeId)) continue;
    out.add(turn.id);
  }
  return out;
}

/** The typing pill's names, without the AI Employees whose live card already shows them working. */
export function typersWithoutTurns<T extends { kind: "user" | "ai"; id: string }>(
  typers: T[],
  running: WorkspaceTurn[],
): T[] {
  const working = new Set(running.map((turn) => turn.employee?.id).filter(Boolean));
  const kept = typers.filter((typer) => !(typer.kind === "ai" && working.has(typer.id)));
  return kept.length === typers.length ? typers : kept;
}

/** The badge a reply shows for how its turn ended, when it did not simply answer. */
export function replyTurnBadge(
  turn: Pick<WorkspaceMessageTurn, "status"> | null | undefined,
): { tone: "danger" | "warning" | "neutral"; label: string } | null {
  switch (turn?.status) {
    case "error":
      return { tone: "danger", label: "Error" };
    case "skipped":
      return { tone: "warning", label: "Not available" };
    case "interrupted":
      return { tone: "neutral", label: "Stopped" };
    default:
      return null;
  }
}
