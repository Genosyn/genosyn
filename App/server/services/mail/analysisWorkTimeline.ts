import { In } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import type { AuditEvent } from "../../db/entities/AuditEvent.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailInboundAnalysis } from "../../db/entities/MailInboundAnalysis.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailThread } from "../../db/entities/MailThread.js";
import type { WorkEntrySource } from "../employeeWorkTimeline.js";
import {
  analysisAttemptSnapshot,
  analysisDetailsFromSnapshot,
  analysisMetadata,
  analysisPreview,
  emptyAnalysisDetails,
  mailAnalysisPhase,
  type MailAnalysisWorkDetails,
} from "./analysisEvidence.js";

type AnalysisEntryContext = {
  subject: string;
  source: WorkEntrySource | null;
  analysis: MailAnalysisWorkDetails;
};

/**
 * Resolve only the mail rows behind this bounded timeline slice. The Email
 * routes allow every company Member to read its mailboxes; the same complete
 * company/account/thread/message chain must exist before exposing a header,
 * saved verdict, or source link here. Deleted or mismatched sources retain
 * only the generic explanation of the event, never the audit's raw label.
 */
export async function mailAnalysisWorkTimeline(
  companyId: string,
  auditRows: AuditEvent[],
): Promise<Map<string, AnalysisEntryContext>> {
  const events = auditRows.filter(
    (row) =>
      row.companyId === companyId &&
      row.targetType === "mail_inbound_analysis" &&
      mailAnalysisPhase(row.action),
  );
  const contexts = new Map<string, AnalysisEntryContext>();
  for (const row of events) {
    contexts.set(row.id, {
      subject: "",
      source: null,
      analysis: emptyAnalysisDetails(mailAnalysisPhase(row.action)!),
    });
  }
  const ids = [...new Set(events.flatMap((row) => (row.targetId ? [row.targetId] : [])))];
  if (!ids.length) return contexts;
  const analyses = await AppDataSource.getRepository(MailInboundAnalysis).find({
    where: { companyId, id: In(ids) },
  });
  if (!analyses.length) return contexts;
  const analysisById = new Map(analyses.map((row) => [row.id, row]));
  const [messages, threads, accounts] = await Promise.all([
    AppDataSource.getRepository(MailMessage).find({
      where: { companyId, id: In([...new Set(analyses.map((row) => row.messageId))]) },
      select: ["id", "accountId", "threadId", "subject", "fromName", "fromEmail"],
    }),
    AppDataSource.getRepository(MailThread).find({
      where: { companyId, id: In([...new Set(analyses.map((row) => row.threadId))]) },
      select: ["id", "accountId"],
    }),
    AppDataSource.getRepository(MailAccount).find({
      where: { companyId, id: In([...new Set(analyses.map((row) => row.accountId))]) },
      select: ["id", "address"],
    }),
  ]);
  const messageById = new Map(messages.map((row) => [row.id, row]));
  const threadById = new Map(threads.map((row) => [row.id, row]));
  const accountById = new Map(accounts.map((row) => [row.id, row]));
  const usedLegacyResults = new Set<string>();
  // A legacy current-row fallback belongs only to the first matching terminal
  // event after that row's final write. Earlier attempts cannot borrow it, even
  // when a re-read finishes with the same employee and status milliseconds later.
  const chronological = [...events].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
  for (const event of chronological) {
    const row = event.targetId ? analysisById.get(event.targetId) : undefined;
    if (!row) continue;
    const message = messageById.get(row.messageId);
    const thread = threadById.get(row.threadId);
    const account = accountById.get(row.accountId);
    if (
      !message ||
      !thread ||
      !account ||
      message.accountId !== account.id ||
      message.threadId !== thread.id ||
      thread.accountId !== account.id
    )
      continue;
    const metadata = analysisMetadata(event.metadataJson);
    if (
      metadata.messageId !== row.messageId ||
      metadata.mailThreadId !== row.threadId ||
      (metadata.accountId !== undefined && metadata.accountId !== row.accountId)
    )
      continue;

    const context = contexts.get(event.id)!;
    context.subject = analysisPreview(message.subject, 300) || "Email without a subject";
    const fromName = analysisPreview(message.fromName, 100);
    const fromEmail = analysisPreview(message.fromEmail, 254);
    const sender = fromName && fromEmail ? `${fromName} <${fromEmail}>` : fromName || fromEmail;
    context.source = {
      kind: "mail_thread",
      id: thread.id,
      accountId: account.id,
      label: sender ? `Email from ${sender}` : "Incoming email",
      detail: [analysisPreview(account.address, 254), "Incoming email analysis"]
        .filter(Boolean)
        .join(" · "),
    };
    const status = context.analysis.status;
    if (metadata.analysisSnapshot !== undefined) {
      context.analysis = analysisDetailsFromSnapshot(status, metadata.analysisSnapshot);
      continue;
    }
    if (
      status === "started" ||
      usedLegacyResults.has(row.id) ||
      row.employeeId !== event.actorEmployeeId ||
      row.status !== (status === "completed" ? "succeeded" : "failed") ||
      !row.finishedAt ||
      row.finishedAt >= event.createdAt ||
      row.updatedAt >= event.createdAt
    )
      continue;
    // No duration can be recovered safely from a row whose createdAt belongs
    // to the first read, so keep it unknown even when the latest result fits.
    const snapshot = analysisAttemptSnapshot(row, status, row.finishedAt);
    snapshot.durationMs = null;
    context.analysis = analysisDetailsFromSnapshot(status, snapshot);
    usedLegacyResults.add(row.id);
  }
  return contexts;
}
