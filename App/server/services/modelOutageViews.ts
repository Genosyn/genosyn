import { In, MoreThan } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import type { AIModel } from "../db/entities/AIModel.js";
import { Conversation } from "../db/entities/Conversation.js";
import { ConversationMessage } from "../db/entities/ConversationMessage.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import {
  MODEL_WAIT_PROGRESS_LABEL,
  type PublicModelAvailability,
} from "../../shared/modelAvailability.js";
import { modelAvailabilityState, type AvailabilityModel } from "./modelAvailability.js";
import { waitsByModel } from "./modelWaits.js";
import { attachedModelsByEmployee } from "./models.js";

/**
 * What an owner reads about an AI Model that is unavailable: since when, why,
 * when it is checked next, and what is waiting for it — the Runs queued or
 * paused on it and the chat messages it has yet to answer.
 */

export type WaitingWork = { runs: number; chats: number; other: number };

const NOTHING: WaitingWork = { runs: 0, chats: 0, other: 0 };

/** Keep each `IN (…)` list well under every driver's parameter limit. */
const IN_CHUNK = 500;

function chunks<T>(values: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += IN_CHUNK) out.push(values.slice(i, i + IN_CHUNK));
  return out;
}

/**
 * The chat replies waiting for their AI Model to come back, across the install.
 * A reply that is working always holds a lease — running, or deferred until
 * its next look — and a finished one never does, so the lease's index bounds
 * the read to replies in flight; `status` sits after the message text and is
 * never filtered on directly (AGENTS.md §7).
 */
export async function modelWaitingChatTurns(): Promise<
  Pick<ConversationMessage, "id" | "conversationId" | "modelId">[]
> {
  const rows = await AppDataSource.getRepository(ConversationMessage).find({
    where: { turnLeaseExpiresAt: MoreThan(new Date(0)) },
    select: {
      id: true,
      conversationId: true,
      modelId: true,
      role: true,
      status: true,
      progressLabel: true,
    },
  });
  return rows.filter(
    (row) =>
      row.role === "assistant" &&
      row.status === "working" &&
      row.progressLabel === MODEL_WAIT_PROGRESS_LABEL,
  );
}

/**
 * The work waiting on each of these models, for one company. A Run waits on
 * the model its Routine pins while that model is still attached to the
 * Routine's employee, and on the employee's active model otherwise — as
 * `resolveRoutineModel` decides when it starts. A chat message waits on the
 * model it was sent with, or its employee's active one. Reads waiting Runs
 * through the `(employeeId, status)` index and never a transcript.
 */
export async function waitingWorkByModel(
  companyId: string,
  modelIds: readonly string[],
): Promise<Map<string, WaitingWork>> {
  const result = new Map<string, WaitingWork>(modelIds.map((id) => [id, { ...NOTHING }]));
  if (modelIds.length === 0) return result;
  const wanted = new Set(modelIds);
  const employees = await AppDataSource.getRepository(AIEmployee).find({
    where: { companyId },
    select: { id: true },
  });
  const employeeIds = employees.map((employee) => employee.id);
  if (employeeIds.length === 0) return result;
  const attached = await attachedModelsByEmployee(employeeIds);
  const modelFor = (employeeId: string, pinned: string | null): string | null => {
    const own = attached.get(employeeId);
    if (!own) return null;
    if (pinned && own.models.some((model) => model.id === pinned)) return pinned;
    return own.activeId;
  };

  const runs: Pick<Run, "id" | "routineId" | "employeeId">[] = [];
  for (const part of chunks(employeeIds)) {
    runs.push(
      ...(await AppDataSource.getRepository(Run).find({
        where: { employeeId: In(part), status: "queued" },
        select: { id: true, routineId: true, employeeId: true },
      })),
    );
  }
  const routines = new Map<string, Pick<Routine, "id" | "employeeId" | "modelId">>();
  for (const part of chunks([...new Set(runs.map((run) => run.routineId))])) {
    for (const routine of await AppDataSource.getRepository(Routine).find({
      where: { id: In(part) },
      select: { id: true, employeeId: true, modelId: true },
    }))
      routines.set(routine.id, routine);
  }
  for (const run of runs) {
    const routine = routines.get(run.routineId);
    if (!routine) continue;
    const modelId = modelFor(routine.employeeId, routine.modelId);
    if (modelId && wanted.has(modelId)) result.get(modelId)!.runs += 1;
  }

  const waiting = await modelWaitingChatTurns();
  if (waiting.length > 0) {
    const conversations = new Map<string, string>();
    for (const part of chunks([...new Set(waiting.map((message) => message.conversationId))])) {
      for (const conversation of await AppDataSource.getRepository(Conversation).find({
        where: { id: In(part) },
        select: { id: true, employeeId: true },
      }))
        conversations.set(conversation.id, conversation.employeeId);
    }
    const ours = new Set(employeeIds);
    for (const message of waiting) {
      const employeeId = conversations.get(message.conversationId);
      if (!employeeId || !ours.has(employeeId)) continue;
      const modelId = modelFor(employeeId, message.modelId);
      if (modelId && wanted.has(modelId)) result.get(modelId)!.chats += 1;
    }
  }

  // Everything else that waits for it: an email's read, a paused Pipeline
  // run, a Decision's pickup, an answer owed on Slack or by text.
  const others = await waitsByModel(companyId, modelIds);
  for (const [modelId, count] of others) {
    const entry = result.get(modelId);
    if (entry) entry.other += count;
  }
  return result;
}

/** A model's availability for the wire, with what waits on it when that was counted. */
export function publicModelAvailability(
  model: AvailabilityModel,
  waiting: WaitingWork = NOTHING,
): PublicModelAvailability {
  let state;
  try {
    state = modelAvailabilityState(model);
  } catch {
    return { state: "available" };
  }
  if (state.available) return { state: "available" };
  return {
    state: "unavailable",
    since: state.since.toISOString(),
    reason: state.cause,
    detail: state.detail,
    checks: state.checks,
    lastCheckedAt: state.lastCheckedAt?.toISOString() ?? null,
    nextCheckAt: state.nextCheckAt.toISOString(),
    checking: state.checking,
    waiting: { ...waiting },
  };
}

/**
 * Each model's availability, counting what waits only on the ones that are
 * unavailable — an available model costs no query.
 */
export async function publicAvailabilityByModel(
  companyId: string,
  models: readonly AIModel[],
): Promise<Map<string, PublicModelAvailability>> {
  const views = new Map<string, PublicModelAvailability>();
  const down = models.filter((model) => publicModelAvailability(model).state === "unavailable");
  const waiting = down.length
    ? await waitingWorkByModel(
        companyId,
        down.map((model) => model.id),
      )
    : new Map<string, WaitingWork>();
  for (const model of models) {
    views.set(model.id, publicModelAvailability(model, waiting.get(model.id)));
  }
  return views;
}
