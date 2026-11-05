import { type NextFunction, type Request, type Response, Router } from "express";
import { z } from "zod";

import {
  SUPPORT_ACCESS_LEVELS,
  SUPPORT_AI_MODES,
  SUPPORT_ARTICLE_STATUSES,
  SUPPORT_LIMITS,
  SUPPORT_MAX_IMPORT_DAYS,
  SUPPORT_PRIORITIES,
  SUPPORT_SETTABLE_STATUSES,
  SUPPORT_SORTS,
  SUPPORT_TICKET_SOURCES,
  SUPPORT_TICKET_STATUSES,
  SUPPORT_VIEWS,
} from "../../shared/support.js";
import {
  SUPPORT_CHAT_LIMITS,
  SUPPORT_CHAT_MAX_AI_TURNS_PER_DAY,
  SUPPORT_CHAT_MAX_MESSAGES_PER_HOUR,
} from "../../shared/supportChat.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { MailMessage } from "../db/entities/MailMessage.js";
import { MailThread } from "../db/entities/MailThread.js";
import { SupportMessage } from "../db/entities/SupportMessage.js";
import {
  onRoutePaths,
  requireAuth,
  requireBrowserSession,
  requireCompanyMember,
  requireCompanyRoleForMutations,
} from "../middleware/auth.js";
import { validateBody, validateParams, validateQuery } from "../middleware/validate.js";
import { ListQueryError, pageQueryShape } from "../services/listPaging.js";
import { MailAttachmentError, fetchMailAttachmentBytes } from "../services/mail/attachments.js";
import { createMailHandover, handoverGrantError } from "../services/mail/handovers.js";
import { type SupportActor, recordTicketEvent, requireTicket } from "../services/support/access.js";
import { SUPPORT_ASSIST_ACTIONS, assistReply } from "../services/support/ai.js";
import { supportAnalytics } from "../services/support/analytics.js";
import { chatAiTurnsUsed } from "../services/support/chatThrottle.js";
import { saveChatWidget, serializeChatWidget } from "../services/support/chatWidgets.js";
import {
  isSupportError,
  SupportConflictError,
  SupportNotFoundError,
} from "../services/support/errors.js";
import {
  deleteSupportGrant,
  listSupportGrants,
  upsertSupportGrant,
} from "../services/support/grants.js";
import {
  createInbox,
  deleteInbox,
  inboxWithWidget,
  listInboxes,
  requestInboxImport,
  requireInbox,
  updateInbox,
} from "../services/support/inboxes.js";
import {
  createArticle,
  deleteArticle,
  knowledgeGaps,
  listArticles,
  requireArticle,
  updateArticle,
} from "../services/support/knowledge.js";
import { enqueueSupportJob } from "../services/support/queue.js";
import {
  addTicketNote,
  discardDraft,
  sendDraft,
  sendTicketReply,
  startTicket,
} from "../services/support/replies.js";
import {
  createSavedReply,
  deleteSavedReply,
  listSavedReplies,
  markSavedReplyUsed,
  updateSavedReply,
} from "../services/support/savedReplies.js";
import {
  peopleFor,
  serializeArticle,
  serializeMessage,
  serializeSavedReply,
  serializeTicket,
} from "../services/support/serialize.js";
import {
  businessHoursSchema,
  getSupportSettings,
  serializeSupportSettings,
  slaTargetsSchema,
  updateSupportSettings,
} from "../services/support/settings.js";
import { helpCenterUrl } from "../services/support/helpCenter.js";
import {
  bulkUpdateTickets,
  listTickets,
  mergeTickets,
  ticketCounts,
  ticketDetail,
  updateTicket,
  type TicketPatch,
} from "../services/support/tickets.js";
import { queueTicketWork } from "../services/support/work.js";

/**
 * Support, the company's side. Mounted at `/api/companies/:cid`.
 *
 * Tickets, Articles and saved replies are every Member's: reading a ticket shows
 * nothing a Member could not already open in the Email section, since there are no
 * per-mailbox rules for people. What decides how the company speaks to customers —
 * Support inboxes, the AI Employee, how far it goes on its own, topics and targets,
 * and AI access — is owners' and admins'. Business rules live in
 * `services/support/`; this module authenticates, validates and shapes responses.
 */
export const supportRouter = Router({ mergeParams: true });

supportRouter.use(requireAuth);
supportRouter.use(requireCompanyMember);
supportRouter.use(
  onRoutePaths(
    ["/support/settings", "/support/inboxes", "/support/ai-access"],
    requireCompanyRoleForMutations("admin"),
  ),
);

const uuid = z.string().uuid();
const companyParams = z.object({ cid: uuid }).strict();
const ticketParams = z.object({ cid: uuid, ticketId: uuid }).strict();
const draftParams = z.object({ cid: uuid, ticketId: uuid, draftId: uuid }).strict();
const inboxParams = z.object({ cid: uuid, inboxId: uuid }).strict();
const articleParams = z.object({ cid: uuid, articleId: uuid }).strict();
const savedReplyParams = z.object({ cid: uuid, savedReplyId: uuid }).strict();
const employeeParams = z.object({ cid: uuid, employeeId: uuid }).strict();
const attachmentParams = z
  .object({ cid: uuid, ticketId: uuid, messageId: uuid, index: z.coerce.number().int().min(0) })
  .strict();
const emptyBody = z.object({}).strict().default({});
const isoDateTime = z.string().datetime({ offset: true });
const addressList = z.array(z.string().trim().max(SUPPORT_LIMITS.addressChars)).max(50);

function cid(req: Request): string {
  return (req.params as Record<string, string>).cid;
}

function param(req: Request, name: string): string {
  return (req.params as Record<string, string>)[name];
}

function actor(req: Request): SupportActor {
  return { kind: "user", userId: req.userId! };
}

function route(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch((error: unknown) => {
      if (isSupportError(error)) {
        const code = error instanceof SupportConflictError ? { code: error.code } : {};
        res.status(error.status).json({ error: error.message, ...code });
        return;
      }
      if (error instanceof ListQueryError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      next(error);
    });
  };
}

// ── Queues ──────────────────────────────────────────────────────────────────

const listTicketsQuery = z
  .object({
    view: z.enum(SUPPORT_VIEWS).optional(),
    status: z.enum(SUPPORT_TICKET_STATUSES).optional(),
    priority: z.enum(SUPPORT_PRIORITIES).optional(),
    topicKey: z.string().max(64).optional(),
    inboxId: uuid.optional(),
    assigneeUserId: uuid.optional(),
    assigneeEmployeeId: uuid.optional(),
    requesterEmail: z.string().max(SUPPORT_LIMITS.addressChars).optional(),
    customerId: uuid.optional(),
    source: z.enum(SUPPORT_TICKET_SOURCES).optional(),
    tag: z.string().max(SUPPORT_LIMITS.tagChars).optional(),
    q: z.string().max(200).optional(),
    sort: z.enum(SUPPORT_SORTS).optional(),
    ...pageQueryShape,
  })
  .strict();

supportRouter.get(
  "/support/tickets",
  validateParams(companyParams),
  validateQuery(listTicketsQuery),
  route(async (req, res) => {
    const { limit, cursor, ...filters } = req.query as unknown as z.infer<typeof listTicketsQuery>;
    res.json(
      await listTickets({
        companyId: cid(req),
        viewerUserId: req.userId ?? null,
        filters,
        page: { limit, cursor },
      }),
    );
  }),
);

supportRouter.get(
  "/support/counts",
  validateParams(companyParams),
  route(async (req, res) => {
    res.json({ counts: await ticketCounts(cid(req), req.userId!) });
  }),
);

// ── One ticket ──────────────────────────────────────────────────────────────

const startTicketBody = z
  .object({
    inboxId: uuid,
    requesterEmail: z.string().trim().min(3).max(SUPPORT_LIMITS.addressChars),
    requesterName: z.string().trim().max(SUPPORT_LIMITS.nameChars).optional(),
    subject: z.string().trim().min(1).max(SUPPORT_LIMITS.subjectChars),
    body: z.string().trim().min(1).max(SUPPORT_LIMITS.replyChars),
    cc: addressList.optional(),
    send: z.boolean().default(true),
    attachmentIds: z.array(z.string().max(100)).max(20).optional(),
  })
  .strict();

supportRouter.post(
  "/support/tickets",
  validateParams(companyParams),
  validateBody(startTicketBody),
  route(async (req, res) => {
    const body = req.body as z.infer<typeof startTicketBody>;
    const ticket = await startTicket({ ...body, companyId: cid(req), actor: actor(req) });
    res.status(201).json({ ticket: serializeTicket(ticket, await peopleFor([ticket])) });
  }),
);

const ticketPatchShape = {
  status: z.enum(SUPPORT_SETTABLE_STATUSES).optional(),
  snoozedUntil: isoDateTime.nullable().optional(),
  priority: z.enum(SUPPORT_PRIORITIES).optional(),
  topicKey: z.string().max(64).nullable().optional(),
  tags: z
    .array(z.string().max(SUPPORT_LIMITS.tagChars))
    .max(SUPPORT_LIMITS.tagsPerTicket)
    .optional(),
  assigneeUserId: uuid.nullable().optional(),
  assigneeEmployeeId: uuid.nullable().optional(),
  subject: z.string().trim().min(1).max(SUPPORT_LIMITS.subjectChars).optional(),
};
const updateTicketBody = z.object(ticketPatchShape).strict();
const bulkTicketsBody = z
  .object({
    ticketIds: z.array(uuid).min(1).max(SUPPORT_LIMITS.bulkTickets),
    status: ticketPatchShape.status,
    snoozedUntil: ticketPatchShape.snoozedUntil,
    priority: ticketPatchShape.priority,
    topicKey: ticketPatchShape.topicKey,
    assigneeUserId: ticketPatchShape.assigneeUserId,
    assigneeEmployeeId: ticketPatchShape.assigneeEmployeeId,
  })
  .strict();

function patchFrom(body: z.infer<typeof updateTicketBody>): TicketPatch {
  const { snoozedUntil, ...rest } = body;
  return {
    ...rest,
    ...(snoozedUntil !== undefined
      ? { snoozedUntil: snoozedUntil === null ? null : new Date(snoozedUntil) }
      : {}),
  };
}

supportRouter.post(
  "/support/tickets/bulk",
  validateParams(companyParams),
  validateBody(bulkTicketsBody),
  route(async (req, res) => {
    const { ticketIds, ...patch } = req.body as z.infer<typeof bulkTicketsBody>;
    res.json(
      await bulkUpdateTickets({
        companyId: cid(req),
        ticketIds,
        patch: patchFrom(patch),
        actor: actor(req),
      }),
    );
  }),
);

supportRouter.get(
  "/support/tickets/:ticketId",
  validateParams(ticketParams),
  route(async (req, res) => {
    res.json(await ticketDetail(cid(req), param(req, "ticketId")));
  }),
);

supportRouter.patch(
  "/support/tickets/:ticketId",
  validateParams(ticketParams),
  validateBody(updateTicketBody),
  route(async (req, res) => {
    const ticket = await updateTicket({
      companyId: cid(req),
      ticketId: param(req, "ticketId"),
      patch: patchFrom(req.body as z.infer<typeof updateTicketBody>),
      actor: actor(req),
    });
    res.json({ ticket: serializeTicket(ticket, await peopleFor([ticket])) });
  }),
);

const replyBody = z
  .object({
    body: z.string().trim().min(1).max(SUPPORT_LIMITS.replyChars),
    cc: addressList.optional(),
    attachmentIds: z.array(z.string().max(100)).max(20).optional(),
    status: z.enum(SUPPORT_SETTABLE_STATUSES).optional(),
    basedOnMessageId: uuid.nullable().optional(),
    force: z.boolean().optional(),
  })
  .strict();

supportRouter.post(
  "/support/tickets/:ticketId/reply",
  validateParams(ticketParams),
  validateBody(replyBody),
  route(async (req, res) => {
    const body = req.body as z.infer<typeof replyBody>;
    const result = await sendTicketReply({
      ...body,
      companyId: cid(req),
      ticketId: param(req, "ticketId"),
      actor: actor(req),
    });
    const people = await peopleFor([result.ticket], { messages: [result.message] });
    res.status(201).json({
      ticket: serializeTicket(result.ticket, people),
      message: serializeMessage(result.message, people),
    });
  }),
);

const noteBody = z
  .object({ body: z.string().trim().min(1).max(SUPPORT_LIMITS.noteChars) })
  .strict();

supportRouter.post(
  "/support/tickets/:ticketId/notes",
  validateParams(ticketParams),
  validateBody(noteBody),
  route(async (req, res) => {
    const message = await addTicketNote({
      companyId: cid(req),
      ticketId: param(req, "ticketId"),
      body: (req.body as z.infer<typeof noteBody>).body,
      actor: actor(req),
    });
    res.status(201).json({
      message: serializeMessage(message, await peopleFor([], { messages: [message] })),
    });
  }),
);

const mergeBody = z.object({ intoTicketId: uuid }).strict();

supportRouter.post(
  "/support/tickets/:ticketId/merge",
  validateParams(ticketParams),
  validateBody(mergeBody),
  route(async (req, res) => {
    const ticket = await mergeTickets({
      companyId: cid(req),
      sourceId: param(req, "ticketId"),
      targetId: (req.body as z.infer<typeof mergeBody>).intoTicketId,
      actor: actor(req),
    });
    res.json({ ticket: serializeTicket(ticket, await peopleFor([ticket])) });
  }),
);

// ── AI on one ticket ────────────────────────────────────────────────────────

supportRouter.post(
  "/support/tickets/:ticketId/ai/work",
  validateParams(ticketParams),
  validateBody(emptyBody),
  route(async (req, res) => {
    const ticket = await requireTicket(cid(req), param(req, "ticketId"));
    const queued = await queueTicketWork(ticket, { requestedByUserId: req.userId! });
    if (!queued) throw new SupportConflictError("This ticket cannot be worked as it stands.");
    res.status(202).json({ queued: true });
  }),
);

const sendDraftBody = z
  .object({
    body: z.string().trim().min(1).max(SUPPORT_LIMITS.replyChars).optional(),
    cc: addressList.optional(),
    attachmentIds: z.array(z.string().max(100)).max(20).optional(),
    status: z.enum(SUPPORT_SETTABLE_STATUSES).optional(),
    basedOnMessageId: uuid.nullable().optional(),
    force: z.boolean().optional(),
  })
  .strict();

supportRouter.post(
  "/support/tickets/:ticketId/drafts/:draftId/send",
  validateParams(draftParams),
  validateBody(sendDraftBody),
  route(async (req, res) => {
    const result = await sendDraft({
      ...(req.body as z.infer<typeof sendDraftBody>),
      companyId: cid(req),
      ticketId: param(req, "ticketId"),
      draftId: param(req, "draftId"),
      actor: actor(req),
    });
    const people = await peopleFor([result.ticket], { messages: [result.message] });
    res.status(201).json({
      ticket: serializeTicket(result.ticket, people),
      message: serializeMessage(result.message, people),
    });
  }),
);

supportRouter.post(
  "/support/tickets/:ticketId/drafts/:draftId/discard",
  validateParams(draftParams),
  validateBody(emptyBody),
  route(async (req, res) => {
    await discardDraft({
      companyId: cid(req),
      ticketId: param(req, "ticketId"),
      draftId: param(req, "draftId"),
      actor: actor(req),
    });
    res.json({ ok: true });
  }),
);

const assistBody = z
  .object({
    text: z.string().trim().min(1).max(SUPPORT_LIMITS.replyChars),
    action: z.enum(SUPPORT_ASSIST_ACTIONS),
  })
  .strict();

supportRouter.post(
  "/support/tickets/:ticketId/ai/assist",
  validateParams(ticketParams),
  validateBody(assistBody),
  route(async (req, res) => {
    const body = req.body as z.infer<typeof assistBody>;
    res.json({
      text: await assistReply({
        companyId: cid(req),
        ticketId: param(req, "ticketId"),
        text: body.text,
        action: body.action,
      }),
    });
  }),
);

supportRouter.post(
  "/support/tickets/:ticketId/ai/article",
  validateParams(ticketParams),
  validateBody(emptyBody),
  route(async (req, res) => {
    const ticket = await requireTicket(cid(req), param(req, "ticketId"));
    await enqueueSupportJob({
      companyId: ticket.companyId,
      kind: "article",
      targetId: ticket.id,
      ticketId: ticket.id,
      requestedByUserId: req.userId!,
    });
    res.status(202).json({ queued: true });
  }),
);

const handoverBody = z
  .object({
    employeeId: uuid,
    instruction: z.string().trim().max(4_000).default(""),
  })
  .strict();

/**
 * Hand the conversation to an AI Employee with its full Soul, Skills and tools,
 * through the mailbox's ordinary handover. Its reply comes back to the Decision
 * stack for a person, because a turn with tools has read a stranger's email; what
 * goes out then joins the ticket like any other email on its conversation.
 */
supportRouter.post(
  "/support/tickets/:ticketId/handover",
  requireBrowserSession,
  validateParams(ticketParams),
  validateBody(handoverBody),
  route(async (req, res) => {
    const companyId = cid(req);
    const body = req.body as z.infer<typeof handoverBody>;
    const ticket = await requireTicket(companyId, param(req, "ticketId"));
    if (!ticket.accountId || !ticket.gmailThreadId) {
      throw new SupportConflictError("This ticket has no email conversation to hand over yet.");
    }
    const account = await AppDataSource.getRepository(MailAccount).findOneBy({
      id: ticket.accountId,
      companyId,
    });
    const thread = await AppDataSource.getRepository(MailThread).findOneBy({
      accountId: ticket.accountId,
      gmailThreadId: ticket.gmailThreadId,
    });
    if (!account || !thread) {
      throw new SupportConflictError("This conversation is no longer in the mailbox.");
    }
    const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
      id: body.employeeId,
      companyId,
    });
    if (!employee) throw new SupportNotFoundError("AI Employee not found");
    const grantError = await handoverGrantError(employee.id, account.id, "draft");
    if (grantError) throw new SupportConflictError(grantError, "no_grant");
    const handover = await createMailHandover({
      account,
      thread,
      employeeId: employee.id,
      mode: "draft",
      instruction: body.instruction,
      sourceKind: "manual",
      ruleId: null,
      createdByUserId: req.userId!,
      requesterUserId: req.userId!,
      requesterSessionVersion: req.session!.sessionVersion!,
    });
    await recordTicketEvent({
      ticket,
      kind: "handed_over",
      actor: actor(req),
      data: { employeeId: employee.id, employeeName: employee.name, handoverId: handover.id },
    });
    res.status(202).json({ handoverId: handover.id });
  }),
);

// ── Attachments ─────────────────────────────────────────────────────────────

/** The bytes stay on the mail server, as they do for the Email section. */
supportRouter.get(
  "/support/tickets/:ticketId/messages/:messageId/attachments/:index",
  validateParams(attachmentParams),
  route(async (req, res) => {
    const companyId = cid(req);
    const ticket = await requireTicket(companyId, param(req, "ticketId"));
    const message = await AppDataSource.getRepository(SupportMessage).findOneBy({
      id: param(req, "messageId"),
      ticketId: ticket.id,
    });
    if (!message?.accountId || !message.gmailMessageId) {
      throw new SupportNotFoundError("Attachment not found");
    }
    const account = await AppDataSource.getRepository(MailAccount).findOneBy({
      id: message.accountId,
      companyId,
    });
    const mirrored = account
      ? await AppDataSource.getRepository(MailMessage).findOneBy({
          accountId: account.id,
          gmailMessageId: message.gmailMessageId,
        })
      : null;
    if (!account || !mirrored) {
      throw new SupportConflictError(
        "This file is no longer in the mailbox: it was disconnected or the email was deleted.",
        "attachment_gone",
      );
    }
    try {
      const { meta, bytes } = await fetchMailAttachmentBytes(
        account,
        mirrored,
        Number(param(req, "index")),
      );
      // Always a download: a customer chose this file and its type, so it is never
      // rendered in the App's own origin.
      res.attachment(meta.filename.replace(/["\r\n]/g, "") || "attachment");
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(bytes);
    } catch (error) {
      if (error instanceof MailAttachmentError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw new SupportConflictError(
        `This file could not be read from the mailbox: ${(error as Error).message}`,
        "attachment_gone",
      );
    }
  }),
);

// ── Inboxes ─────────────────────────────────────────────────────────────────

const inboxFields = {
  name: z.string().trim().min(1).max(SUPPORT_LIMITS.nameChars),
  addresses: z
    .array(z.string().trim().max(SUPPORT_LIMITS.addressChars))
    .max(SUPPORT_LIMITS.addressesPerInbox),
  fromAddress: z.string().trim().max(SUPPORT_LIMITS.addressChars).optional(),
  fromName: z.string().trim().max(SUPPORT_LIMITS.nameChars).optional(),
  aiMode: z.enum(SUPPORT_AI_MODES).optional(),
  aiEmployeeId: uuid.nullable().optional(),
  aiInstructions: z.string().max(SUPPORT_LIMITS.instructionsChars).optional(),
  signature: z.string().max(SUPPORT_LIMITS.signatureChars).optional(),
  acknowledge: z.boolean().optional(),
  acknowledgementBody: z.string().max(SUPPORT_LIMITS.acknowledgementChars).nullable().optional(),
  archiveOnSolve: z.boolean().optional(),
  autoReplyDailyLimit: z.number().int().min(0).max(10_000).optional(),
};

const createInboxBody = z
  .object({
    accountId: uuid,
    ...inboxFields,
    importDays: z.number().int().min(0).max(SUPPORT_MAX_IMPORT_DAYS).optional(),
  })
  .strict();

const updateInboxBody = z
  .object({
    accountId: uuid.optional(),
    name: inboxFields.name.optional(),
    addresses: inboxFields.addresses.optional(),
    fromAddress: inboxFields.fromAddress,
    fromName: inboxFields.fromName,
    aiMode: inboxFields.aiMode,
    aiEmployeeId: inboxFields.aiEmployeeId,
    aiInstructions: inboxFields.aiInstructions,
    signature: inboxFields.signature,
    acknowledge: inboxFields.acknowledge,
    acknowledgementBody: inboxFields.acknowledgementBody,
    archiveOnSolve: inboxFields.archiveOnSolve,
    autoReplyDailyLimit: inboxFields.autoReplyDailyLimit,
    status: z.enum(["active", "paused"]).optional(),
  })
  .strict();

const importBody = z
  .object({ days: z.number().int().min(1).max(SUPPORT_MAX_IMPORT_DAYS) })
  .strict();

async function inboxView(companyId: string, inboxId: string) {
  return inboxWithWidget(await requireInbox(companyId, inboxId));
}

supportRouter.get(
  "/support/inboxes",
  validateParams(companyParams),
  route(async (req, res) => {
    res.json({ inboxes: await listInboxes(cid(req)) });
  }),
);

supportRouter.post(
  "/support/inboxes",
  validateParams(companyParams),
  validateBody(createInboxBody),
  route(async (req, res) => {
    const inbox = await createInbox({
      companyId: cid(req),
      input: req.body as z.infer<typeof createInboxBody>,
      actor: actor(req),
    });
    res.status(201).json({ inbox: await inboxView(cid(req), inbox.id) });
  }),
);

supportRouter.patch(
  "/support/inboxes/:inboxId",
  validateParams(inboxParams),
  validateBody(updateInboxBody),
  route(async (req, res) => {
    const inbox = await updateInbox({
      companyId: cid(req),
      inboxId: param(req, "inboxId"),
      input: req.body as z.infer<typeof updateInboxBody>,
      actor: actor(req),
    });
    res.json({ inbox: await inboxView(cid(req), inbox.id) });
  }),
);

supportRouter.post(
  "/support/inboxes/:inboxId/import",
  validateParams(inboxParams),
  validateBody(importBody),
  route(async (req, res) => {
    const inbox = await requestInboxImport({
      companyId: cid(req),
      inboxId: param(req, "inboxId"),
      days: (req.body as z.infer<typeof importBody>).days,
      actor: actor(req),
    });
    res.status(202).json({ inbox: await inboxView(cid(req), inbox.id) });
  }),
);

supportRouter.delete(
  "/support/inboxes/:inboxId",
  validateParams(inboxParams),
  route(async (req, res) => {
    await deleteInbox({ companyId: cid(req), inboxId: param(req, "inboxId"), actor: actor(req) });
    res.json({ ok: true });
  }),
);

// ── Chat widget ─────────────────────────────────────────────────────────────

const chatWidgetBody = z
  .object({
    enabled: z.boolean().optional(),
    allowedOrigins: z
      .array(z.string().trim().max(SUPPORT_CHAT_LIMITS.originChars))
      .max(SUPPORT_CHAT_LIMITS.originsPerWidget * 2)
      .optional(),
    title: z.string().max(SUPPORT_CHAT_LIMITS.titleChars).optional(),
    greeting: z.string().max(SUPPORT_CHAT_LIMITS.greetingChars).optional(),
  })
  .strict();

/** Turning a widget on opens a public door, so this sits behind the inbox routes' admin gate. */
supportRouter.put(
  "/support/inboxes/:inboxId/chat-widget",
  validateParams(inboxParams),
  validateBody(chatWidgetBody),
  route(async (req, res) => {
    const inbox = await requireInbox(cid(req), param(req, "inboxId"));
    const widget = await saveChatWidget({
      companyId: cid(req),
      inbox,
      patch: req.body as z.infer<typeof chatWidgetBody>,
      actor: actor(req),
    });
    res.json({ widget: serializeChatWidget(widget) });
  }),
);

// ── Settings ────────────────────────────────────────────────────────────────

const topicInput = z
  .object({
    key: z.string().max(64).optional(),
    name: z.string().trim().min(1).max(SUPPORT_LIMITS.topicNameChars),
    description: z.string().max(SUPPORT_LIMITS.topicDescriptionChars).optional(),
    autoReply: z.boolean().optional(),
    assigneeUserId: uuid.nullable().optional(),
    assigneeEmployeeId: uuid.nullable().optional(),
  })
  .strict();

const settingsBody = z
  .object({
    aiEmployeeId: uuid.nullable().optional(),
    aiInstructions: z.string().max(SUPPORT_LIMITS.instructionsChars).optional(),
    aiDisclosure: z.string().max(SUPPORT_LIMITS.disclosureChars).nullable().optional(),
    workingLanguage: z.string().trim().min(1).max(60).optional(),
    topics: z.array(topicInput).max(SUPPORT_LIMITS.topics).optional(),
    sla: slaTargetsSchema.optional(),
    slaEnabled: z.boolean().optional(),
    businessHours: businessHoursSchema.nullable().optional(),
    ratingsEnabled: z.boolean().optional(),
    helpCenterEnabled: z.boolean().optional(),
    autoCloseDays: z.number().int().min(0).max(365).optional(),
    autoSolveDays: z.number().int().min(0).max(365).optional(),
    chatMessagesPerHour: z.number().int().min(1).max(SUPPORT_CHAT_MAX_MESSAGES_PER_HOUR).optional(),
    chatAiTurnsPerDay: z.number().int().min(0).max(SUPPORT_CHAT_MAX_AI_TURNS_PER_DAY).optional(),
  })
  .strict();

async function settingsView(settings: Awaited<ReturnType<typeof getSupportSettings>>) {
  return {
    ...serializeSupportSettings(settings),
    helpCenterUrl: await helpCenterUrl(settings.companyId),
    chatAiTurnsUsed: await chatAiTurnsUsed(settings),
  };
}

supportRouter.get(
  "/support/settings",
  validateParams(companyParams),
  route(async (req, res) => {
    res.json({ settings: await settingsView(await getSupportSettings(cid(req))) });
  }),
);

supportRouter.patch(
  "/support/settings",
  validateParams(companyParams),
  validateBody(settingsBody),
  route(async (req, res) => {
    const settings = await updateSupportSettings(
      cid(req),
      req.body as z.infer<typeof settingsBody>,
      actor(req),
    );
    res.json({ settings: await settingsView(settings) });
  }),
);

// ── AI access ───────────────────────────────────────────────────────────────

const grantBody = z.object({ accessLevel: z.enum(SUPPORT_ACCESS_LEVELS) }).strict();

supportRouter.get(
  "/support/ai-access",
  validateParams(companyParams),
  route(async (req, res) => {
    res.json({ rows: await listSupportGrants(cid(req)) });
  }),
);

supportRouter.put(
  "/support/ai-access/:employeeId",
  validateParams(employeeParams),
  validateBody(grantBody),
  route(async (req, res) => {
    const grant = await upsertSupportGrant(
      cid(req),
      param(req, "employeeId"),
      (req.body as z.infer<typeof grantBody>).accessLevel,
    );
    res.json({ grant: { id: grant.id, accessLevel: grant.accessLevel } });
  }),
);

supportRouter.delete(
  "/support/ai-access/:employeeId",
  validateParams(employeeParams),
  route(async (req, res) => {
    await deleteSupportGrant(cid(req), param(req, "employeeId"));
    res.json({ ok: true });
  }),
);

// ── Articles ────────────────────────────────────────────────────────────────

const listArticlesQuery = z
  .object({
    status: z.enum(SUPPORT_ARTICLE_STATUSES).optional(),
    topicKey: z.string().max(64).optional(),
    q: z.string().max(200).optional(),
    ...pageQueryShape,
  })
  .strict();

const createArticleBody = z
  .object({
    title: z.string().trim().min(1).max(SUPPORT_LIMITS.articleTitleChars),
    body: z.string().max(SUPPORT_LIMITS.articleBodyChars),
    topicKey: z.string().max(64).nullable().optional(),
    status: z.enum(SUPPORT_ARTICLE_STATUSES).optional(),
    sourceTicketId: uuid.nullable().optional(),
  })
  .strict();

const updateArticleBody = z
  .object({
    title: z.string().trim().min(1).max(SUPPORT_LIMITS.articleTitleChars).optional(),
    body: z.string().max(SUPPORT_LIMITS.articleBodyChars).optional(),
    topicKey: z.string().max(64).nullable().optional(),
    status: z.enum(SUPPORT_ARTICLE_STATUSES).optional(),
  })
  .strict();

const gapsQuery = z.object({ days: z.coerce.number().int().min(1).max(365).optional() }).strict();

supportRouter.get(
  "/support/articles",
  validateParams(companyParams),
  validateQuery(listArticlesQuery),
  route(async (req, res) => {
    const { limit, cursor, ...filters } = req.query as unknown as z.infer<typeof listArticlesQuery>;
    res.json(await listArticles({ companyId: cid(req), ...filters, page: { limit, cursor } }));
  }),
);

supportRouter.post(
  "/support/articles",
  validateParams(companyParams),
  validateBody(createArticleBody),
  route(async (req, res) => {
    const article = await createArticle({
      ...(req.body as z.infer<typeof createArticleBody>),
      companyId: cid(req),
      actor: actor(req),
    });
    res.status(201).json({ article: serializeArticle(article) });
  }),
);

supportRouter.get(
  "/support/knowledge-gaps",
  validateParams(companyParams),
  validateQuery(gapsQuery),
  route(async (req, res) => {
    const days = (req.query as unknown as z.infer<typeof gapsQuery>).days;
    res.json({ gaps: await knowledgeGaps(cid(req), days) });
  }),
);

supportRouter.get(
  "/support/articles/:articleId",
  validateParams(articleParams),
  route(async (req, res) => {
    res.json({
      article: serializeArticle(await requireArticle(cid(req), param(req, "articleId"))),
    });
  }),
);

supportRouter.patch(
  "/support/articles/:articleId",
  validateParams(articleParams),
  validateBody(updateArticleBody),
  route(async (req, res) => {
    const article = await updateArticle({
      companyId: cid(req),
      articleId: param(req, "articleId"),
      patch: req.body as z.infer<typeof updateArticleBody>,
      actor: actor(req),
    });
    res.json({ article: serializeArticle(article) });
  }),
);

supportRouter.delete(
  "/support/articles/:articleId",
  validateParams(articleParams),
  route(async (req, res) => {
    await deleteArticle({
      companyId: cid(req),
      articleId: param(req, "articleId"),
      actor: actor(req),
    });
    res.json({ ok: true });
  }),
);

// ── Saved replies ───────────────────────────────────────────────────────────

const savedReplyBody = z
  .object({
    name: z.string().trim().min(1).max(SUPPORT_LIMITS.savedReplyNameChars),
    body: z.string().min(1).max(SUPPORT_LIMITS.savedReplyBodyChars),
  })
  .strict();

const updateSavedReplyBody = z
  .object({
    name: savedReplyBody.shape.name.optional(),
    body: savedReplyBody.shape.body.optional(),
  })
  .strict();

supportRouter.get(
  "/support/saved-replies",
  validateParams(companyParams),
  route(async (req, res) => {
    res.json({ savedReplies: (await listSavedReplies(cid(req))).map(serializeSavedReply) });
  }),
);

supportRouter.post(
  "/support/saved-replies",
  validateParams(companyParams),
  validateBody(savedReplyBody),
  route(async (req, res) => {
    const body = req.body as z.infer<typeof savedReplyBody>;
    const reply = await createSavedReply({
      ...body,
      companyId: cid(req),
      userId: req.userId ?? null,
    });
    res.status(201).json({ savedReply: serializeSavedReply(reply) });
  }),
);

supportRouter.patch(
  "/support/saved-replies/:savedReplyId",
  validateParams(savedReplyParams),
  validateBody(updateSavedReplyBody),
  route(async (req, res) => {
    const reply = await updateSavedReply({
      ...(req.body as z.infer<typeof updateSavedReplyBody>),
      companyId: cid(req),
      id: param(req, "savedReplyId"),
    });
    res.json({ savedReply: serializeSavedReply(reply) });
  }),
);

supportRouter.post(
  "/support/saved-replies/:savedReplyId/used",
  validateParams(savedReplyParams),
  validateBody(emptyBody),
  route(async (req, res) => {
    await markSavedReplyUsed(cid(req), param(req, "savedReplyId"));
    res.json({ ok: true });
  }),
);

supportRouter.delete(
  "/support/saved-replies/:savedReplyId",
  validateParams(savedReplyParams),
  route(async (req, res) => {
    await deleteSavedReply(cid(req), param(req, "savedReplyId"));
    res.json({ ok: true });
  }),
);

// ── Figures ─────────────────────────────────────────────────────────────────

const analyticsQuery = z
  .object({ days: z.coerce.number().int().min(1).max(365).optional() })
  .strict();

supportRouter.get(
  "/support/analytics",
  validateParams(companyParams),
  validateQuery(analyticsQuery),
  route(async (req, res) => {
    const days = (req.query as unknown as z.infer<typeof analyticsQuery>).days ?? 30;
    res.json(await supportAnalytics(cid(req), days));
  }),
);

supportRouter.post(
  "/support/insights",
  validateParams(companyParams),
  validateBody(emptyBody),
  route(async (req, res) => {
    await enqueueSupportJob({
      companyId: cid(req),
      kind: "insights",
      targetId: cid(req),
      requestedByUserId: req.userId!,
    });
    res.status(202).json({ queued: true });
  }),
);
