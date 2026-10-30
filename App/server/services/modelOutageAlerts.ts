import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIModel } from "../db/entities/AIModel.js";
import type { AIModelOutage } from "../db/entities/AIModelOutage.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { waitingWorkText } from "../../shared/modelAvailability.js";
import { createNotifications } from "./notifications.js";
import { PROVIDERS } from "./providers.js";
import { waitingWorkByModel } from "./modelOutageViews.js";

/**
 * Telling owners and admins about an AI Model outage: once when a check of its
 * own confirms the model is unavailable, and once when it answers again —
 * never once per Run or chat message that waited. An outage that heals before
 * its first check (a blip the runtime's own retries nearly rode out) pages
 * nobody. `modelAvailability.ts` claims each notice on the outage row, so a
 * restart or a second replica never sends one twice.
 */

async function audience(companyId: string): Promise<string[]> {
  const memberships = await AppDataSource.getRepository(Membership).find({
    where: { companyId, role: In(["owner", "admin"]) },
  });
  return [...new Set(memberships.map((membership) => membership.userId))];
}

function modelName(model: AIModel | null): string {
  if (!model) return "An AI Model";
  return `${PROVIDERS[model.provider]?.label ?? "AI Model"} · ${model.model}`;
}

async function context(outage: AIModelOutage) {
  const [model, company, userIds] = await Promise.all([
    AppDataSource.getRepository(AIModel).findOneBy({
      id: outage.modelId,
      companyId: outage.companyId,
    }),
    AppDataSource.getRepository(Company).findOneBy({ id: outage.companyId }),
    audience(outage.companyId),
  ]);
  if (!company || userIds.length === 0) return null;
  return { model, company, userIds };
}

const LINK = "/settings/ai-models";

/** The outage is confirmed: the model is unavailable and its work waits. */
export async function notifyModelUnavailable(outage: AIModelOutage): Promise<void> {
  const ctx = await context(outage);
  if (!ctx) return;
  const waiting = ctx.model
    ? (await waitingWorkByModel(outage.companyId, [ctx.model.id]).catch(() => null))?.get(
        ctx.model.id,
      )
    : undefined;
  const waitingLine = waiting ? waitingWorkText(waiting) : null;
  const body = [
    outage.lastError,
    "AI work on it waits instead of failing and carries on automatically once it answers again; Genosyn keeps checking.",
    waitingLine ? `${waitingLine}.` : null,
  ]
    .filter(Boolean)
    .join(" ");
  await createNotifications(
    ctx.userIds.map((userId) => ({
      companyId: outage.companyId,
      userId,
      kind: "model_unavailable" as const,
      title: `${modelName(ctx.model)} is unavailable`,
      body,
      link: LINK,
      actorKind: "system" as const,
      entityKind: "ai_model" as const,
      entityId: outage.modelId,
    })),
  );
}

/** The outage is over: the model answers again and the work that waited carries on. */
export async function notifyModelAvailableAgain(outage: AIModelOutage): Promise<void> {
  const ctx = await context(outage);
  if (!ctx) return;
  const ended = outage.endedAt ?? new Date();
  const minutes = Math.max(1, Math.round((ended.getTime() - outage.startedAt.getTime()) / 60_000));
  const span =
    minutes < 90 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
  await createNotifications(
    ctx.userIds.map((userId) => ({
      companyId: outage.companyId,
      userId,
      kind: "model_available" as const,
      title: `${modelName(ctx.model)} is available again`,
      body: `It was unavailable for about ${span}. The work that waited for it is carrying on, paused Runs first.`,
      link: LINK,
      actorKind: "system" as const,
      entityKind: "ai_model" as const,
      entityId: outage.modelId,
    })),
  );
}
