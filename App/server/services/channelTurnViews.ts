import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import {
  ChannelTurn,
  type ChannelTurnAuthority,
  type ChannelTurnKind,
  type ChannelTurnStatus,
  type ChannelTurnWait,
} from "../db/entities/ChannelTurn.js";
import { User } from "../db/entities/User.js";
import {
  parseTurnActivitySummary,
  type TurnActivitySummary,
} from "../../shared/chatActivity.js";
import type { TurnAuthority } from "../../shared/turnActivityAccess.js";
import { broadcastToCompany } from "./realtime.js";

/**
 * What a Workspace room is told about an AI Employee's turn in it: who is
 * taking it, for what, under whose authority, how it stands, and — once it
 * ended — "Worked for 2m 14s · 9 steps". Never its steps: a reader follows
 * those over the turn's own stream, which decides what that reader may see
 * (`shared/turnActivityAccess.ts`).
 *
 * Kept apart from the turn runner (`channelTurns.ts`) so the Workspace's
 * message hydration can read it without importing the runner.
 */

export type ChannelTurnSummary = {
  id: string;
  channelId: string;
  kind: ChannelTurnKind;
  status: ChannelTurnStatus;
  employee: { id: string; name: string; slug: string; role: string } | null;
  /** The message it answers; a discussion turn's question. */
  triggerMessageId: string | null;
  discussionId: string | null;
  round: number | null;
  authority: ChannelTurnAuthority;
  /** The Member whose authority a `member` turn runs under. */
  requester: { id: string; name: string } | null;
  waitingFor: ChannelTurnWait | null;
  attempt: number;
  /** When it was asked for, ISO with milliseconds. */
  startedAt: string;
  endedAt: string | null;
  replyMessageId: string | null;
  /** The summary once it ended. */
  activity: TurnActivitySummary | null;
};

/** What a reply carries about the turn that wrote it. */
export type MessageTurnInfo = Pick<
  ChannelTurnSummary,
  | "id"
  | "kind"
  | "status"
  | "triggerMessageId"
  | "discussionId"
  | "round"
  | "authority"
  | "requester"
  | "activity"
>;

function repo() {
  return AppDataSource.getRepository(ChannelTurn);
}

/** The authority a turn ran with, as the access rules take it. */
export function channelTurnAuthority(
  turn: Pick<ChannelTurn, "authority" | "requesterUserId">,
): TurnAuthority {
  if (turn.authority === "member" && turn.requesterUserId) {
    return { kind: "member", userId: turn.requesterUserId };
  }
  return turn.authority === "employee" ? { kind: "employee" } : { kind: "untrusted" };
}

export async function summarizeChannelTurns(turns: ChannelTurn[]): Promise<ChannelTurnSummary[]> {
  if (turns.length === 0) return [];
  const employeeIds = [...new Set(turns.map((turn) => turn.employeeId))];
  const userIds = [
    ...new Set(turns.map((turn) => turn.requesterUserId).filter((id): id is string => !!id)),
  ];
  const [employees, users] = await Promise.all([
    AppDataSource.getRepository(AIEmployee).find({
      where: { id: In(employeeIds) },
      select: { id: true, name: true, slug: true, role: true },
    }),
    userIds.length
      ? AppDataSource.getRepository(User).find({
          where: { id: In(userIds) },
          select: { id: true, name: true, email: true },
        })
      : Promise.resolve([] as User[]),
  ]);
  const employeeById = new Map(employees.map((employee) => [employee.id, employee]));
  const userById = new Map(users.map((user) => [user.id, user]));
  return turns.map((turn) => {
    const employee = employeeById.get(turn.employeeId);
    const requester = turn.requesterUserId ? userById.get(turn.requesterUserId) : null;
    return {
      id: turn.id,
      channelId: turn.channelId,
      kind: turn.kind,
      status: turn.status,
      employee: employee
        ? { id: employee.id, name: employee.name, slug: employee.slug, role: employee.role }
        : null,
      triggerMessageId: turn.triggerMessageId,
      discussionId: turn.discussionId,
      round: turn.round,
      authority: turn.authority,
      requester: requester
        ? { id: requester.id, name: requester.name || requester.email }
        : turn.requesterUserId
          ? { id: turn.requesterUserId, name: "A Member" }
          : null,
      waitingFor: turn.status === "working" ? turn.waitingFor : null,
      attempt: turn.attempt,
      startedAt: turn.acceptedAt.toISOString(),
      endedAt: turn.endedAt?.toISOString() ?? null,
      replyMessageId: turn.replyMessageId,
      activity: parseTurnActivitySummary(turn.activityJson),
    };
  });
}

export async function summarizeChannelTurn(turn: ChannelTurn): Promise<ChannelTurnSummary> {
  const [summary] = await summarizeChannelTurns([turn]);
  return summary;
}

/** The turns still running in a channel, oldest first: what a room re-attaches to. */
export async function runningChannelTurns(
  companyId: string,
  channelId: string,
): Promise<ChannelTurn[]> {
  return repo().find({
    where: { companyId, channelId, status: "working" },
    order: { acceptedAt: "ASC" },
    take: 50,
  });
}

/** The turn behind each of these messages, for the ones an AI turn wrote. */
export async function turnsForMessages(messageIds: string[]): Promise<Map<string, ChannelTurn>> {
  const out = new Map<string, ChannelTurn>();
  if (messageIds.length === 0) return out;
  for (let i = 0; i < messageIds.length; i += 500) {
    const rows = await repo().find({
      where: { replyMessageId: In(messageIds.slice(i, i + 500)) },
    });
    for (const row of rows) if (row.replyMessageId) out.set(row.replyMessageId, row);
  }
  return out;
}

/** {@link MessageTurnInfo} for each message an AI turn wrote. */
export async function messageTurnInfo(messageIds: string[]): Promise<Map<string, MessageTurnInfo>> {
  const turns = await turnsForMessages(messageIds);
  const summaries = await summarizeChannelTurns([...turns.values()]);
  const out = new Map<string, MessageTurnInfo>();
  for (const summary of summaries) {
    if (!summary.replyMessageId) continue;
    out.set(summary.replyMessageId, {
      id: summary.id,
      kind: summary.kind,
      status: summary.status,
      triggerMessageId: summary.triggerMessageId,
      discussionId: summary.discussionId,
      round: summary.round,
      authority: summary.authority,
      requester: summary.requester,
      activity: summary.activity,
    });
  }
  return out;
}

/** Tell the room a turn started, began or stopped waiting, or ended. */
export async function announceChannelTurn(turnOrId: ChannelTurn | string): Promise<void> {
  try {
    const turn =
      typeof turnOrId === "string" ? await repo().findOneBy({ id: turnOrId }) : turnOrId;
    if (!turn) return;
    broadcastToCompany(turn.companyId, {
      type: "turn.update",
      channelId: turn.channelId,
      turn: await summarizeChannelTurn(turn),
    });
  } catch (error) {
    // The room catches up on its next read; a lost frame never fails a turn.
    // eslint-disable-next-line no-console
    console.warn("[channel-turns] could not announce a turn:", error);
  }
}
