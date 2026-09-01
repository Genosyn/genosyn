import { Router, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { MailChatMessage } from "../db/entities/MailChatMessage.js";
import {
  EmployeeMailAccountGrant,
  MAIL_ACCESS_LEVELS,
  type MailAccessLevel,
} from "../db/entities/EmployeeMailAccountGrant.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { MailHandover } from "../db/entities/MailHandover.js";
import { MailLabel } from "../db/entities/MailLabel.js";
import { MailMessage } from "../db/entities/MailMessage.js";
import { MailRule } from "../db/entities/MailRule.js";
import { MailSavedSearch } from "../db/entities/MailSavedSearch.js";
import { MailThread } from "../db/entities/MailThread.js";
import {
  requireAuth,
  requireBrowserSession,
  requireCompanyMember,
  requireCompanyRole,
} from "../middleware/auth.js";
import { effectiveFinanceAccess } from "../middleware/financeAccess.js";
import { validateBody } from "../middleware/validate.js";
import { recordAudit } from "../services/audit.js";
import { decryptConnectionConfig } from "../services/integrations.js";
import { broadcastToCompany } from "../services/realtime.js";
import { createMailAccount, serializeMailAccount } from "../services/mail/accounts.js";
import { connectImapMailbox, describeMailboxConnect } from "../services/mail/connect.js";
import { hasGoogleGmailMailboxScope } from "../integrations/providers/google/auth.js";
import {
  MAX_BULK_THREAD_IDS,
  bulkThreadAction,
  createMailDraft,
  discardMailDraft,
  performThreadAction,
  replyAllRecipients,
  sendMailDraft,
  sendMailMessage,
  updateMailDraft,
  type ThreadAction,
} from "../services/mail/actions.js";
import {
  MAX_BULK_DRAFT_IDS,
  listDrafts,
  previewDraftSend,
  runBulkDraftDiscard,
  type DraftSelection,
} from "../services/mail/drafts.js";
import {
  DraftSendQueueBusyError,
  MAX_QUEUED_DRAFT_IDS,
  createDraftSendBatch,
  getLatestDraftSendBatch,
} from "../services/mail/draftSendQueue.js";
import {
  MailAnalysisAlreadyActed,
  analysesForThread,
  analyzeInboundMessage,
  resolveAnalysisReader,
  serializeAnalysis,
} from "../services/mail/analysis.js";
import { executeAnalysisAction } from "../services/mail/analysisActions.js";
import { MailInboundAnalysis } from "../db/entities/MailInboundAnalysis.js";
import { decodeHtmlEntities } from "../services/mail/gmailClient.js";
import {
  MailAttachmentError,
  fetchMailAttachmentBytes,
  summarizeMailAttachments,
} from "../services/mail/attachments.js";
import { stageAttachment } from "../services/mail/outbox.js";
import { recordAttachment, resolveAttachmentFile, uploadMiddleware } from "../services/uploads.js";
import {
  createMailHandover,
  handoverGrantError,
  retryMailHandover,
} from "../services/mail/handovers.js";
import {
  assistantAttachments,
  assistantRoster,
  clearAssistantMessages,
  lastAssistantModelId,
  listAssistantMessages,
  markSuggestionExecuted,
  runAssistantTurn,
  serializeAssistantMessage,
} from "../services/mail/assistant.js";
import { columnToLabelIds } from "../services/mail/store.js";
import {
  applyMailScope,
  applyMailSearchFilters,
  effectiveScope,
  isEmptyQuery,
  parseMailQuery,
  resolveSearchLabelId,
} from "../services/mail/searchQuery.js";
import {
  disconnectMailAccount,
  MailSyncPausedError,
  queueAccountSync,
} from "../services/mail/sync.js";
import {
  parseActions as parseRuleActions,
  parseConditions as parseRuleConditions,
  validateMailRuleConfiguration,
} from "../services/mail/rules.js";

/**
 * HTTP surface for the Email section (M25): mailbox accounts, the local
 * thread/message mirror, write-through actions, drafts, rules, handovers,
 * and per-employee grants. Mounted at /api/companies/:cid/mail.
 *
 * Route handlers parse + shape only; the mechanics live in services/mail/.
 */

export const mailRouter = Router({ mergeParams: true });
mailRouter.use(requireAuth);
mailRouter.use(requireCompanyMember);

// ───────────────────────────── helpers ─────────────────────────────

async function loadAccount(cid: string, accountId: string): Promise<MailAccount | null> {
  return AppDataSource.getRepository(MailAccount).findOneBy({
    id: accountId,
    companyId: cid,
  });
}

async function loadThread(
  cid: string,
  threadId: string,
): Promise<{ thread: MailThread; account: MailAccount } | null> {
  const thread = await AppDataSource.getRepository(MailThread).findOneBy({
    id: threadId,
    companyId: cid,
  });
  if (!thread) return null;
  const account = await loadAccount(cid, thread.accountId);
  if (!account) return null;
  return { thread, account };
}

function serializeThread(t: MailThread) {
  return {
    id: t.id,
    gmailThreadId: t.gmailThreadId,
    accountId: t.accountId,
    subject: t.subject,
    snippet: decodeHtmlEntities(t.snippet),
    participants: t.participants,
    labelIds: columnToLabelIds(t.labelIds),
    unread: t.unread,
    messageCount: t.messageCount,
    hasAttachments: t.hasAttachments,
    lastMessageAt: t.lastMessageAt ? t.lastMessageAt.toISOString() : null,
  };
}

function serializeMessage(m: MailMessage) {
  return {
    id: m.id,
    threadId: m.threadId,
    gmailMessageId: m.gmailMessageId,
    isDraft: m.gmailDraftId !== "",
    fromName: m.fromName,
    fromEmail: m.fromEmail,
    toEmails: m.toEmails,
    ccEmails: m.ccEmails,
    bccEmails: m.bccEmails,
    subject: m.subject,
    snippet: decodeHtmlEntities(m.snippet),
    bodyText: m.bodyText,
    bodyHtml: m.bodyHtml,
    labelIds: columnToLabelIds(m.labelIds),
    sentAt: m.sentAt ? m.sentAt.toISOString() : null,
    createdAt: m.createdAt ? m.createdAt.toISOString() : null,
    // Raw provenance ids. The Drafts queue resolves these to employee/routine
    // names in one batched pass (see services/mail/drafts.ts); per-message
    // lookups here would be an N+1 on every thread open.
    createdByUserId: m.createdByUserId,
    createdByEmployeeId: m.createdByEmployeeId,
    createdByRoutineId: m.createdByRoutineId,
    createdByRunId: m.createdByRunId,
    attachments: summarizeMailAttachments(m.attachmentsJson),
  };
}

function serializeHandover(
  h: MailHandover,
  employees: Map<string, AIEmployee>,
  threads?: Map<string, MailThread>,
) {
  const emp = employees.get(h.employeeId);
  const thread = threads?.get(h.threadId);
  return {
    id: h.id,
    accountId: h.accountId,
    threadId: h.threadId,
    threadSubject: thread ? thread.subject || "(no subject)" : undefined,
    employee: emp ? { id: emp.id, name: emp.name, slug: emp.slug, avatarKey: emp.avatarKey } : null,
    mode: h.mode,
    instruction: h.instruction,
    status: h.status,
    resultSummary: h.resultSummary,
    errorMessage: h.errorMessage,
    sourceKind: h.sourceKind,
    createdAt: h.createdAt.toISOString(),
    startedAt: h.startedAt ? h.startedAt.toISOString() : null,
    finishedAt: h.finishedAt ? h.finishedAt.toISOString() : null,
  };
}

async function employeesById(ids: string[]): Promise<Map<string, AIEmployee>> {
  if (ids.length === 0) return new Map();
  const rows = await AppDataSource.getRepository(AIEmployee).find({
    where: { id: In(Array.from(new Set(ids))) },
  });
  return new Map(rows.map((e) => [e.id, e]));
}

// ───────────────────────────── accounts ─────────────────────────────

mailRouter.get("/mail/accounts", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const accounts = await AppDataSource.getRepository(MailAccount).find({
    where: { companyId: cid },
    order: { createdAt: "ASC" },
  });
  res.json({ accounts: accounts.map(serializeMailAccount) });
});

/**
 * Which of the company's connections can back a mailbox.
 *
 * A `google` connection qualifies when its granted OAuth scope includes
 * Gmail; an `imap` connection always does, since holding the mailbox
 * credential is the only thing it is for. Connections already linked to a
 * mailbox are flagged rather than hidden so the UI can explain why they are
 * not clickable.
 */
mailRouter.get("/mail/connect-candidates", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const conns = await AppDataSource.getRepository(IntegrationConnection).find({
    where: [
      { companyId: cid, provider: "google" },
      { companyId: cid, provider: "imap" },
    ],
    order: { createdAt: "ASC" },
  });
  const accounts = await AppDataSource.getRepository(MailAccount).find({
    where: { companyId: cid },
  });
  const linkedByConn = new Map(accounts.map((a) => [a.connectionId, a.id]));
  const candidates = conns.map((c) => {
    let hasGmailScope = c.provider === "imap";
    if (c.provider === "google") {
      try {
        const cfg = decryptConnectionConfig(c) as { scope?: string; scopes?: string[] };
        hasGmailScope = hasGoogleGmailMailboxScope(cfg.scope ?? cfg.scopes ?? []);
      } catch {
        hasGmailScope = false;
      }
    }
    return {
      connectionId: c.id,
      provider: c.provider,
      label: c.label,
      accountHint: c.accountHint,
      status: c.status,
      hasGmailScope,
      linkedAccountId: linkedByConn.get(c.id) ?? null,
    };
  });
  res.json({ candidates });
});

const discoverSchema = z.object({ email: z.string().min(3).max(320) });

/**
 * What will work for this address, on this install.
 *
 * A POST rather than a GET with a query string: the address is personal data,
 * and query strings end up in access logs, proxy logs, and browser history.
 * It reads nothing and writes nothing, which is why it is safe to call on
 * every keystroke-free blur of the connect field.
 */
mailRouter.post("/mail/connect/discover", validateBody(discoverSchema), async (req, res) => {
  const body = req.body as z.infer<typeof discoverSchema>;
  try {
    res.json({ plan: await describeMailboxConnect(body.email) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Could not read that address" });
  }
});

const port = z.number().int().min(1).max(65535);
const connectImapSchema = z.object({
  address: z.string().min(3).max(320),
  password: z.string().min(1).max(1024),
  username: z.string().max(320).optional(),
  imapHost: z.string().max(253).optional(),
  imapPort: port.optional(),
  smtpHost: z.string().max(253).optional(),
  smtpPort: port.optional(),
});

/**
 * Connect an IMAP mailbox: credential, Connection and MailAccount in one
 * call, with the first sync queued before the response returns.
 */
mailRouter.post(
  "/mail/connect/imap",
  // Creating a Connection is an admin act everywhere else in the product
  // (`integrationsRouter` gates every mutation on it), and a shortcut that
  // reaches the same object from a different router with a weaker gate is not
  // a shortcut — it is the hole. `requireBrowserSession` comes with it because
  // this one stores a credential.
  requireBrowserSession,
  requireCompanyRole("admin"),
  validateBody(connectImapSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const body = req.body as z.infer<typeof connectImapSchema>;
    let connected: Awaited<ReturnType<typeof connectImapMailbox>>;
    try {
      connected = await connectImapMailbox({
        companyId: cid,
        userId: req.userId ?? null,
        input: body,
      });
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : "Connect failed" });
    }
    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "mail.account.connect",
      targetType: "mail_account",
      targetId: connected.account.id,
      targetLabel: connected.account.address,
      metadata: { provider: "imap" },
    });
    void queueAccountSync(connected.account.id).catch(() => {});
    res.json({ account: serializeMailAccount(connected.account) });
  },
);

const createAccountSchema = z.object({ connectionId: z.string().uuid() });

mailRouter.post("/mail/accounts", validateBody(createAccountSchema), async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const body = req.body as z.infer<typeof createAccountSchema>;
  let account: MailAccount;
  try {
    account = await createMailAccount({
      companyId: cid,
      connectionId: body.connectionId,
      createdByUserId: req.userId ?? null,
    });
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : "Connect failed" });
  }
  await recordAudit({
    companyId: cid,
    actorUserId: req.userId ?? null,
    action: "mail.account.connect",
    targetType: "mail_account",
    targetId: account.id,
    targetLabel: account.address,
  });
  // First sync (the backfill) runs in the background; the UI follows along
  // via `mail.updated` events and the account's lastSyncAt/backfilledAt.
  void queueAccountSync(account.id).catch(() => {});
  res.json({ account: serializeMailAccount(account) });
});

mailRouter.get("/mail/accounts/:aid", async (req, res) => {
  const account = await loadAccount(
    (req.params as Record<string, string>).cid,
    req.params.aid as string,
  );
  if (!account) return res.status(404).json({ error: "Mail account not found" });
  res.json({ account: serializeMailAccount(account) });
});

const patchAccountSchema = z.object({ status: z.enum(["active", "paused"]) });

mailRouter.patch("/mail/accounts/:aid", validateBody(patchAccountSchema), async (req, res) => {
  const account = await loadAccount(
    (req.params as Record<string, string>).cid,
    req.params.aid as string,
  );
  if (!account) return res.status(404).json({ error: "Mail account not found" });
  const body = req.body as z.infer<typeof patchAccountSchema>;
  const resumed = body.status === "active" && account.status !== "active";
  const accountRepo = AppDataSource.getRepository(MailAccount);
  // Target only the operator-controlled fields. A full entity save can race
  // a sync transition and overwrite its queued/running attempt metadata.
  await accountRepo.update(account.id, {
    status: body.status,
    statusMessage: "",
    ...(body.status === "paused" ? { syncState: "failed", syncFinishedAt: new Date() } : {}),
  });
  const updatedAccount = await accountRepo.findOneByOrFail({ id: account.id });
  await recordAudit({
    companyId: account.companyId,
    actorUserId: req.userId ?? null,
    action: body.status === "paused" ? "mail.account.pause" : "mail.account.resume",
    targetType: "mail_account",
    targetId: account.id,
    targetLabel: account.address,
  });
  // Un-pausing should catch up immediately, not on the next heartbeat.
  if (resumed) void queueAccountSync(account.id).catch(() => {});
  broadcastToCompany(account.companyId, {
    type: "mail.updated",
    accountId: account.id,
    threadsChanged: false,
  });
  res.json({ account: serializeMailAccount(updatedAccount) });
});

mailRouter.delete("/mail/accounts/:aid", async (req, res) => {
  const account = await loadAccount(
    (req.params as Record<string, string>).cid,
    req.params.aid as string,
  );
  if (!account) return res.status(404).json({ error: "Mail account not found" });
  await disconnectMailAccount(account);
  broadcastToCompany(account.companyId, {
    type: "mail.updated",
    accountId: account.id,
    threadsChanged: false,
  });
  await recordAudit({
    companyId: account.companyId,
    actorUserId: req.userId ?? null,
    action: "mail.account.delete",
    targetType: "mail_account",
    targetId: account.id,
    targetLabel: account.address,
  });
  res.json({ ok: true });
});

mailRouter.post("/mail/accounts/:aid/sync", async (req, res) => {
  const account = await loadAccount(
    (req.params as Record<string, string>).cid,
    req.params.aid as string,
  );
  if (!account) return res.status(404).json({ error: "Mail account not found" });
  try {
    // The request is durable before this returns. The client follows the
    // attempt id through account state (websocket first, polling fallback), so
    // completion cannot be confused with an unrelated timestamp change.
    const sync = await queueAccountSync(account.id);
    res.status(202).json({ sync });
  } catch (error) {
    if (error instanceof MailSyncPausedError) {
      return res.status(409).json({ error: error.message });
    }
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Mailbox sync could not be queued",
    });
  }
});

// ───────────────────────────── labels + counts ─────────────────────────────

mailRouter.get("/mail/accounts/:aid/labels", async (req, res) => {
  const account = await loadAccount(
    (req.params as Record<string, string>).cid,
    req.params.aid as string,
  );
  if (!account) return res.status(404).json({ error: "Mail account not found" });
  const labels = await AppDataSource.getRepository(MailLabel).find({
    where: { accountId: account.id },
    order: { name: "ASC" },
  });
  // One in-memory pass over (labelIds, unread) computes every sidebar count.
  // Raw rows avoid hydrating a MailThread entity for every conversation in a
  // potentially very large mailbox. This endpoint only needs two scalar
  // columns, and it runs repeatedly while the sidebar follows sync updates.
  const threads = await AppDataSource.getRepository(MailThread)
    .createQueryBuilder("t")
    .select("t.labelIds", "labelIds")
    .addSelect("t.unread", "unread")
    .where("t.accountId = :accountId", { accountId: account.id })
    .getRawMany<{ labelIds: string; unread: boolean | number }>();
  let inboxUnread = 0;
  let drafts = 0;
  let starred = 0;
  const perLabel: Record<string, number> = {};
  for (const t of threads) {
    const inTrash = t.labelIds.includes(" TRASH ");
    if (!inTrash && t.unread && t.labelIds.includes(" INBOX ")) inboxUnread += 1;
    if (!inTrash && t.labelIds.includes(" DRAFT ")) drafts += 1;
    if (!inTrash && t.labelIds.includes(" STARRED ")) starred += 1;
    if (inTrash) continue;
    for (const id of columnToLabelIds(t.labelIds)) {
      perLabel[id] = (perLabel[id] ?? 0) + 1;
    }
  }
  res.json({
    labels: labels.map((l) => ({
      id: l.id,
      gmailLabelId: l.gmailLabelId,
      name: l.name,
      labelType: l.labelType,
      color: l.color,
      threadCount: perLabel[l.gmailLabelId] ?? 0,
    })),
    counts: { inboxUnread, drafts, starred },
  });
});

// ───────────────────────────── threads ─────────────────────────────

const THREAD_VIEWS = ["inbox", "starred", "sent", "drafts", "all", "spam", "trash"] as const;
type ThreadView = (typeof THREAD_VIEWS)[number];

mailRouter.get("/mail/accounts/:aid/threads", async (req, res) => {
  const account = await loadAccount(
    (req.params as Record<string, string>).cid,
    req.params.aid as string,
  );
  if (!account) return res.status(404).json({ error: "Mail account not found" });

  const view = (
    THREAD_VIEWS.includes(req.query.view as ThreadView) ? req.query.view : "inbox"
  ) as ThreadView;
  const label = typeof req.query.label === "string" ? req.query.label : "";
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const before = typeof req.query.before === "string" ? req.query.before : "";
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "50"), 10) || 50, 1), 100);

  // A search covers the whole mailbox (minus spam/trash), like Gmail —
  // finding an archived thread from the Inbox is the whole point. The query
  // itself can narrow back down (`in:` / `label:` / `is:` operators, see
  // services/mail/searchQuery.ts); folder browsing without a query keeps
  // the view/label params.
  const parsed = q ? parseMailQuery(q) : null;
  const searching = parsed !== null && !isEmptyQuery(parsed);

  let qb = AppDataSource.getRepository(MailThread)
    .createQueryBuilder("t")
    .where("t.accountId = :aid", { aid: account.id })
    .andWhere("t.lastMessageAt IS NOT NULL");

  if (searching) {
    const labelId = parsed.label ? await resolveSearchLabelId(account.id, parsed.label) : undefined;
    qb = applyMailScope(qb, effectiveScope(parsed, labelId));
    qb = applyMailSearchFilters(qb, parsed, labelId);
  } else if (label) {
    qb = qb.andWhere("t.labelIds LIKE :lbl", { lbl: `% ${label} %` });
    qb = qb.andWhere("t.labelIds NOT LIKE :trash", { trash: "% TRASH %" });
  } else {
    qb = applyMailScope(qb, view);
  }

  if (before) {
    const cursor = new Date(before);
    if (!Number.isNaN(cursor.getTime())) {
      qb = qb.andWhere("t.lastMessageAt < :before", { before: cursor });
    }
  }

  const rows = await qb
    .orderBy("t.lastMessageAt", "DESC")
    .take(limit + 1)
    .getMany();
  const page = rows.slice(0, limit);
  const nextBefore =
    rows.length > limit && page.length > 0
      ? (page[page.length - 1].lastMessageAt?.toISOString() ?? null)
      : null;
  res.json({ threads: page.map(serializeThread), nextBefore });
});

mailRouter.get("/mail/threads/:tid", async (req, res) => {
  const found = await loadThread(
    (req.params as Record<string, string>).cid,
    req.params.tid as string,
  );
  if (!found) return res.status(404).json({ error: "Thread not found" });
  const { thread, account } = found;
  const messages = await AppDataSource.getRepository(MailMessage).find({
    where: { threadId: thread.id },
    order: { sentAt: "ASC" },
  });
  const handovers = await AppDataSource.getRepository(MailHandover).find({
    where: { threadId: thread.id },
    order: { createdAt: "DESC" },
  });
  const employees = await employeesById(handovers.map((h) => h.employeeId));
  const analyses = await analysesForThread(thread.companyId, thread.id);
  res.json({
    thread: serializeThread(thread),
    account: { id: account.id, address: account.address },
    messages: messages.map(serializeMessage),
    handovers: handovers.map((h) => serializeHandover(h, employees)),
    analyses: analyses.map(serializeAnalysis),
  });
});

const threadActionSchema = z.object({
  action: z.enum([
    "markRead",
    "markUnread",
    "star",
    "unstar",
    "archive",
    "moveToInbox",
    "trash",
    "untrash",
    "applyLabel",
    "removeLabel",
  ]),
  labelId: z.string().optional(),
  labelName: z.string().max(200).optional(),
});

mailRouter.post(
  "/mail/threads/:tid/actions",
  validateBody(threadActionSchema),
  async (req, res) => {
    const found = await loadThread(
      (req.params as Record<string, string>).cid,
      req.params.tid as string,
    );
    if (!found) return res.status(404).json({ error: "Thread not found" });
    const body = req.body as z.infer<typeof threadActionSchema>;
    try {
      await performThreadAction(found.account, found.thread, body.action as ThreadAction, {
        labelId: body.labelId,
        labelName: body.labelName,
      });
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : "Action failed" });
    }
    await recordAudit({
      companyId: found.account.companyId,
      actorUserId: req.userId ?? null,
      action: "mail.thread.action",
      targetType: "mail_thread",
      targetId: found.thread.id,
      targetLabel: found.thread.subject || "(no subject)",
      metadata: { action: body.action, labelName: body.labelName ?? body.labelId },
    });
    const fresh = await AppDataSource.getRepository(MailThread).findOneBy({
      id: found.thread.id,
    });
    res.json({ thread: fresh ? serializeThread(fresh) : null });
  },
);

const threadBulkSchema = z
  .object({
    action: threadActionSchema.shape.action,
    // Chunked by the client — see MAX_BULK_THREAD_IDS.
    ids: z.array(z.string().uuid()).min(1).max(MAX_BULK_THREAD_IDS),
    labelId: z.string().optional(),
    labelName: z.string().max(200).optional(),
  })
  .strict();

mailRouter.post(
  "/mail/accounts/:aid/threads/bulk",
  validateBody(threadBulkSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const account = await loadAccount(cid, req.params.aid as string);
    if (!account) return res.status(404).json({ error: "Mail account not found" });
    const body = req.body as z.infer<typeof threadBulkSchema>;

    // Scope the ids to this account rather than trusting them — a bulk call is
    // the easiest place to smuggle in a thread from somewhere else.
    const threads = await AppDataSource.getRepository(MailThread).find({
      where: { id: In(body.ids), companyId: cid, accountId: account.id },
    });

    const result = await bulkThreadAction(account, threads, body.action as ThreadAction, {
      labelId: body.labelId,
      labelName: body.labelName,
    });
    const found = new Set(threads.map((thread) => thread.id));
    for (const id of body.ids) {
      if (!found.has(id)) result.skipped.push({ id, reason: "not-found" });
    }

    if (result.succeeded.length > 0) {
      await recordAudit({
        companyId: account.companyId,
        actorUserId: req.userId ?? null,
        action: "mail.thread.bulk_action",
        targetType: "mail_account",
        targetId: account.id,
        targetLabel: account.address,
        metadata: {
          action: body.action,
          requested: body.ids.length,
          succeeded: result.succeeded.length,
          skipped: result.skipped.length,
        },
      });
    }
    res.json(result);
  },
);

/** Prefill helper for the reply-all composer. */
mailRouter.get("/mail/threads/:tid/reply-recipients", async (req, res) => {
  const found = await loadThread(
    (req.params as Record<string, string>).cid,
    req.params.tid as string,
  );
  if (!found) return res.status(404).json({ error: "Thread not found" });
  const recipients = await replyAllRecipients(found.account, found.thread);
  res.json(recipients);
});

// ───────────────────────────── compose / drafts ─────────────────────────────

const composeSchema = z.object({
  to: z.string().max(2000).default(""),
  cc: z.string().max(2000).default(""),
  bcc: z.string().max(2000).default(""),
  subject: z.string().max(1000).default(""),
  bodyText: z.string().max(200_000),
  threadId: z.string().uuid().optional(),
  attachmentIds: z.array(z.string().max(64)).max(20).optional(),
});

// Outbound attachments are staged in memory, then referenced by token when
// the message is sent or drafted. 25 MB per file (Gmail's own attachment cap).
const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

mailRouter.post(
  "/mail/accounts/:aid/outbox-attachments",
  attachmentUpload.single("file"),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const account = await loadAccount(cid, req.params.aid as string);
    if (!account) return res.status(404).json({ error: "Mail account not found" });
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });
    try {
      const info = stageAttachment({
        accountId: account.id,
        filename: file.originalname,
        mimeType: file.mimetype,
        content: file.buffer,
      });
      res.json({ attachment: info });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Upload failed" });
    }
  },
);

async function resolveComposeThread(
  cid: string,
  accountId: string,
  threadId: string | undefined,
  res: Response,
): Promise<{ thread: MailThread | null } | null> {
  if (!threadId) return { thread: null };
  const found = await loadThread(cid, threadId);
  if (!found || found.account.id !== accountId) {
    res.status(404).json({ error: "Thread not found" });
    return null;
  }
  return { thread: found.thread };
}

mailRouter.post("/mail/accounts/:aid/send", validateBody(composeSchema), async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const account = await loadAccount(cid, req.params.aid as string);
  if (!account) return res.status(404).json({ error: "Mail account not found" });
  const body = req.body as z.infer<typeof composeSchema>;
  const resolved = await resolveComposeThread(cid, account.id, body.threadId, res);
  if (!resolved) return;
  try {
    const message = await sendMailMessage(account, body, resolved.thread);
    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "mail.send",
      targetType: "mail_message",
      targetId: message.id,
      targetLabel: message.subject || "(no subject)",
    });
    res.json({ message: serializeMessage(message) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Send failed" });
  }
});

mailRouter.post("/mail/accounts/:aid/drafts", validateBody(composeSchema), async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const account = await loadAccount(cid, req.params.aid as string);
  if (!account) return res.status(404).json({ error: "Mail account not found" });
  const body = req.body as z.infer<typeof composeSchema>;
  const resolved = await resolveComposeThread(cid, account.id, body.threadId, res);
  if (!resolved) return;
  try {
    const message = await createMailDraft(account, body, resolved.thread, {
      userId: req.userId ?? null,
    });
    res.json({ message: serializeMessage(message) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Draft failed" });
  }
});

// ───────────────────────── drafts review queue ─────────────────────────

const draftListQuerySchema = z.object({
  employeeId: z.string().uuid().optional(),
  routineId: z.string().uuid().optional(),
  q: z.string().max(200).optional(),
  // Flags arrive as "1" rather than being coerced — z.coerce.boolean() treats
  // the string "0" as true, which is exactly the wrong answer here.
  missingRecipient: z.string().optional(),
  unattributed: z.string().optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const draftFilterSchema = z
  .object({
    employeeId: z.string().uuid().optional(),
    routineId: z.string().uuid().optional(),
    q: z.string().max(200).optional(),
    onlyMissingRecipient: z.boolean().optional(),
    unattributed: z.boolean().optional(),
    sendableOnly: z.boolean().optional(),
  })
  .strict();

/** Either an explicit tick-box selection, or "everything matching" minus opt-outs. */
const draftSelectionSchema = z.union([
  z.object({ ids: z.array(z.string().uuid()).min(1).max(2000) }).strict(),
  z
    .object({
      filter: draftFilterSchema,
      exclude: z.array(z.string().uuid()).max(2000).default([]),
    })
    .strict(),
]);

const draftBulkSchema = z
  .object({
    // Sending is always durable and paced through `/send-queue`; this endpoint
    // remains the small synchronous path for reversible draft disposal.
    action: z.literal("discard"),
    ids: z.array(z.string().uuid()).min(1).max(MAX_BULK_DRAFT_IDS),
  })
  .strict();

const draftSendQueueSchema = z
  .object({
    ids: z.array(z.string().uuid()).min(1).max(MAX_QUEUED_DRAFT_IDS),
  })
  .strict();

mailRouter.get("/mail/accounts/:aid/drafts", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const account = await loadAccount(cid, req.params.aid as string);
  if (!account) return res.status(404).json({ error: "Mail account not found" });

  const parsed = draftListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "ValidationError", issues: parsed.error.issues });
  }
  const query = parsed.data;
  const result = await listDrafts(account, {
    filter: {
      employeeId: query.employeeId,
      routineId: query.routineId,
      q: query.q,
      onlyMissingRecipient: query.missingRecipient === "1",
      unattributed: query.unattributed === "1",
    },
    offset: query.offset,
    limit: query.limit,
  });
  res.json(result);
});

mailRouter.post(
  "/mail/accounts/:aid/drafts/send-preview",
  validateBody(draftSelectionSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const account = await loadAccount(cid, req.params.aid as string);
    if (!account) return res.status(404).json({ error: "Mail account not found" });
    res.json(await previewDraftSend(account, req.body as DraftSelection));
  },
);

mailRouter.post(
  "/mail/accounts/:aid/drafts/bulk",
  validateBody(draftBulkSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const account = await loadAccount(cid, req.params.aid as string);
    if (!account) return res.status(404).json({ error: "Mail account not found" });
    const body = req.body as z.infer<typeof draftBulkSchema>;
    const result = await runBulkDraftDiscard(account, body.ids, req.userId ?? null);
    res.json(result);
  },
);

mailRouter.get("/mail/accounts/:aid/drafts/send-queue", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const account = await loadAccount(cid, req.params.aid as string);
  if (!account) return res.status(404).json({ error: "Mail account not found" });
  res.json({ batch: await getLatestDraftSendBatch(account) });
});

mailRouter.post(
  "/mail/accounts/:aid/drafts/send-queue",
  validateBody(draftSendQueueSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const account = await loadAccount(cid, req.params.aid as string);
    if (!account) return res.status(404).json({ error: "Mail account not found" });
    try {
      const result = await createDraftSendBatch(
        account,
        (req.body as z.infer<typeof draftSendQueueSchema>).ids,
        req.userId ?? null,
      );
      res.status(202).json(result);
    } catch (error) {
      res.status(error instanceof DraftSendQueueBusyError ? 409 : 400).json({
        error: error instanceof Error ? error.message : "Could not queue drafts",
      });
    }
  },
);

async function loadDraft(
  cid: string,
  messageId: string,
): Promise<{ draft: MailMessage; account: MailAccount } | null> {
  const draft = await AppDataSource.getRepository(MailMessage).findOneBy({
    id: messageId,
    companyId: cid,
  });
  if (!draft || !draft.gmailDraftId) return null;
  const account = await loadAccount(cid, draft.accountId);
  if (!account) return null;
  return { draft, account };
}

const patchDraftSchema = composeSchema.omit({ threadId: true }).extend({
  /**
   * Which of the draft's existing attachments to keep, by the same positional
   * index the download route uses. Editing a draft rebuilds it from raw MIME,
   * so files not listed here are dropped: `[]` clears them, and omitting the
   * field keeps every one — a client that only edited the wording never loses
   * the attachments it didn't mention.
   */
  keepAttachmentIndexes: z.array(z.number().int().min(0)).max(20).optional(),
});

mailRouter.patch("/mail/drafts/:mid", validateBody(patchDraftSchema), async (req, res) => {
  const found = await loadDraft(
    (req.params as Record<string, string>).cid,
    req.params.mid as string,
  );
  if (!found) return res.status(404).json({ error: "Draft not found" });
  const body = req.body as z.infer<typeof patchDraftSchema>;
  const keepAttachmentIndexes =
    body.keepAttachmentIndexes ??
    summarizeMailAttachments(found.draft.attachmentsJson).map((a) => a.index);
  try {
    const message = await updateMailDraft(found.account, found.draft, body, {
      keepAttachmentIndexes,
    });
    res.json({ message: serializeMessage(message) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Update failed" });
  }
});

mailRouter.post("/mail/drafts/:mid/send", async (req, res) => {
  const found = await loadDraft(
    (req.params as Record<string, string>).cid,
    req.params.mid as string,
  );
  if (!found) return res.status(404).json({ error: "Draft not found" });
  try {
    const message = await sendMailDraft(found.account, found.draft);
    await recordAudit({
      companyId: found.account.companyId,
      actorUserId: req.userId ?? null,
      action: "mail.send",
      targetType: "mail_message",
      targetId: message.id,
      targetLabel: message.subject || "(no subject)",
      metadata: { fromDraft: true },
    });
    res.json({ message: serializeMessage(message) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Send failed" });
  }
});

mailRouter.delete("/mail/drafts/:mid", async (req, res) => {
  const found = await loadDraft(
    (req.params as Record<string, string>).cid,
    req.params.mid as string,
  );
  if (!found) return res.status(404).json({ error: "Draft not found" });
  try {
    await discardMailDraft(found.account, found.draft);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Discard failed" });
  }
});

// ───────────────────────────── saved searches ─────────────────────────────

/** Enough for anyone; a bound stops a scripted client filling the table. */
const MAX_SAVED_SEARCHES = 50;

const savedSearchCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    query: z.string().trim().min(1).max(500),
  })
  .strict();

const savedSearchPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    query: z.string().trim().min(1).max(500).optional(),
    sortOrder: z.number().finite().optional(),
  })
  .strict();

function serializeSavedSearch(row: MailSavedSearch) {
  return {
    id: row.id,
    accountId: row.accountId,
    name: row.name,
    query: row.query,
    sortOrder: row.sortOrder,
  };
}

/**
 * Saved searches belong to one Member, so every query here is scoped by
 * `userId` as well as company — a shared mailbox must not turn into a shared
 * list of everybody's shortcuts.
 */
mailRouter.get("/mail/accounts/:aid/saved-searches", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const userId = req.userId;
  if (!userId) return res.status(401).json({ error: "Not signed in" });
  const account = await loadAccount(cid, req.params.aid as string);
  if (!account) return res.status(404).json({ error: "Mail account not found" });

  const rows = await AppDataSource.getRepository(MailSavedSearch).find({
    where: { companyId: cid, userId, accountId: account.id },
    order: { sortOrder: "ASC", createdAt: "ASC" },
  });
  res.json({ savedSearches: rows.map(serializeSavedSearch) });
});

mailRouter.post(
  "/mail/accounts/:aid/saved-searches",
  validateBody(savedSearchCreateSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: "Not signed in" });
    const account = await loadAccount(cid, req.params.aid as string);
    if (!account) return res.status(404).json({ error: "Mail account not found" });

    const repo = AppDataSource.getRepository(MailSavedSearch);
    const scope = { companyId: cid, userId, accountId: account.id };
    const existing = await repo.find({ where: scope, order: { sortOrder: "DESC" }, take: 1 });
    const count = await repo.countBy(scope);
    if (count >= MAX_SAVED_SEARCHES) {
      return res
        .status(400)
        .json({ error: `You can keep up to ${MAX_SAVED_SEARCHES} saved searches.` });
    }

    const body = req.body as z.infer<typeof savedSearchCreateSchema>;
    const saved = await repo.save(
      repo.create({ ...scope, ...body, sortOrder: (existing[0]?.sortOrder ?? 0) + 1 }),
    );
    res.json({ savedSearch: serializeSavedSearch(saved) });
  },
);

/** Load one, refusing anything that is not this member's own. */
async function loadSavedSearch(
  cid: string,
  userId: string,
  id: string,
): Promise<MailSavedSearch | null> {
  return AppDataSource.getRepository(MailSavedSearch).findOneBy({
    id,
    companyId: cid,
    userId,
  });
}

mailRouter.patch(
  "/mail/saved-searches/:sid",
  validateBody(savedSearchPatchSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: "Not signed in" });
    const row = await loadSavedSearch(cid, userId, req.params.sid as string);
    if (!row) return res.status(404).json({ error: "Saved search not found" });

    const body = req.body as z.infer<typeof savedSearchPatchSchema>;
    if (body.name !== undefined) row.name = body.name;
    if (body.query !== undefined) row.query = body.query;
    if (body.sortOrder !== undefined) row.sortOrder = body.sortOrder;
    const saved = await AppDataSource.getRepository(MailSavedSearch).save(row);
    res.json({ savedSearch: serializeSavedSearch(saved) });
  },
);

mailRouter.delete("/mail/saved-searches/:sid", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const userId = req.userId;
  if (!userId) return res.status(401).json({ error: "Not signed in" });
  const row = await loadSavedSearch(cid, userId, req.params.sid as string);
  if (!row) return res.status(404).json({ error: "Saved search not found" });
  await AppDataSource.getRepository(MailSavedSearch).delete({ id: row.id });
  res.json({ ok: true });
});

// ───────────────────────────── attachments ─────────────────────────────

/**
 * Stream one attachment. The bytes live in Gmail, not here — see
 * services/mail/attachments.ts for how a drifting Gmail attachment id is
 * resolved back to the position the stored metadata recorded.
 */
mailRouter.get("/mail/messages/:mid/attachments/:index", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const row = await AppDataSource.getRepository(MailMessage).findOneBy({
    id: req.params.mid as string,
    companyId: cid,
  });
  if (!row) return res.status(404).json({ error: "Message not found" });
  const account = await loadAccount(cid, row.accountId);
  if (!account) return res.status(404).json({ error: "Mail account not found" });
  const index = parseInt(String(req.params.index), 10);
  try {
    const { meta, bytes } = await fetchMailAttachmentBytes(account, row, index);
    res.setHeader("content-type", meta.mimeType || "application/octet-stream");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader(
      "content-disposition",
      `attachment; filename="${meta.filename.replace(/["\r\n]/g, "")}"`,
    );
    res.send(bytes);
  } catch (err) {
    if (err instanceof MailAttachmentError) {
      return res.status(err.status).json({ error: err.message });
    }
    res.status(400).json({ error: err instanceof Error ? err.message : "Download failed" });
  }
});

// ───────────────────────────── rules ─────────────────────────────

const ruleConditionsSchema = z
  .object({
    from: z.string().max(500).optional(),
    to: z.string().max(500).optional(),
    subjectContains: z.string().max(500).optional(),
    bodyContains: z.string().max(500).optional(),
    hasAttachment: z.boolean().optional(),
    ai: z
      .object({
        employeeId: z.string().uuid(),
        instruction: z.string().trim().min(1).max(4000),
      })
      .strict()
      .optional(),
  })
  .strict();

const ruleActionSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("applyLabel"), labelName: z.string().trim().min(1).max(200) })
    .strict(),
  z.object({ type: z.literal("markRead") }).strict(),
  z.object({ type: z.literal("star") }).strict(),
  z.object({ type: z.literal("archive") }).strict(),
  z.object({ type: z.literal("unsubscribe") }).strict(),
  z
    .object({
      type: z.literal("handToEmployee"),
      employeeId: z.string().uuid(),
      instruction: z.string().trim().max(4000).default(""),
      mode: z.enum(["draft", "reply", "triage"]),
    })
    .strict(),
]);

const createRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    enabled: z.boolean().default(true),
    conditions: ruleConditionsSchema,
    actions: z.array(ruleActionSchema).min(1).max(10),
  })
  .strict();

function serializeRule(r: MailRule, employees: Map<string, AIEmployee>) {
  let actions: unknown[] = [];
  try {
    actions = JSON.parse(r.actionsJson) as unknown[];
  } catch {
    actions = [];
  }
  const hydrated = actions.map((a) => {
    const action = a as { type?: string; employeeId?: string };
    if (action.type === "handToEmployee" && action.employeeId) {
      const emp = employees.get(action.employeeId);
      return { ...action, employeeName: emp?.name ?? "(deleted employee)" };
    }
    return action;
  });
  let conditions = parseRuleConditions(r.conditionsJson);
  if (conditions.ai) {
    const employee = employees.get(conditions.ai.employeeId);
    conditions = {
      ...conditions,
      ai: {
        ...conditions.ai,
        employeeName: employee?.name ?? "(deleted AI Employee)",
      },
    };
  }
  return {
    id: r.id,
    accountId: r.accountId,
    name: r.name,
    enabled: r.enabled,
    position: r.position,
    conditions,
    actions: hydrated,
    matchCount: r.matchCount,
    lastMatchedAt: r.lastMatchedAt ? r.lastMatchedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  };
}

async function ruleEmployees(
  companyId: string,
  rules: MailRule[],
): Promise<Map<string, AIEmployee>> {
  const ids: string[] = [];
  for (const r of rules) {
    const condition = parseRuleConditions(r.conditionsJson).ai;
    if (condition?.employeeId) ids.push(condition.employeeId);
    try {
      for (const a of JSON.parse(r.actionsJson) as Array<{ employeeId?: string }>) {
        if (a.employeeId) ids.push(a.employeeId);
      }
    } catch {
      // ignore
    }
  }
  if (ids.length === 0) return new Map();
  const rows = await AppDataSource.getRepository(AIEmployee).find({
    where: { id: In(Array.from(new Set(ids))), companyId },
  });
  return new Map(rows.map((employee) => [employee.id, employee]));
}

mailRouter.get("/mail/accounts/:aid/rules", async (req, res) => {
  const account = await loadAccount(
    (req.params as Record<string, string>).cid,
    req.params.aid as string,
  );
  if (!account) return res.status(404).json({ error: "Mail account not found" });
  const rules = await AppDataSource.getRepository(MailRule).find({
    where: { accountId: account.id },
    order: { position: "ASC", createdAt: "ASC" },
  });
  const employees = await ruleEmployees(account.companyId, rules);
  res.json({ rules: rules.map((r) => serializeRule(r, employees)) });
});

mailRouter.post("/mail/accounts/:aid/rules", validateBody(createRuleSchema), async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const account = await loadAccount(cid, req.params.aid as string);
  if (!account) return res.status(404).json({ error: "Mail account not found" });
  const body = req.body as z.infer<typeof createRuleSchema>;
  const empError = await validateMailRuleConfiguration({
    companyId: cid,
    accountId: account.id,
    conditions: body.conditions,
    actions: body.actions,
    requireReady: body.enabled,
  });
  if (empError) return res.status(400).json({ error: empError });
  const repo = AppDataSource.getRepository(MailRule);
  const maxPosition = await repo.count({ where: { accountId: account.id } });
  const rule = await repo.save(
    repo.create({
      companyId: cid,
      accountId: account.id,
      name: body.name,
      enabled: body.enabled,
      position: maxPosition,
      conditionsJson: JSON.stringify(body.conditions),
      actionsJson: JSON.stringify(body.actions),
      createdByUserId: req.userId ?? null,
    }),
  );
  await recordAudit({
    companyId: cid,
    actorUserId: req.userId ?? null,
    action: "mail.rule.create",
    targetType: "mail_rule",
    targetId: rule.id,
    targetLabel: rule.name,
  });
  const employees = await ruleEmployees(cid, [rule]);
  res.json({ rule: serializeRule(rule, employees) });
});

const patchRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    enabled: z.boolean().optional(),
    position: z.number().int().min(0).optional(),
    conditions: ruleConditionsSchema.optional(),
    actions: z.array(ruleActionSchema).min(1).max(10).optional(),
  })
  .strict();

async function loadRule(cid: string, ruleId: string): Promise<MailRule | null> {
  return AppDataSource.getRepository(MailRule).findOneBy({
    id: ruleId,
    companyId: cid,
  });
}

mailRouter.patch("/mail/rules/:rid", validateBody(patchRuleSchema), async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const rule = await loadRule(cid, req.params.rid as string);
  if (!rule) return res.status(404).json({ error: "Rule not found" });
  const body = req.body as z.infer<typeof patchRuleSchema>;
  const conditions = body.conditions ?? parseRuleConditions(rule.conditionsJson);
  const actions = body.actions ?? parseRuleActions(rule.actionsJson);
  if (body.conditions || body.actions || body.enabled === true) {
    const empError = await validateMailRuleConfiguration({
      companyId: cid,
      accountId: rule.accountId,
      conditions,
      actions,
      requireReady: body.enabled ?? rule.enabled,
    });
    if (empError) return res.status(400).json({ error: empError });
  }
  if (body.actions) {
    rule.actionsJson = JSON.stringify(body.actions);
  }
  if (body.conditions) rule.conditionsJson = JSON.stringify(body.conditions);
  if (body.name !== undefined) rule.name = body.name;
  if (body.enabled !== undefined) rule.enabled = body.enabled;
  if (body.position !== undefined) rule.position = body.position;
  await AppDataSource.getRepository(MailRule).save(rule);
  await recordAudit({
    companyId: cid,
    actorUserId: req.userId ?? null,
    action: "mail.rule.update",
    targetType: "mail_rule",
    targetId: rule.id,
    targetLabel: rule.name,
  });
  const employees = await ruleEmployees(cid, [rule]);
  res.json({ rule: serializeRule(rule, employees) });
});

mailRouter.delete("/mail/rules/:rid", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const rule = await loadRule(cid, req.params.rid as string);
  if (!rule) return res.status(404).json({ error: "Rule not found" });
  await AppDataSource.getRepository(MailRule).delete({ id: rule.id });
  await recordAudit({
    companyId: cid,
    actorUserId: req.userId ?? null,
    action: "mail.rule.delete",
    targetType: "mail_rule",
    targetId: rule.id,
    targetLabel: rule.name,
  });
  res.json({ ok: true });
});

// ───────────────────────────── handovers ─────────────────────────────

mailRouter.get("/mail/accounts/:aid/handovers", async (req, res) => {
  const account = await loadAccount(
    (req.params as Record<string, string>).cid,
    req.params.aid as string,
  );
  if (!account) return res.status(404).json({ error: "Mail account not found" });
  const where: Record<string, string> = { accountId: account.id };
  if (typeof req.query.threadId === "string" && req.query.threadId) {
    where.threadId = req.query.threadId;
  }
  const handovers = await AppDataSource.getRepository(MailHandover).find({
    where,
    order: { createdAt: "DESC" },
    take: 200,
  });
  const employees = await employeesById(handovers.map((h) => h.employeeId));
  const threadRows = await AppDataSource.getRepository(MailThread).find({
    where: { id: In(Array.from(new Set(handovers.map((h) => h.threadId)))) },
  });
  const threads = new Map(threadRows.map((t) => [t.id, t]));
  res.json({
    handovers: handovers.map((h) => serializeHandover(h, employees, threads)),
  });
});

const createHandoverSchema = z.object({
  employeeId: z.string().uuid(),
  instruction: z.string().max(4000).default(""),
  mode: z.enum(["draft", "reply", "triage"]),
});

mailRouter.post(
  "/mail/threads/:tid/handovers",
  requireBrowserSession,
  validateBody(createHandoverSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const found = await loadThread(cid, req.params.tid as string);
    if (!found) return res.status(404).json({ error: "Thread not found" });
    const body = req.body as z.infer<typeof createHandoverSchema>;
    const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
      id: body.employeeId,
      companyId: cid,
    });
    if (!employee) return res.status(404).json({ error: "Employee not found" });
    const grantError = await handoverGrantError(employee.id, found.account.id, body.mode);
    if (grantError) return res.status(400).json({ error: grantError });
    const handover = await createMailHandover({
      account: found.account,
      thread: found.thread,
      employeeId: employee.id,
      mode: body.mode,
      instruction: body.instruction,
      sourceKind: "manual",
      ruleId: null,
      createdByUserId: req.userId!,
      requesterUserId: req.userId!,
      requesterSessionVersion: req.session!.sessionVersion!,
    });
    const employees = new Map([[employee.id, employee]]);
    res.json({ handover: serializeHandover(handover, employees) });
  },
);

mailRouter.post("/mail/handovers/:hid/retry", requireBrowserSession, async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const handover = await AppDataSource.getRepository(MailHandover).findOneBy({
    id: req.params.hid as string,
    companyId: cid,
  });
  if (!handover) return res.status(404).json({ error: "Handover not found" });
  if (handover.status !== "failed") {
    return res.status(409).json({ error: "Only failed handovers can be retried" });
  }
  await retryMailHandover(handover, {
    userId: req.userId!,
    sessionVersion: req.session!.sessionVersion!,
  });
  res.json({ ok: true });
});

// ───────────────────────────── assistant ─────────────────────────────

const assistantThreadQuerySchema = z
  .object({
    threadId: z.string().uuid(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();

/** Panel bootstrap: this email's conversation plus everyone tag-able on it. */
mailRouter.get("/mail/accounts/:aid/assistant", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const account = await loadAccount(cid, req.params.aid as string);
  if (!account) return res.status(404).json({ error: "Mail account not found" });
  const parsed = assistantThreadQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "ValidationError", issues: parsed.error.issues });
  }
  const thread = await AppDataSource.getRepository(MailThread).findOneBy({
    id: parsed.data.threadId,
    accountId: account.id,
    companyId: cid,
  });
  if (!thread) return res.status(404).json({ error: "Mail thread not found" });
  const [messages, roster] = await Promise.all([
    listAssistantMessages(account, thread.id, parsed.data.limit),
    assistantRoster(cid, account.id),
  ]);
  const attachments = await assistantAttachments(messages);
  // The employee the panel is talking to, and the brain their last answered
  // turn ran on — so reopening the panel resumes on the same model rather
  // than silently switching to whatever is active now.
  const lastAnswered = [...messages].reverse().find((m) => m.role === "assistant" && m.employeeId);
  const modelId = lastAnswered?.employeeId
    ? await lastAssistantModelId(account.id, thread.id, lastAnswered.employeeId)
    : null;
  res.json({
    messages: messages.map((m) => serializeAssistantMessage(m, attachments.get(m.id) ?? [])),
    roster,
    modelId,
  });
});

mailRouter.delete("/mail/accounts/:aid/assistant/messages", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const account = await loadAccount(cid, req.params.aid as string);
  if (!account) return res.status(404).json({ error: "Mail account not found" });
  const parsed = assistantThreadQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "ValidationError", issues: parsed.error.issues });
  }
  const thread = await AppDataSource.getRepository(MailThread).findOneBy({
    id: parsed.data.threadId,
    accountId: account.id,
    companyId: cid,
  });
  if (!thread) return res.status(404).json({ error: "Mail thread not found" });
  await clearAssistantMessages(account, thread.id);
  res.json({ ok: true });
});

const assistantSendSchema = z.object({
  message: z.string().min(1).max(8000),
  threadId: z.string().uuid(),
  focusedMessageId: z.string().uuid().optional(),
  employeeId: z.string().uuid().optional(),
  /** Files uploaded through the route below, bound to this turn on send. */
  attachmentIds: z.array(z.string().uuid()).max(10).optional().default([]),
  /** Employee-owned AI Model for this turn; null inherits the active one. */
  modelId: z.string().uuid().nullable().optional().default(null),
});

/**
 * Upload a file into an email's AI chat.
 *
 * Distinct from `outbox-attachments` above, which stages bytes in memory for
 * an outgoing message. This is a chat upload: it becomes an ordinary
 * `Attachment` row bound to the human's turn, so the employee sees it in its
 * prompt with an `attachmentId` it can pass to the PDF tools — the same
 * contract employee chat and workspace channels use.
 */
mailRouter.post(
  "/mail/accounts/:aid/assistant/attachments",
  async (req, res, next) => {
    // The upload middleware writes into the company's attachment directory,
    // which it resolves from `req.company` — the mail router doesn't set it.
    const cid = (req.params as Record<string, string>).cid;
    const company = await AppDataSource.getRepository(Company).findOneBy({ id: cid });
    if (!company) return res.status(404).json({ error: "Company not found" });
    (req as unknown as { company: Company }).company = company;
    next();
  },
  uploadMiddleware.single("file"),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const account = await loadAccount(cid, req.params.aid as string);
    if (!account) return res.status(404).json({ error: "Mail account not found" });
    const company = (req as unknown as { company: Company }).company;
    const file = (req as unknown as { file?: Express.Multer.File }).file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });
    const row = await recordAttachment({
      companyId: company.id,
      companySlug: company.slug,
      file,
      uploadedByUserId: req.userId!,
    });
    res.status(201).json({
      attachment: {
        id: row.id,
        filename: row.filename,
        mimeType: row.mimeType,
        sizeBytes: Number(row.sizeBytes),
        isImage: row.mimeType.startsWith("image/"),
      },
    });
  },
);

/**
 * Download a file from an email's AI chat — either one the teammate uploaded
 * or one the employee produced. Scoped to attachments actually bound to a
 * turn of THIS mailbox's chat (plus the requester's own not-yet-sent upload),
 * so an attachment id from elsewhere in the company can't be read through
 * this route.
 */
mailRouter.get("/mail/accounts/:aid/assistant/attachments/:attachmentId", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const account = await loadAccount(cid, req.params.aid as string);
  if (!account) return res.status(404).json({ error: "Mail account not found" });
  const resolved = await resolveAttachmentFile(req.params.attachmentId as string, cid);
  const missing = { error: "Attachment not found" };
  if (!resolved) return res.status(404).json(missing);
  if (resolved.row.messageId) {
    const owner = await AppDataSource.getRepository(MailChatMessage).findOneBy({
      id: resolved.row.messageId,
      accountId: account.id,
      companyId: cid,
    });
    if (!owner) return res.status(404).json(missing);
  } else if (resolved.row.uploadedByUserId !== req.userId) {
    return res.status(404).json(missing);
  }
  res.setHeader("content-type", resolved.row.mimeType);
  res.setHeader("x-content-type-options", "nosniff");
  const disposition = resolved.row.mimeType.startsWith("image/") ? "inline" : "attachment";
  res.setHeader(
    "content-disposition",
    `${disposition}; filename="${encodeURIComponent(resolved.row.filename)}"`,
  );
  res.sendFile(resolved.absPath);
});

/**
 * How often this stream emits an SSE keepalive comment. A turn can spend
 * minutes between visible `chunk` events while the employee reads the thread
 * and runs tools, and any idle reverse proxy in front of a self-hosted
 * Genosyn (nginx `proxy_read_timeout` 60s, Caddy, cloud load balancers at
 * 30–100s) resets a silent connection — which the browser reports as a bare
 * `network error` mid-reply. A comment line every 15s stays under those
 * timers. Same value the employee chat stream uses.
 */
const ASSISTANT_STREAM_HEARTBEAT_MS = 15_000;

/**
 * One assistant turn, streamed over SSE (same event grammar as employee
 * chat): `user` → the persisted human turn, `target` → the resolved
 * employee, `working` → the persisted in-flight assistant row, `chunk` →
 * reply text deltas, `assistant` → the finalized reply (with actions +
 * suggestions), `done` → end marker. Errors also arrive as events so the
 * client rendering stays uniform.
 *
 * The turn is not tied to this connection: once `working` has been written
 * the row owns the reply, and a client that loses the stream re-reads it
 * from the panel bootstrap instead of losing the answer.
 */
mailRouter.post(
  "/mail/accounts/:aid/assistant/messages",
  requireBrowserSession,
  validateBody(assistantSendSchema),
  async (req, res, next) => {
    const cid = (req.params as Record<string, string>).cid;
    const body = req.body as z.infer<typeof assistantSendSchema>;

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const writeEvent = (event: string, data: unknown) => {
      if (res.writableEnded || res.destroyed) return;
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const heartbeat = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(`: keepalive\n\n`);
    }, ASSISTANT_STREAM_HEARTBEAT_MS);
    heartbeat.unref?.();
    res.on("close", () => clearInterval(heartbeat));

    try {
      const account = await loadAccount(cid, req.params.aid as string);
      if (!account) {
        writeEvent("error", { message: "Mail account not found" });
        writeEvent("done", {});
        return res.end();
      }
      const thread = await AppDataSource.getRepository(MailThread).findOneBy({
        id: body.threadId,
        accountId: account.id,
        companyId: cid,
      });
      if (!thread) {
        writeEvent("error", { message: "Mail thread not found" });
        writeEvent("done", {});
        return res.end();
      }
      await runAssistantTurn({
        account,
        message: body.message,
        threadId: thread.id,
        focusedMessageId: body.focusedMessageId ?? null,
        employeeId: body.employeeId,
        attachmentIds: body.attachmentIds,
        modelId: body.modelId,
        userId: req.userId!,
        requesterSessionVersion: req.session!.sessionVersion!,
        callbacks: {
          onUser: (msg) => writeEvent("user", msg),
          onTarget: (employee) => writeEvent("target", { employee }),
          onWorking: (msg) => writeEvent("working", msg),
          onChunk: (text) => writeEvent("chunk", { text }),
          onAssistant: (msg) => writeEvent("assistant", msg),
        },
      });
      writeEvent("done", {});
      if (!res.writableEnded && !res.destroyed) res.end();
    } catch (e) {
      if (!res.writableEnded && !res.destroyed) {
        writeEvent("error", {
          message: e instanceof Error ? e.message : String(e),
        });
        writeEvent("done", {});
        res.end();
      } else if (!res.destroyed) {
        next(e);
      }
    } finally {
      clearInterval(heartbeat);
    }
  },
);

/** Stamp a suggestion button as executed (idempotence guard after reload). */
mailRouter.post("/mail/assistant/messages/:mid/suggestions/:sid/executed", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const row = await markSuggestionExecuted(cid, req.params.mid as string, req.params.sid as string);
  if (!row) return res.status(404).json({ error: "Suggestion not found" });
  res.json({ message: serializeAssistantMessage(row) });
});

// ───────────────────────────── grants ─────────────────────────────

async function hydrateGrants(grants: EmployeeMailAccountGrant[]): Promise<unknown[]> {
  const employees = await employeesById(grants.map((g) => g.employeeId));
  return grants.map((g) => {
    const emp = employees.get(g.employeeId);
    return {
      id: g.id,
      employeeId: g.employeeId,
      accessLevel: g.accessLevel,
      createdAt: g.createdAt.toISOString(),
      employee: emp
        ? { id: emp.id, name: emp.name, slug: emp.slug, role: emp.role, avatarKey: emp.avatarKey }
        : null,
    };
  });
}

mailRouter.get("/mail/accounts/:aid/grants", async (req, res) => {
  const account = await loadAccount(
    (req.params as Record<string, string>).cid,
    req.params.aid as string,
  );
  if (!account) return res.status(404).json({ error: "Mail account not found" });
  const grants = await AppDataSource.getRepository(EmployeeMailAccountGrant).find({
    where: { accountId: account.id },
    order: { createdAt: "ASC" },
  });
  res.json({ direct: await hydrateGrants(grants) });
});

const createGrantSchema = z.object({
  employeeId: z.string().uuid(),
  accessLevel: z.enum(["read", "draft", "send"]).default("draft"),
});

mailRouter.post("/mail/accounts/:aid/grants", validateBody(createGrantSchema), async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const account = await loadAccount(cid, req.params.aid as string);
  if (!account) return res.status(404).json({ error: "Mail account not found" });
  const body = req.body as z.infer<typeof createGrantSchema>;
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: body.employeeId,
    companyId: cid,
  });
  if (!employee) return res.status(404).json({ error: "Employee not found" });
  const repo = AppDataSource.getRepository(EmployeeMailAccountGrant);
  let grant = await repo.findOneBy({
    employeeId: employee.id,
    accountId: account.id,
  });
  if (grant) {
    grant.accessLevel = body.accessLevel;
  } else {
    grant = repo.create({
      employeeId: employee.id,
      accountId: account.id,
      accessLevel: body.accessLevel,
    });
  }
  await repo.save(grant);
  await recordAudit({
    companyId: cid,
    actorUserId: req.userId ?? null,
    action: "mail.grant.create",
    targetType: "mail_account",
    targetId: account.id,
    targetLabel: account.address,
    metadata: { employeeId: employee.id, accessLevel: body.accessLevel },
  });
  const [hydrated] = await hydrateGrants([grant]);
  res.json({ grant: hydrated });
});

const patchGrantSchema = z.object({
  accessLevel: z.enum(MAIL_ACCESS_LEVELS as [MailAccessLevel, ...MailAccessLevel[]]),
});

mailRouter.patch(
  "/mail/accounts/:aid/grants/:gid",
  validateBody(patchGrantSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const account = await loadAccount(cid, req.params.aid as string);
    if (!account) return res.status(404).json({ error: "Mail account not found" });
    const repo = AppDataSource.getRepository(EmployeeMailAccountGrant);
    const grant = await repo.findOneBy({
      id: req.params.gid as string,
      accountId: account.id,
    });
    if (!grant) return res.status(404).json({ error: "Grant not found" });
    grant.accessLevel = (req.body as z.infer<typeof patchGrantSchema>).accessLevel;
    await repo.save(grant);
    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "mail.grant.update",
      targetType: "mail_account",
      targetId: account.id,
      targetLabel: account.address,
      metadata: { employeeId: grant.employeeId, accessLevel: grant.accessLevel },
    });
    const [hydrated] = await hydrateGrants([grant]);
    res.json({ grant: hydrated });
  },
);

mailRouter.delete("/mail/accounts/:aid/grants/:gid", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const account = await loadAccount(cid, req.params.aid as string);
  if (!account) return res.status(404).json({ error: "Mail account not found" });
  const repo = AppDataSource.getRepository(EmployeeMailAccountGrant);
  const grant = await repo.findOneBy({
    id: req.params.gid as string,
    accountId: account.id,
  });
  if (!grant) return res.status(404).json({ error: "Grant not found" });
  await repo.delete({ id: grant.id });
  await recordAudit({
    companyId: cid,
    actorUserId: req.userId ?? null,
    action: "mail.grant.delete",
    targetType: "mail_account",
    targetId: account.id,
    targetLabel: account.address,
    metadata: { employeeId: grant.employeeId },
  });
  res.json({ ok: true });
});

mailRouter.get("/mail/accounts/:aid/grant-candidates", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const account = await loadAccount(cid, req.params.aid as string);
  if (!account) return res.status(404).json({ error: "Mail account not found" });
  const employees = await AppDataSource.getRepository(AIEmployee).find({
    where: { companyId: cid },
    order: { name: "ASC" },
  });
  const grants = await AppDataSource.getRepository(EmployeeMailAccountGrant).find({
    where: { accountId: account.id },
  });
  const granted = new Set(grants.map((g) => g.employeeId));
  res.json({
    candidates: employees.map((e) => ({
      id: e.id,
      name: e.name,
      slug: e.slug,
      role: e.role,
      avatarKey: e.avatarKey,
      alreadyGranted: granted.has(e.id),
    })),
  });
});

// ───────────────────────── AI analysis of inbound mail ─────────────────────────
//
// Analysis itself runs off the inbound automation queue — see
// `services/mail/analysis.ts`. These routes are the human side of it: the
// mailbox setting, a manual re-read, and pressing one of the buttons. A
// button always executes with the Member's own authority through the ordinary
// services, never with the analysing employee's.

async function loadAnalysis(
  cid: string,
  analysisId: string,
): Promise<{ analysis: MailInboundAnalysis; account: MailAccount } | null> {
  const analysis = await AppDataSource.getRepository(MailInboundAnalysis).findOneBy({
    id: analysisId,
    companyId: cid,
  });
  if (!analysis) return null;
  const account = await loadAccount(cid, analysis.accountId);
  if (!account) return null;
  return { analysis, account };
}

/**
 * The mailbox's triage setting, plus everything the pickers need and — the
 * part a Member actually wants — who would read the next email that arrives.
 * A setting page that shows a toggle but not its consequence is how "it's on,
 * why is nothing happening?" happens.
 */
mailRouter.get("/mail/accounts/:aid/ai-analysis", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const account = await loadAccount(cid, req.params.aid as string);
  if (!account) return res.status(404).json({ error: "Mail account not found" });
  const [roster, reader] = await Promise.all([
    assistantRoster(cid, account.id),
    resolveAnalysisReader(account),
  ]);
  res.json({
    enabled: account.aiAnalysisEnabled,
    employeeId: account.aiAnalysisEmployeeId,
    modelId: account.aiAnalysisModelId,
    roster,
    resolved: reader
      ? {
          employeeId: reader.employee.id,
          employeeName: reader.employee.name,
          modelId: reader.model.id,
          modelLabel: reader.model.model,
          accessLevel: reader.accessLevel,
        }
      : null,
  });
});

const aiAnalysisSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    employeeId: z.string().uuid().nullable().optional(),
    modelId: z.string().uuid().nullable().optional(),
  })
  .strict();

mailRouter.patch(
  "/mail/accounts/:aid/ai-analysis",
  validateBody(aiAnalysisSettingsSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const account = await loadAccount(cid, req.params.aid as string);
    if (!account) return res.status(404).json({ error: "Mail account not found" });
    const body = req.body as z.infer<typeof aiAnalysisSettingsSchema>;

    if (body.employeeId) {
      const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
        id: body.employeeId,
        companyId: cid,
      });
      if (!employee) return res.status(400).json({ error: "Unknown AI Employee" });
      const grant = await AppDataSource.getRepository(EmployeeMailAccountGrant).findOneBy({
        employeeId: employee.id,
        accountId: account.id,
      });
      if (!grant) {
        return res.status(400).json({
          error: `${employee.name} has no access to ${account.address}. Grant it under AI access first.`,
        });
      }
    }
    // A pinned model must belong to whoever will actually be reading — the
    // employee named in this same request when there is one, otherwise the
    // one already on the row. Otherwise the pin is dead on arrival and the
    // read quietly falls back to a different brain than the picker shows.
    const modelOwnerId =
      body.employeeId !== undefined ? body.employeeId : account.aiAnalysisEmployeeId;
    if (body.modelId) {
      if (!modelOwnerId) {
        return res
          .status(400)
          .json({ error: "Choose an AI Employee before pinning one of their models." });
      }
      const model = await AppDataSource.getRepository(AIModel).findOneBy({
        id: body.modelId,
        employeeId: modelOwnerId,
      });
      if (!model) return res.status(400).json({ error: "That AI Model is not this employee's" });
    }

    if (body.enabled !== undefined) account.aiAnalysisEnabled = body.enabled;
    if (body.employeeId !== undefined) {
      account.aiAnalysisEmployeeId = body.employeeId;
      // Changing who reads orphans a pin aimed at the previous employee.
      if (body.modelId === undefined) account.aiAnalysisModelId = null;
    }
    if (body.modelId !== undefined) account.aiAnalysisModelId = body.modelId;
    await AppDataSource.getRepository(MailAccount).save(account);

    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "mail.analysis.settings",
      targetType: "mail_account",
      targetId: account.id,
      targetLabel: account.address,
      metadata: {
        enabled: account.aiAnalysisEnabled,
        employeeId: account.aiAnalysisEmployeeId,
        modelId: account.aiAnalysisModelId,
      },
    });
    const reader = await resolveAnalysisReader(account);
    res.json({
      account: serializeMailAccount(account),
      resolved: reader
        ? {
            employeeId: reader.employee.id,
            employeeName: reader.employee.name,
            modelId: reader.model.id,
            modelLabel: reader.model.model,
            accessLevel: reader.accessLevel,
          }
        : null,
    });
  },
);

/**
 * Read this message again on demand — after a model outage, after granting an
 * employee access, or simply because the first verdict was wrong. Re-analysis
 * replaces the row rather than adding a second set of buttons under the same
 * email, which is why the entity keys on `messageId`.
 */
// Browser session only, like every other mail route that starts model work:
// an API key scoped to the company should not be able to spend a mailbox's
// model budget on demand by asking for re-reads.
mailRouter.post("/mail/messages/:mid/analyze", requireBrowserSession, async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const message = await AppDataSource.getRepository(MailMessage).findOneBy({
    id: req.params.mid as string,
    companyId: cid,
  });
  if (!message) return res.status(404).json({ error: "Message not found" });
  const account = await loadAccount(cid, message.accountId);
  if (!account) return res.status(404).json({ error: "Mail account not found" });
  if (!account.aiAnalysisEnabled) {
    return res
      .status(409)
      .json({ error: "AI analysis is off for this mailbox. Turn it on in Email settings." });
  }
  const reader = await resolveAnalysisReader(account);
  if (!reader) {
    return res.status(409).json({
      error:
        "No AI Employee with a connected model has access to this mailbox. Grant one under AI access.",
    });
  }
  try {
    const analysis = await analyzeInboundMessage(account, message);
    if (!analysis) {
      return res.status(409).json({ error: "This message cannot be analysed." });
    }
    res.json({ analysis: serializeAnalysis(analysis) });
  } catch (err) {
    if (err instanceof MailAnalysisAlreadyActed) {
      return res.status(409).json({ error: err.message });
    }
    throw err;
  }
});

mailRouter.post("/mail/analyses/:id/actions/:actionId", requireBrowserSession, async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const found = await loadAnalysis(cid, req.params.id as string);
  if (!found) return res.status(404).json({ error: "Analysis not found" });
  try {
    const result = await executeAnalysisAction(
      found.account,
      found.analysis,
      req.params.actionId as string,
      {
        userId: req.userId!,
        sessionVersion: req.session!.sessionVersion!,
        financeAccess: effectiveFinanceAccess(req),
      },
    );
    res.json({
      analysis: serializeAnalysis(result.analysis),
      navigateTo: result.navigateTo,
      message: result.message,
    });
  } catch (err) {
    // Both a refused button (`MailAnalysisActionError`) and a downstream
    // failure (Gmail, the finance ledger) are the Member's to see and retry,
    // so both answer 400 with the real reason rather than a 500.
    res.status(400).json({
      error: err instanceof Error ? err.message : "The action could not be completed",
    });
  }
});
