import { In } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { AIModel } from "../../db/entities/AIModel.js";
import {
  EmployeeMailAccountGrant,
  MAIL_ACCESS_RANK,
  type MailAccessLevel,
} from "../../db/entities/EmployeeMailAccountGrant.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailChatMessage } from "../../db/entities/MailChatMessage.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { streamChatWithEmployee } from "../chat.js";
import { captureTurnActions, parseActions } from "../turnActions.js";
import { columnHasLabel } from "./store.js";

/**
 * The per-email AI chat panel that sits beside an opened mail thread.
 *
 * Every mail thread owns an independent conversation. The human @-tags any AI employee
 * (`@slug`) to address them; the target is sticky across turns until another
 * employee is tagged. Each turn runs through the ordinary chat seam, so the
 * employee brings its Soul / Memory / Skills and the grant-gated `mail`
 * tools — plus a briefing about the panel and the thread the human is
 * looking at right now.
 *
 * Turns come back with two kinds of structure besides prose:
 *  - `actions`      — what the employee actually did (from AuditEvents);
 *  - `suggestions`  — one-click buttons it proposed via `suggest_mail_actions`,
 *                     executed client-side through the human routes.
 */

/** Same shape the workspace chat uses to find `@slug` tokens. */
const MENTION_RE = /(^|[\s(])@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)/gi;

/** Prior turns replayed to the employee. Same cap as employee chat. */
const MAX_REPLAY_TURNS = 20;
/** Keep the injected thread context bounded. */
const CONTEXT_MESSAGE_CHARS_CAP = 4_000;
const CONTEXT_TRANSCRIPT_CHARS_CAP = 16_000;

export type MailSuggestionRecord = {
  id: string;
  kind: string;
  label: string;
  executedAt?: string;
  [key: string]: unknown;
};

export function parseSuggestions(raw: string | null | undefined): MailSuggestionRecord[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (x): x is MailSuggestionRecord =>
        !!x &&
        typeof x === "object" &&
        typeof (x as MailSuggestionRecord).id === "string" &&
        typeof (x as MailSuggestionRecord).kind === "string" &&
        typeof (x as MailSuggestionRecord).label === "string",
    );
  } catch {
    return [];
  }
}

export function serializeAssistantMessage(m: MailChatMessage) {
  return {
    id: m.id,
    accountId: m.accountId,
    threadId: m.threadId,
    role: m.role,
    employeeId: m.employeeId,
    content: m.content,
    status: m.status,
    actions: parseActions(m.actionsJson),
    suggestions: parseSuggestions(m.suggestionsJson),
    createdAt: m.createdAt,
  };
}

export async function listAssistantMessages(
  account: MailAccount,
  threadId: string,
  limit: number,
): Promise<MailChatMessage[]> {
  const rows = await AppDataSource.getRepository(MailChatMessage).find({
    where: { accountId: account.id, threadId },
    order: { createdAt: "DESC" },
    take: limit,
  });
  return rows.reverse();
}

export async function clearAssistantMessages(
  account: MailAccount,
  threadId: string,
): Promise<void> {
  await AppDataSource.getRepository(MailChatMessage).delete({
    accountId: account.id,
    threadId,
  });
}

export type AssistantRosterEntry = {
  id: string;
  name: string;
  slug: string;
  role: string;
  avatarKey: string | null;
  accessLevel: MailAccessLevel | null;
  hasModel: boolean;
};

/**
 * Everyone the panel can @-tag: every AI employee in the company, annotated
 * with their grant level on this mailbox (null = no access) and whether they
 * have a connected model. The client uses this for the mention picker and
 * for honest affordances — a grayed-out entry beats a confusing turn.
 */
export async function assistantRoster(
  companyId: string,
  accountId: string,
): Promise<AssistantRosterEntry[]> {
  const employees = await AppDataSource.getRepository(AIEmployee).find({
    where: { companyId },
    order: { name: "ASC" },
  });
  if (employees.length === 0) return [];
  const ids = employees.map((e) => e.id);
  const grants = await AppDataSource.getRepository(EmployeeMailAccountGrant).find({
    where: { accountId, employeeId: In(ids) },
  });
  // Any model row counts: getActiveModel falls back to the newest row when
  // none is flagged active, so "has a row" is what the chat seam resolves.
  const models = await AppDataSource.getRepository(AIModel).find({
    where: { employeeId: In(ids) },
    select: ["employeeId"],
  });
  const grantByEmp = new Map(grants.map((g) => [g.employeeId, g.accessLevel]));
  const modeled = new Set(models.map((m) => m.employeeId));
  return employees.map((e) => ({
    id: e.id,
    name: e.name,
    slug: e.slug,
    role: e.role,
    avatarKey: e.avatarKey ?? null,
    accessLevel: grantByEmp.get(e.id) ?? null,
    hasModel: modeled.has(e.id),
  }));
}

/**
 * Resolve which employee a turn addresses:
 *   1. an explicit `@slug` mention in the message;
 *   2. the `employeeId` the client sent (its own picker / sticky state);
 *   3. the employee that answered the previous turn (sticky);
 *   4. the most recently granted employee with a model (then any grant).
 * Returns null when nothing resolves — the caller persists an explanatory
 * error turn so the human learns to tag someone.
 */
async function resolveTargetEmployee(
  account: MailAccount,
  threadId: string,
  message: string,
  explicitEmployeeId: string | undefined,
): Promise<AIEmployee | null> {
  const empRepo = AppDataSource.getRepository(AIEmployee);

  const slugs: string[] = [];
  for (const match of message.matchAll(MENTION_RE)) {
    slugs.push(match[2].toLowerCase());
  }
  if (slugs.length > 0) {
    const mentioned = await empRepo.find({
      where: { companyId: account.companyId, slug: In(slugs) },
    });
    // First mentioned slug that resolves wins, in message order.
    for (const slug of slugs) {
      const hit = mentioned.find((e) => e.slug === slug);
      if (hit) return hit;
    }
  }

  if (explicitEmployeeId) {
    const explicit = await empRepo.findOneBy({
      id: explicitEmployeeId,
      companyId: account.companyId,
    });
    if (explicit) return explicit;
  }

  const lastAssistant = await AppDataSource.getRepository(MailChatMessage).findOne({
    where: { accountId: account.id, threadId, role: "assistant" },
    order: { createdAt: "DESC" },
  });
  if (lastAssistant?.employeeId) {
    const sticky = await empRepo.findOneBy({
      id: lastAssistant.employeeId,
      companyId: account.companyId,
    });
    if (sticky) return sticky;
  }

  const grants = await AppDataSource.getRepository(EmployeeMailAccountGrant).find({
    where: { accountId: account.id },
    order: { createdAt: "DESC" },
  });
  if (grants.length > 0) {
    const employeeIds = grants.map((grant) => grant.employeeId);
    const [employees, models] = await Promise.all([
      empRepo.find({
        where: { id: In(employeeIds), companyId: account.companyId },
      }),
      AppDataSource.getRepository(AIModel).find({
        where: { employeeId: In(employeeIds) },
        select: ["employeeId"],
      }),
    ]);
    const employeeById = new Map(employees.map((employee) => [employee.id, employee]));
    const modeled = new Set(models.map((model) => model.employeeId));
    for (const grant of grants) {
      const employee = employeeById.get(grant.employeeId);
      if (employee && modeled.has(employee.id)) return employee;
    }
    return employeeById.get(grants[0].employeeId) ?? null;
  }
  return null;
}

/** The panel briefing appended to the employee's system prompt. */
function assistantBriefing(account: MailAccount, accessLevel: MailAccessLevel | null): string {
  const lines = [
    "",
    "## Per-email AI chat",
    `You are answering inside an AI chat attached to one email thread in the ${account.address} mailbox. The teammate reads your reply beside that email, so keep it tight and act rather than narrate.`,
  ];
  if (accessLevel) {
    // Only describe the ops the grant actually allows — telling a read-level
    // employee to call op "draft" just burns turns on 403s.
    const canDraft = MAIL_ACCESS_RANK[accessLevel] >= MAIL_ACCESS_RANK.draft;
    const ops = canDraft
      ? `op "search"/"get" to read, op "draft" to write drafts${accessLevel === "send" ? ', op "send" to send' : ""}, op "update" to triage (labels, archive, read state)`
      : 'op "search"/"get" to read — your level allows reading only, so route drafting, triage, and sending through the suggestion buttons below instead of calling those ops';
    lines.push(
      `Your access level on this mailbox is "${accessLevel}". Use the \`mail\` tool for real work: ${ops}.`,
      'When the teammate asks you to change an existing draft, fetch the thread, identify the draft message id, and use the `mail` tool op "edit" to update that Gmail draft directly. Do not create a second draft and do not merely describe the rewrite.',
      'End turns that have obvious next steps with the `mail` tool op "suggest" (`suggest_mail_actions`): it renders one-click buttons under your reply that the teammate executes with their own authority. Suggest things beyond your grant there — e.g. propose sending a draft (`send_draft`), triage actions, opening a thread, a handover, or an inbox rule you noticed a pattern for. 1–4 buttons, short imperative labels. Never repeat a button\'s contents in prose.',
    );
  } else {
    lines.push(
      "You have NO grant on this mailbox, so the `mail` tool will refuse it and no thread contents are included above. You can still answer general questions and use your other tools. If the teammate wants you working this inbox, tell them to grant you access under Email → Settings → AI access.",
    );
  }
  return lines.join("\n");
}

/**
 * The per-turn context block prepended to the human's message: which
 * mailbox, and — when the human is looking at a thread and the employee is
 * allowed to read it — the thread transcript, bounded. History replays only
 * the raw human text, so this block never compounds across turns.
 */
async function composeTurnContext(
  account: MailAccount,
  threadId: string,
  focusedMessageId: string | null,
  canRead: boolean,
): Promise<string> {
  const parts: string[] = [];
  parts.push(`[Per-email AI chat context — mailbox: ${account.address}]`);
  const thread = await AppDataSource.getRepository(MailThread).findOneBy({
    id: threadId,
    accountId: account.id,
  });
  if (!thread) {
    parts.push("The email thread is no longer available.");
    return parts.join("\n");
  }
  if (!canRead) {
    parts.push(
      `The teammate is viewing a thread, but you have no read grant on this mailbox so its contents are not shown.`,
    );
    return parts.join("\n");
  }
  parts.push(
    `The teammate is viewing the thread "${thread.subject || "(no subject)"}" — id ${thread.id} (pass as \`threadId\` to the \`mail\` tool).`,
  );
  const messages = await AppDataSource.getRepository(MailMessage).find({
    where: { threadId: thread.id },
    order: { sentAt: "ASC" },
  });
  const visible = messages.filter((m) => !columnHasLabel(m.labelIds, "DRAFT"));
  const drafts = messages.filter((m) => columnHasLabel(m.labelIds, "DRAFT"));

  let budget = CONTEXT_TRANSCRIPT_CHARS_CAP;
  const rendered: string[] = [];
  for (let i = visible.length - 1; i >= 0; i -= 1) {
    const m = visible[i];
    const body = (m.bodyText || m.snippet).slice(0, CONTEXT_MESSAGE_CHARS_CAP);
    const block = [
      `[${i + 1}] From: ${m.fromName ? `${m.fromName} <${m.fromEmail}>` : m.fromEmail}`,
      `    To: ${m.toEmails}${m.ccEmails ? `  Cc: ${m.ccEmails}` : ""}`,
      `    Date: ${m.sentAt ? m.sentAt.toISOString() : "unknown"}`,
      "",
      body,
    ].join("\n");
    if (block.length > budget) {
      rendered.push(`… ${i + 1} earlier message(s) omitted — fetch with the mail tool if needed.`);
      break;
    }
    budget -= block.length;
    rendered.push(block);
  }
  parts.push(rendered.reverse().join("\n\n---\n\n"));
  if (drafts.length > 0) {
    parts.push(
      `There ${drafts.length === 1 ? "is 1 unsent draft" : `are ${drafts.length} unsent drafts`} on this thread: ${drafts
        .map((d) => `messageId ${d.id}`)
        .join(", ")}.`,
    );
  }
  if (focusedMessageId) {
    const focusedDraft = drafts.find((draft) => draft.id === focusedMessageId);
    if (focusedDraft) {
      parts.push(
        `The teammate is currently reviewing draft messageId ${focusedDraft.id}. Treat “this draft” or “this email” in an editing request as that draft.`,
      );
    }
  }
  return parts.join("\n");
}

export type AssistantTurnCallbacks = {
  onUser: (msg: ReturnType<typeof serializeAssistantMessage>) => void;
  onTarget: (employee: { id: string; name: string; slug: string } | null) => void;
  onChunk: (text: string) => void;
  onAssistant: (msg: ReturnType<typeof serializeAssistantMessage>) => void;
};

/**
 * Run one assistant turn end-to-end: persist the human's message, resolve
 * the target employee, run the chat seam with mailbox context, and persist
 * the reply with its captured actions + drained suggestions. Every failure
 * mode still persists an assistant row (status "error"/"skipped") so the
 * conversation reads the same after a reload.
 */
export async function runAssistantTurn(args: {
  account: MailAccount;
  message: string;
  threadId: string;
  focusedMessageId?: string | null;
  employeeId?: string;
  userId: string | null;
  callbacks: AssistantTurnCallbacks;
}): Promise<void> {
  const { account, callbacks } = args;
  const repo = AppDataSource.getRepository(MailChatMessage);

  const userMsg = await repo.save(
    repo.create({
      companyId: account.companyId,
      accountId: account.id,
      threadId: args.threadId,
      role: "user",
      content: args.message,
      status: null,
      createdByUserId: args.userId,
    }),
  );
  callbacks.onUser(serializeAssistantMessage(userMsg));

  const employee = await resolveTargetEmployee(
    account,
    args.threadId,
    args.message,
    args.employeeId,
  );
  callbacks.onTarget(
    employee ? { id: employee.id, name: employee.name, slug: employee.slug } : null,
  );

  const saveAssistant = async (fields: {
    employeeId: string | null;
    content: string;
    status: "ok" | "skipped" | "error";
    actionsJson?: string;
    suggestionsJson?: string;
  }): Promise<MailChatMessage> =>
    repo.save(
      repo.create({
        companyId: account.companyId,
        accountId: account.id,
        threadId: args.threadId,
        role: "assistant",
        employeeId: fields.employeeId,
        content: fields.content,
        status: fields.status,
        actionsJson: fields.actionsJson ?? "",
        suggestionsJson: fields.suggestionsJson ?? "",
        createdByUserId: null,
      }),
    );

  if (!employee) {
    const row = await saveAssistant({
      employeeId: null,
      status: "error",
      content:
        "Tag an AI employee to get started — type `@` and pick who should handle this. Once someone answers, they stay on the conversation until you tag somebody else.",
    });
    callbacks.onAssistant(serializeAssistantMessage(row));
    return;
  }

  const grant = await AppDataSource.getRepository(EmployeeMailAccountGrant).findOneBy({
    employeeId: employee.id,
    accountId: account.id,
  });
  const accessLevel = grant?.accessLevel ?? null;
  const canRead = accessLevel !== null && MAIL_ACCESS_RANK[accessLevel] >= MAIL_ACCESS_RANK.read;

  // Replay the recent per-email history (raw text only — the context block below
  // is rebuilt fresh each turn). Turns answered by a different employee are
  // attributed so the current one doesn't own words it never said.
  const prior = await AppDataSource.getRepository(MailChatMessage).find({
    where: { accountId: account.id, threadId: args.threadId },
    order: { createdAt: "DESC" },
    take: MAX_REPLAY_TURNS + 1,
  });
  const empIds = [...new Set(prior.map((m) => m.employeeId).filter((id): id is string => !!id))];
  const empNames = new Map(
    (empIds.length
      ? await AppDataSource.getRepository(AIEmployee).find({
          where: { id: In(empIds), companyId: account.companyId },
        })
      : []
    ).map((e) => [e.id, e.name]),
  );
  const history = prior
    .filter((m) => m.id !== userMsg.id)
    .reverse()
    .map((m) => {
      // Grant boundary: earlier assistant turns may quote mailbox contents
      // (a granted employee summarizing threads into this panel). Replaying
      // them to an employee with no read grant would leak the mail around
      // the grant, so those turns are withheld — the human's own words
      // still replay, since they are the human's to share.
      if (m.role === "assistant" && !canRead) {
        return {
          role: m.role,
          content:
            "[reply withheld — you have no read access to this mailbox, so earlier assistant replies (which may quote mail) are not shown]",
        };
      }
      return {
        role: m.role,
        content:
          m.role === "assistant" && m.employeeId && m.employeeId !== employee.id
            ? `[${empNames.get(m.employeeId) ?? "Another employee"} answered] ${m.content}`
            : m.content,
      };
    });

  const context = await composeTurnContext(
    account,
    args.threadId,
    args.focusedMessageId ?? null,
    canRead,
  );
  const prompt = `${context}\n\n${args.message}`;

  const turnStart = new Date(Date.now() - 10);
  const result = await streamChatWithEmployee(
    account.companyId,
    employee.id,
    prompt,
    history,
    callbacks.onChunk,
    { extraSystem: assistantBriefing(account, accessLevel) },
  );

  const actions = await captureTurnActions(account.companyId, employee.id, turnStart);
  // The suggest tool accepts any mailbox the employee holds a read grant on;
  // this panel renders and executes buttons for ITS mailbox only, so
  // cross-account suggestions are dropped rather than shown out of context.
  const suggestions = (
    (result.sidecars["mail.suggestions"] ?? []) as MailSuggestionRecord[]
  ).filter((s) => s.accountId === account.id);

  const row = await saveAssistant({
    employeeId: employee.id,
    content: result.reply,
    status: result.status,
    actionsJson: actions.length > 0 ? JSON.stringify(actions) : "",
    suggestionsJson: suggestions.length > 0 ? JSON.stringify(suggestions) : "",
  });
  callbacks.onAssistant(serializeAssistantMessage(row));
}

/**
 * Two clicks on different buttons of the same message race a read-modify-
 * write of the shared suggestionsJson blob — the loser's executedAt stamp
 * would be silently clobbered. Serialize stamps per message with an
 * in-process promise chain (all writes go through this process, same
 * assumption the handover queue makes).
 */
const stampChains = new Map<string, Promise<unknown>>();

/**
 * Stamp a suggestion as executed so its button renders spent after reload —
 * the guard against "did I already click Send?". Returns the refreshed
 * message, or null when the message/suggestion doesn't exist.
 */
export async function markSuggestionExecuted(
  companyId: string,
  messageId: string,
  suggestionId: string,
): Promise<MailChatMessage | null> {
  const prev = stampChains.get(messageId) ?? Promise.resolve();
  const run = prev
    .catch(() => {})
    .then(async () => {
      const repo = AppDataSource.getRepository(MailChatMessage);
      const row = await repo.findOneBy({ id: messageId, companyId });
      if (!row) return null;
      const suggestions = parseSuggestions(row.suggestionsJson);
      const hit = suggestions.find((s) => s.id === suggestionId);
      if (!hit) return null;
      hit.executedAt = new Date().toISOString();
      row.suggestionsJson = JSON.stringify(suggestions);
      await repo.save(row);
      return row;
    });
  stampChains.set(messageId, run);
  void run.finally(() => {
    if (stampChains.get(messageId) === run) stampChains.delete(messageId);
  });
  return run;
}
