import { In } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { AuditEvent } from "../../db/entities/AuditEvent.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailHandover } from "../../db/entities/MailHandover.js";
import { MailInboundAnalysis } from "../../db/entities/MailInboundAnalysis.js";
import { MailInboundAutomation } from "../../db/entities/MailInboundAutomation.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { columnHasLabel } from "./store.js";

export type MailReviewEmployee = Pick<AIEmployee, "id" | "name" | "slug" | "avatarKey">;
export type MailReviewStatus =
  | "not_reviewed"
  | "queued"
  | "reviewing"
  | "reviewed"
  | "needs_attention";
export type MailReviewSummary = {
  status: MailReviewStatus;
  latestMessageId: string | null;
  employee: MailReviewEmployee | null;
  updatedAt: string | null;
};

export function isInboundReviewMessage(message: MailMessage, account: MailAccount): boolean {
  return (
    message.companyId === account.companyId &&
    message.accountId === account.id &&
    !message.gmailDraftId &&
    !columnHasLabel(message.labelIds, "DRAFT") &&
    !columnHasLabel(message.labelIds, "SENT") &&
    !message.createdByEmployeeId &&
    !message.createdByUserId &&
    message.fromEmail.trim().toLowerCase() !== account.address.trim().toLowerCase()
  );
}

export function mailReviewEmployee(employee: AIEmployee): MailReviewEmployee {
  return {
    id: employee.id,
    name: employee.name,
    slug: employee.slug,
    avatarKey: employee.avatarKey,
  };
}

/** A successful queue item says rules ran, not that an AI Employee read mail. */
export function summarizeMailReview(args: {
  account: MailAccount;
  message: MailMessage | null;
  analyses: MailInboundAnalysis[];
  handovers: MailHandover[];
  automation?: MailInboundAutomation;
  employees: Map<string, AIEmployee>;
  handoverMessages?: Map<string, string | null>;
}): MailReviewSummary {
  const { account, message, employees } = args;
  const empty: MailReviewSummary = {
    status: "not_reviewed",
    latestMessageId: message?.id ?? null,
    employee: null,
    updatedAt: null,
  };
  if (!message || !isInboundReviewMessage(message, account)) return empty;
  const candidates: Array<{ status: MailReviewStatus; at: Date; employeeId: string | null }> = [];
  for (const analysis of args.analyses) {
    if (
      analysis.companyId !== account.companyId ||
      analysis.accountId !== account.id ||
      analysis.threadId !== message.threadId ||
      analysis.messageId !== message.id
    )
      continue;
    candidates.push({
      status:
        analysis.status === "running"
          ? "reviewing"
          : analysis.status === "succeeded"
            ? "reviewed"
            : "needs_attention",
      at:
        analysis.status === "running"
          ? analysis.updatedAt
          : (analysis.finishedAt ?? analysis.updatedAt),
      employeeId: analysis.employeeId,
    });
  }
  for (const handover of args.handovers) {
    if (
      handover.companyId !== account.companyId ||
      handover.accountId !== account.id ||
      handover.threadId !== message.threadId
    )
      continue;
    // A reply that arrived while this turn was running was not in its brief.
    // Use server ingestion time, never the sender-controlled Date header.
    const readAt = handover.startedAt ?? handover.createdAt;
    if (handover.status !== "pending") {
      if (args.handoverMessages?.has(handover.id)) {
        if (args.handoverMessages.get(handover.id) !== message.id) continue;
      } else {
        // Legacy message timestamps have only whole-second precision. A turn
        // starting inside that same second may predate the email's actual
        // arrival, so only the next full second is unambiguous without a snapshot.
        const observedSecondEnd = Math.floor(message.createdAt.getTime() / 1_000) * 1_000 + 1_000;
        if (readAt.getTime() < observedSecondEnd) continue;
      }
    }
    if (handover.status === "completed" && !handover.startedAt) continue;
    candidates.push({
      status:
        handover.status === "pending"
          ? "queued"
          : handover.status === "running"
            ? "reviewing"
            : handover.status === "completed"
              ? "reviewed"
              : "needs_attention",
      at: handover.finishedAt ?? handover.startedAt ?? handover.createdAt,
      employeeId: handover.employeeId,
    });
  }
  const priority = (status: MailReviewStatus) =>
    status === "reviewing" ? 2 : status === "queued" ? 1 : 0;
  candidates.sort(
    (a, b) => priority(b.status) - priority(a.status) || b.at.getTime() - a.at.getTime(),
  );
  const candidate = candidates[0];
  if (candidate) {
    const employee = candidate.employeeId ? employees.get(candidate.employeeId) : null;
    return {
      ...empty,
      status: candidate.status,
      updatedAt: candidate.at.toISOString(),
      employee: employee?.companyId === account.companyId ? mailReviewEmployee(employee) : null,
    };
  }
  const automation = args.automation;
  if (
    account.aiAnalysisEnabled &&
    automation?.companyId === account.companyId &&
    automation.accountId === account.id &&
    automation.messageId === message.id &&
    (automation.status === "queued" || automation.status === "running")
  ) {
    return { ...empty, status: "queued", updatedAt: automation.createdAt.toISOString() };
  }
  return empty;
}

/** A bounded page of threads uses a fixed number of queries, with no message bodies. */
export async function mailReviewsForThreads(
  account: MailAccount,
  threads: MailThread[],
): Promise<Map<string, MailReviewSummary>> {
  const ids = threads
    .filter((thread) => thread.companyId === account.companyId && thread.accountId === account.id)
    .map((thread) => thread.id);
  if (!ids.length) return new Map();
  const inbound = (alias: string) =>
    `${alias}.gmailDraftId = '' AND ${alias}.labelIds NOT LIKE :draft AND ${alias}.labelIds NOT LIKE :sent AND ${alias}.createdByEmployeeId IS NULL AND ${alias}.createdByUserId IS NULL AND LOWER(TRIM(${alias}.fromEmail)) <> :address`;
  const repo = AppDataSource.getRepository(MailMessage);
  const newer = repo
    .createQueryBuilder("newer")
    .select("1")
    .where(
      "newer.companyId = m.companyId AND newer.accountId = m.accountId AND newer.threadId = m.threadId",
    )
    .andWhere(inbound("newer"))
    .andWhere(
      "(newer.createdAt > m.createdAt OR (newer.createdAt = m.createdAt AND (COALESCE(newer.sentAt, newer.createdAt) > COALESCE(m.sentAt, m.createdAt) OR (COALESCE(newer.sentAt, newer.createdAt) = COALESCE(m.sentAt, m.createdAt) AND newer.id > m.id))))",
    );
  const messages = await repo
    .createQueryBuilder("m")
    .select([
      "m.id",
      "m.companyId",
      "m.accountId",
      "m.threadId",
      "m.sentAt",
      "m.createdAt",
      "m.gmailDraftId",
      "m.labelIds",
      "m.fromEmail",
      "m.createdByEmployeeId",
      "m.createdByUserId",
    ])
    .where("m.companyId = :companyId AND m.accountId = :accountId AND m.threadId IN (:...ids)", {
      companyId: account.companyId,
      accountId: account.id,
      ids,
    })
    .andWhere(inbound("m"), {
      draft: "% DRAFT %",
      sent: "% SENT %",
      address: account.address.trim().toLowerCase(),
    })
    .andWhere(`NOT EXISTS (${newer.getQuery()})`)
    .getMany();
  const messageIds = messages.map((message) => message.id);
  const scope = { companyId: account.companyId, accountId: account.id };
  const [analyses, handovers, automations] = await Promise.all([
    messageIds.length
      ? AppDataSource.getRepository(MailInboundAnalysis).find({
          where: { ...scope, messageId: In(messageIds) },
          select: [
            "id",
            "companyId",
            "accountId",
            "threadId",
            "messageId",
            "status",
            "employeeId",
            "createdAt",
            "updatedAt",
            "finishedAt",
          ],
        })
      : [],
    AppDataSource.getRepository(MailHandover).find({
      where: { ...scope, threadId: In(ids) },
      select: [
        "id",
        "companyId",
        "accountId",
        "threadId",
        "employeeId",
        "status",
        "createdAt",
        "startedAt",
        "finishedAt",
      ],
    }),
    messageIds.length
      ? AppDataSource.getRepository(MailInboundAutomation).find({
          where: { ...scope, messageId: In(messageIds) },
          select: ["id", "companyId", "accountId", "messageId", "status", "createdAt"],
        })
      : [],
  ]);
  const handoverStarts = handovers.length
    ? await AppDataSource.getRepository(AuditEvent).find({
        where: {
          companyId: account.companyId,
          action: "mail.handover.started",
          targetType: "mail_handover",
          targetId: In(handovers.map((handover) => handover.id)),
        },
        order: { createdAt: "DESC", id: "DESC" },
        select: ["targetId", "metadataJson", "actorEmployeeId"],
      })
    : [];
  const handoverMessages = new Map<string, string | null>();
  for (const start of handoverStarts) {
    if (!start.targetId || handoverMessages.has(start.targetId)) continue;
    try {
      const metadata = JSON.parse(start.metadataJson);
      const handover = handovers.find((row) => row.id === start.targetId);
      if (
        start.actorEmployeeId !== handover?.employeeId ||
        metadata.mailThreadId !== handover?.threadId ||
        metadata.mailHandoverId !== start.targetId
      )
        continue;
      if (
        metadata.latestInboundMessageId === null ||
        typeof metadata.latestInboundMessageId === "string"
      )
        handoverMessages.set(start.targetId, metadata.latestInboundMessageId);
    } catch {
      /* Legacy rows without structured provenance use the conservative timestamp fallback. */
    }
  }
  const employeeIds = [
    ...new Set(
      [...analyses.map((row) => row.employeeId), ...handovers.map((row) => row.employeeId)].filter(
        (id): id is string => !!id,
      ),
    ),
  ];
  const employeeRows = employeeIds.length
    ? await AppDataSource.getRepository(AIEmployee).find({
        where: { companyId: account.companyId, id: In(employeeIds) },
        select: ["id", "companyId", "name", "slug", "avatarKey"],
      })
    : [];
  const employees = new Map(employeeRows.map((employee) => [employee.id, employee]));
  const byThread = new Map(messages.map((message) => [message.threadId, message]));
  const automationByMessage = new Map(
    automations.map((automation) => [automation.messageId, automation]),
  );
  return new Map(
    ids.map((id) => {
      const message = byThread.get(id) ?? null;
      return [
        id,
        summarizeMailReview({
          account,
          message,
          analyses,
          handovers,
          automation: message ? automationByMessage.get(message.id) : undefined,
          employees,
          handoverMessages,
        }),
      ];
    }),
  );
}
