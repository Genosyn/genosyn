import type { EntityManager } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import type { RecruitingApplication } from "../../db/entities/RecruitingApplication.js";
import {
  RecruitingApplicationEvent,
  type ApplicationEventActorKind,
  type ApplicationEventKind,
} from "../../db/entities/RecruitingApplicationEvent.js";
import { User } from "../../db/entities/User.js";
import type { RecruitingActor } from "./openings.js";

let lastIssued = 0;

/** Now, to the millisecond, strictly after the last timestamp this process issued. */
function monotonicNow(): Date {
  const now = Date.now();
  lastIssued = now > lastIssued ? now : lastIssued + 1;
  return new Date(lastIssued);
}

/** Who did something on an Application: the candidate, or one of the company's actors. */
export type TimelineActor = RecruitingActor | { kind: "candidate"; name: string };

async function actorName(actor: TimelineActor): Promise<string> {
  if (actor.name) return actor.name;
  if (actor.kind === "member") {
    const user = await AppDataSource.getRepository(User).findOneBy({ id: actor.userId });
    return user?.name || user?.email || "A Member";
  }
  if (actor.kind === "employee") {
    const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({ id: actor.employeeId });
    return employee?.name ?? "An AI Employee";
  }
  return actor.kind === "system" ? "Genosyn" : "The candidate";
}

/** Append one line to an Application's timeline. */
export async function recordApplicationEvent(
  args: {
    application: Pick<RecruitingApplication, "id" | "companyId" | "openingId">;
    kind: ApplicationEventKind;
    actor: TimelineActor;
    fromStage?: string | null;
    toStage?: string | null;
    body?: string;
    meta?: Record<string, unknown>;
  },
  manager: EntityManager = AppDataSource.manager,
): Promise<RecruitingApplicationEvent> {
  const repo = manager.getRepository(RecruitingApplicationEvent);
  const actorKind: ApplicationEventActorKind = args.actor.kind;
  return repo.save(
    repo.create({
      companyId: args.application.companyId,
      openingId: args.application.openingId,
      applicationId: args.application.id,
      kind: args.kind,
      actorKind,
      actorUserId: args.actor.kind === "member" ? args.actor.userId : null,
      actorEmployeeId: args.actor.kind === "employee" ? args.actor.employeeId : null,
      actorName: (await actorName(args.actor)).slice(0, 200),
      fromStage: args.fromStage ?? null,
      toStage: args.toStage ?? null,
      occurredAt: monotonicNow(),
      body: (args.body ?? "").slice(0, 10_000),
      metaJson: JSON.stringify(args.meta ?? {}),
    }),
  );
}

export type ApplicationEventDto = {
  id: string;
  kind: ApplicationEventKind;
  actorKind: ApplicationEventActorKind;
  actorName: string;
  actorUserId: string | null;
  actorEmployeeId: string | null;
  fromStage: string | null;
  toStage: string | null;
  body: string;
  meta: Record<string, unknown>;
  occurredAt: string;
};

export function applicationEventDto(event: RecruitingApplicationEvent): ApplicationEventDto {
  let meta: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(event.metaJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      meta = parsed as Record<string, unknown>;
    }
  } catch {
    meta = {};
  }
  return {
    id: event.id,
    kind: event.kind,
    actorKind: event.actorKind,
    actorName: event.actorName,
    actorUserId: event.actorUserId,
    actorEmployeeId: event.actorEmployeeId,
    fromStage: event.fromStage,
    toStage: event.toStage,
    body: event.body,
    meta,
    occurredAt: event.occurredAt.toISOString(),
  };
}

export async function listApplicationEvents(applicationId: string): Promise<ApplicationEventDto[]> {
  const rows = await AppDataSource.getRepository(RecruitingApplicationEvent).find({
    where: { applicationId },
    order: { occurredAt: "ASC" },
    take: 500,
  });
  return rows.map(applicationEventDto);
}
