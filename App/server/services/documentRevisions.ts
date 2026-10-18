import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";

/**
 * When an issued invoice or estimate was last edited and when it was last
 * emailed, read back from the audit rows its edits and sends already write.
 * The detail page compares the two to say the customer is holding an older
 * copy, so a correction is never left unsent by accident. Nothing is stored.
 */
export type DocumentRevisionState = {
  /** The latest edit made after the document was issued. */
  revisedAt: Date | null;
  /** The latest email that was actually delivered — by a Member, an AI
   *  Employee, or a recurring schedule. A skipped or failed attempt is not. */
  emailedAt: Date | null;
};

export type RevisableDocument = "invoice" | "estimate";

const DOCUMENT_ACTIONS: Record<RevisableDocument, { revise: string; send: string[] }> = {
  invoice: {
    revise: "finance.invoice.revise",
    send: ["finance.invoice.send", "invoice.email.resend"],
  },
  estimate: {
    revise: "finance.estimate.revise",
    send: ["finance.estimate.send"],
  },
};

/** The audit action an edit to an issued document of this kind records. */
export function reviseAction(kind: RevisableDocument): string {
  return DOCUMENT_ACTIONS[kind].revise;
}

export async function documentRevisionState(
  companyId: string,
  kind: RevisableDocument,
  targetId: string,
): Promise<DocumentRevisionState> {
  const { revise, send } = DOCUMENT_ACTIONS[kind];
  const rows = await AppDataSource.getRepository(AuditEvent).find({
    where: { companyId, targetType: kind, targetId, action: In([revise, ...send]) },
    order: { createdAt: "DESC" },
    select: ["action", "createdAt", "metadataJson"],
    take: 100,
  });
  let revisedAt: Date | null = null;
  let emailedAt: Date | null = null;
  for (const row of rows) {
    if (row.action === revise) revisedAt ??= row.createdAt;
    else if (!emailedAt && wasDelivered(row.metadataJson)) emailedAt = row.createdAt;
    if (revisedAt && emailedAt) break;
  }
  return { revisedAt, emailedAt };
}

/** Member sends record `status`; AI Employee sends record `sendStatus`. */
function wasDelivered(metadataJson: string): boolean {
  try {
    const meta = JSON.parse(metadataJson || "{}") as Record<string, unknown>;
    return (meta.status ?? meta.sendStatus) === "sent";
  } catch {
    return false;
  }
}
