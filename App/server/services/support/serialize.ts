import { In } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import type { SupportArticle } from "../../db/entities/SupportArticle.js";
import type { SupportDraft } from "../../db/entities/SupportDraft.js";
import type { SupportEvent } from "../../db/entities/SupportEvent.js";
import type { SupportMessage } from "../../db/entities/SupportMessage.js";
import type { SupportSavedReply } from "../../db/entities/SupportSavedReply.js";
import type { SupportTicket } from "../../db/entities/SupportTicket.js";
import { User } from "../../db/entities/User.js";
import type { SupportCitation } from "../../../shared/support.js";
import { parseJsonArray, parseJsonObject } from "./access.js";
import { isChatRow } from "./chatVisitors.js";

/** The shapes Support's routes answer with. Never a token, never a mailbox credential. */

export type SupportPeople = {
  users: Map<string, { id: string; name: string; email: string; avatarKey: string | null }>;
  employees: Map<string, { id: string; name: string; slug: string; avatarKey: string | null }>;
};

/** The Members and AI Employees a batch of rows names, read once for the whole page. */
export async function peopleFor(
  tickets: Array<Pick<SupportTicket, "assigneeUserId" | "assigneeEmployeeId">>,
  extra: {
    messages?: Array<Pick<SupportMessage, "authorUserId" | "authorEmployeeId">>;
    drafts?: Array<Pick<SupportDraft, "employeeId" | "decidedByUserId">>;
  } = {},
): Promise<SupportPeople> {
  const userIds = new Set<string>();
  const employeeIds = new Set<string>();
  for (const ticket of tickets) {
    if (ticket.assigneeUserId) userIds.add(ticket.assigneeUserId);
    if (ticket.assigneeEmployeeId) employeeIds.add(ticket.assigneeEmployeeId);
  }
  for (const message of extra.messages ?? []) {
    if (message.authorUserId) userIds.add(message.authorUserId);
    if (message.authorEmployeeId) employeeIds.add(message.authorEmployeeId);
  }
  for (const draft of extra.drafts ?? []) {
    if (draft.employeeId) employeeIds.add(draft.employeeId);
    if (draft.decidedByUserId) userIds.add(draft.decidedByUserId);
  }
  const [users, employees] = await Promise.all([
    userIds.size
      ? AppDataSource.getRepository(User).find({ where: { id: In([...userIds]) } })
      : Promise.resolve([]),
    employeeIds.size
      ? AppDataSource.getRepository(AIEmployee).find({ where: { id: In([...employeeIds]) } })
      : Promise.resolve([]),
  ]);
  return {
    users: new Map(
      users.map((user) => [
        user.id,
        {
          id: user.id,
          name: user.name || user.email,
          email: user.email,
          avatarKey: user.avatarKey,
        },
      ]),
    ),
    employees: new Map(
      employees.map((employee) => [
        employee.id,
        {
          id: employee.id,
          name: employee.name,
          slug: employee.slug,
          avatarKey: employee.avatarKey,
        },
      ]),
    ),
  };
}

export function serializeTicket(ticket: SupportTicket, people: SupportPeople) {
  return {
    id: ticket.id,
    number: ticket.number,
    inboxId: ticket.inboxId,
    subject: ticket.subject,
    status: ticket.status,
    priority: ticket.priority,
    prioritySource: ticket.prioritySource,
    topicKey: ticket.topicKey,
    topicSource: ticket.topicSource,
    tags: parseJsonArray<string>(ticket.tagsJson),
    requesterEmail: ticket.requesterEmail,
    requesterName: ticket.requesterName,
    matchedAddress: ticket.matchedAddress,
    cc: parseJsonArray<string>(ticket.ccJson),
    customerId: ticket.customerId,
    contactId: ticket.contactId,
    assigneeUser: ticket.assigneeUserId ? (people.users.get(ticket.assigneeUserId) ?? null) : null,
    assigneeEmployee: ticket.assigneeEmployeeId
      ? (people.employees.get(ticket.assigneeEmployeeId) ?? null)
      : null,
    draftReady: ticket.draftReady,
    aiHandled: ticket.aiHandled,
    needsHuman: ticket.needsHuman,
    aiHandoffReason: ticket.aiHandoffReason,
    aiReplyCount: ticket.aiReplyCount,
    sentiment: ticket.sentiment,
    language: ticket.language,
    aiSummary: ticket.aiSummary,
    aiNextStep: ticket.aiNextStep,
    spamReason: ticket.spamReason,
    messageCount: ticket.messageCount,
    reopenCount: ticket.reopenCount,
    source: ticket.source,
    mergedIntoId: ticket.mergedIntoId,
    lastActivityAt: ticket.lastActivityAt.toISOString(),
    lastCustomerMessageAt: ticket.lastCustomerMessageAt?.toISOString() ?? null,
    lastAgentMessageAt: ticket.lastAgentMessageAt?.toISOString() ?? null,
    firstResponseDueAt: ticket.firstResponseDueAt?.toISOString() ?? null,
    firstRespondedAt: ticket.firstRespondedAt?.toISOString() ?? null,
    responseDueAt: ticket.responseDueAt?.toISOString() ?? null,
    resolutionDueAt: ticket.resolutionDueAt?.toISOString() ?? null,
    slaDueAt: ticket.slaDueAt?.toISOString() ?? null,
    slaBreachedAt: ticket.slaBreachedAt?.toISOString() ?? null,
    solvedAt: ticket.solvedAt?.toISOString() ?? null,
    snoozedUntil: ticket.snoozedUntil?.toISOString() ?? null,
    ratingScore: ticket.ratingScore,
    ratingComment: ticket.ratingComment,
    ratingAt: ticket.ratingAt?.toISOString() ?? null,
    ratingRequestedAt: ticket.ratingRequestedAt?.toISOString() ?? null,
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
  };
}

export type SupportAttachmentMeta = { filename: string; mimeType: string; size: number };

export function attachmentsOf(json: string): SupportAttachmentMeta[] {
  return parseJsonArray<Partial<SupportAttachmentMeta>>(json).map((attachment) => ({
    filename: typeof attachment.filename === "string" ? attachment.filename : "attachment",
    mimeType: typeof attachment.mimeType === "string" ? attachment.mimeType : "",
    size: typeof attachment.size === "number" ? attachment.size : 0,
  }));
}

export function serializeMessage(message: SupportMessage, people: SupportPeople) {
  return {
    id: message.id,
    ticketId: message.ticketId,
    kind: message.kind,
    fromName: message.fromName,
    fromEmail: message.fromEmail,
    toEmails: message.toEmails,
    ccEmails: message.ccEmails,
    subject: message.subject,
    authorUser: message.authorUserId ? (people.users.get(message.authorUserId) ?? null) : null,
    authorEmployee: message.authorEmployeeId
      ? (people.employees.get(message.authorEmployeeId) ?? null)
      : null,
    sentByAi: message.sentByAi,
    draftId: message.draftId,
    viaChat: isChatRow(message),
    sentAt: message.sentAt.toISOString(),
    bodyText: message.bodyText,
    bodyHtml: message.bodyHtml,
    cleanText: message.cleanText,
    attachments: attachmentsOf(message.attachmentsJson),
    citations: parseJsonArray<SupportCitation>(message.citationsJson),
  };
}

export function serializeDraft(draft: SupportDraft, people: SupportPeople) {
  return {
    id: draft.id,
    ticketId: draft.ticketId,
    status: draft.status,
    employee: draft.employeeId ? (people.employees.get(draft.employeeId) ?? null) : null,
    basedOnMessageId: draft.basedOnMessageId,
    answerable: draft.answerable,
    confidence: draft.confidence,
    injectionDetected: draft.injectionDetected,
    editedBeforeSend: draft.editedBeforeSend,
    body: draft.body,
    translation: draft.translation,
    citations: parseJsonArray<SupportCitation>(draft.citationsJson),
    note: draft.note,
    holdReasons: parseJsonArray<string>(draft.holdReasonsJson),
    gapQuestion: draft.gapQuestion,
    decidedBy: draft.decidedByUserId ? (people.users.get(draft.decidedByUserId) ?? null) : null,
    decidedAt: draft.decidedAt?.toISOString() ?? null,
    createdAt: draft.createdAt.toISOString(),
  };
}

export function serializeEvent(event: SupportEvent) {
  return {
    id: event.id,
    kind: event.kind,
    actorKind: event.actorKind,
    actorName: event.actorName,
    createdAt: event.createdAt.toISOString(),
    data: parseJsonObject<Record<string, unknown>>(event.dataJson) ?? {},
  };
}

export function serializeArticle(article: SupportArticle, options: { body?: boolean } = {}) {
  return {
    id: article.id,
    title: article.title,
    status: article.status,
    topicKey: article.topicKey,
    sourceTicketId: article.sourceTicketId,
    createdByEmployeeId: article.createdByEmployeeId,
    createdByUserId: article.createdByUserId,
    citedCount: article.citedCount,
    lastCitedAt: article.lastCitedAt?.toISOString() ?? null,
    publishedAt: article.publishedAt?.toISOString() ?? null,
    createdAt: article.createdAt.toISOString(),
    updatedAt: article.updatedAt.toISOString(),
    ...(options.body === false ? {} : { body: article.body }),
  };
}

export function serializeSavedReply(reply: SupportSavedReply) {
  return {
    id: reply.id,
    name: reply.name,
    body: reply.body,
    usageCount: reply.usageCount,
    createdAt: reply.createdAt.toISOString(),
    updatedAt: reply.updatedAt.toISOString(),
  };
}
