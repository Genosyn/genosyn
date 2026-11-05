import { AppDataSource } from "../../db/datasource.js";
import { SupportInbox } from "../../db/entities/SupportInbox.js";
import type { SupportTicket } from "../../db/entities/SupportTicket.js";
import { enqueueSupportJob } from "./queue.js";

/**
 * Ask for a ticket to be worked. Off an inbox set to `off`, nothing is asked for
 * unless a Member presses the button themselves, in which case they get a draft
 * for review and nothing goes out on its own.
 */
export async function queueTicketWork(
  ticket: Pick<SupportTicket, "id" | "companyId" | "inboxId" | "status" | "mergedIntoId">,
  options: { requestedByUserId?: string | null; delayMs?: number } = {},
): Promise<boolean> {
  if (ticket.status === "spam" || ticket.mergedIntoId) return false;
  if (!options.requestedByUserId) {
    const inbox = ticket.inboxId
      ? await AppDataSource.getRepository(SupportInbox).findOneBy({ id: ticket.inboxId })
      : null;
    if (!inbox || inbox.status !== "active" || inbox.aiMode === "off") return false;
  }
  await enqueueSupportJob({
    companyId: ticket.companyId,
    kind: "work",
    targetId: ticket.id,
    ticketId: ticket.id,
    delayMs: options.delayMs,
    requestedByUserId: options.requestedByUserId ?? null,
  });
  return true;
}
