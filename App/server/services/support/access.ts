import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { SupportEvent, type SupportActorKind } from "../../db/entities/SupportEvent.js";
import { SupportTicket } from "../../db/entities/SupportTicket.js";
import { User } from "../../db/entities/User.js";
import type { SupportEventKind } from "../../../shared/support.js";
import { ticketReference } from "../../../shared/support.js";
import { SUPPORT_CHAT_VISITOR_LABEL } from "../../../shared/supportChat.js";
import { recordAudit } from "../audit.js";
import { emitResourceChange } from "../resourceEvents.js";
import { SupportNotFoundError } from "./errors.js";

/**
 * The pieces every Support module shares: who is acting, the ticket's timeline
 * and audit trail, and how a ticket is told to the pages watching it.
 */

/** Who changed a ticket: a Member, an AI Employee, the server or the customer. */
export type SupportActor =
  | { kind: "user"; userId: string }
  | { kind: "ai"; employeeId: string }
  | { kind: "system" }
  | { kind: "customer"; name: string };

/** What to call a ticket's customer: a visitor on the Chat widget may have left neither. */
export function requesterDisplay(
  ticket: Pick<SupportTicket, "requesterName" | "requesterEmail">,
): string {
  return ticket.requesterName || ticket.requesterEmail || SUPPORT_CHAT_VISITOR_LABEL;
}

export function parseJsonArray<T = unknown>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function parseJsonObject<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}

export async function requireTicket(companyId: string, ticketId: string): Promise<SupportTicket> {
  const ticket = await AppDataSource.getRepository(SupportTicket).findOneBy({
    id: ticketId,
    companyId,
  });
  if (!ticket) throw new SupportNotFoundError("Ticket not found");
  return ticket;
}

/** The name a timeline keeps for an actor, resolved when the thing happened. */
async function actorName(actor: SupportActor): Promise<string> {
  if (actor.kind === "customer") return actor.name;
  if (actor.kind === "system") return "Genosyn";
  if (actor.kind === "user") {
    const user = await AppDataSource.getRepository(User).findOneBy({ id: actor.userId });
    return user?.name || user?.email || "A Member";
  }
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: actor.employeeId,
  });
  return employee?.name ?? "An AI Employee";
}

let lastEventAt = 0;

/** Now, to the millisecond, strictly after the last moment this process stamped. */
function monotonicNow(): Date {
  const now = Date.now();
  lastEventAt = now > lastEventAt ? now : lastEventAt + 1;
  return new Date(lastEventAt);
}

/** Append one line to a ticket's timeline. Several in one moment keep their order. */
export async function recordTicketEvent(args: {
  ticket: Pick<SupportTicket, "id" | "companyId">;
  kind: SupportEventKind;
  actor: SupportActor;
  data?: Record<string, unknown>;
}): Promise<void> {
  const actorKind: SupportActorKind = args.actor.kind;
  await AppDataSource.getRepository(SupportEvent).save(
    AppDataSource.getRepository(SupportEvent).create({
      companyId: args.ticket.companyId,
      ticketId: args.ticket.id,
      kind: args.kind,
      actorKind,
      actorUserId: args.actor.kind === "user" ? args.actor.userId : null,
      actorEmployeeId: args.actor.kind === "ai" ? args.actor.employeeId : null,
      actorName: await actorName(args.actor),
      dataJson: JSON.stringify(args.data ?? {}),
      createdAt: monotonicNow(),
    }),
  );
}

/**
 * The audit trail, which is what a Run's Effects read back. Only the company's
 * own actors write it: what a customer did is the ticket's timeline, not History.
 */
export async function auditTicket(
  actor: SupportActor,
  ticket: Pick<SupportTicket, "id" | "companyId" | "number" | "subject">,
  action: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  if (actor.kind === "customer") return;
  await recordAudit({
    companyId: ticket.companyId,
    actorKind: actor.kind === "user" ? "user" : actor.kind === "ai" ? "ai" : "system",
    actorUserId: actor.kind === "user" ? actor.userId : null,
    actorEmployeeId: actor.kind === "ai" ? actor.employeeId : null,
    action: `support_ticket.${action}`,
    targetType: "support_ticket",
    targetId: ticket.id,
    targetLabel: `${ticketReference(ticket.number)} ${ticket.subject}`.slice(0, 200),
    metadata,
  });
}

/**
 * Tell open pages a ticket changed. An update by id carries no company for the
 * change subscriber to read, so every targeted write announces itself here. Only
 * a customer writing wakes a Routine (`SupportMessage` in the registry): a
 * Routine must not fire on the updates its own work makes.
 */
export function announceTicket(ticket: Pick<SupportTicket, "id" | "companyId">): void {
  emitResourceChange(ticket.companyId, "support_ticket", ticket.id, { trigger: false });
}

/** A targeted write, announced. Never saves a stale copy over what changed meanwhile. */
export async function patchTicket(
  ticket: Pick<SupportTicket, "id" | "companyId">,
  fields: Partial<SupportTicket>,
): Promise<void> {
  await AppDataSource.getRepository(SupportTicket).update(
    { id: ticket.id, companyId: ticket.companyId },
    fields as never,
  );
  announceTicket(ticket);
}
