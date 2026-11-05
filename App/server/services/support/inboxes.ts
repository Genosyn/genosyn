import { In } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { SupportChatWidget } from "../../db/entities/SupportChatWidget.js";
import { SupportInbox } from "../../db/entities/SupportInbox.js";
import { normalizeEmail } from "../../lib/emailAddress.js";
import {
  SUPPORT_LIMITS,
  SUPPORT_MAX_IMPORT_DAYS,
  type SupportAiMode,
} from "../../../shared/support.js";
import { recordAudit } from "../audit.js";
import { emitResourceChange } from "../resourceEvents.js";
import { parseJsonArray, type SupportActor } from "./access.js";
import { serializeChatWidget, widgetForInbox, widgetsForCompany } from "./chatWidgets.js";
import { SupportConflictError, SupportNotFoundError, SupportValidationError } from "./errors.js";
import { matchWatchedAddress, untaggedAddress } from "./mailSignals.js";
import { assertEmployeeInCompany } from "./settings.js";

/**
 * Support inboxes: which mailbox, which addresses on it, and how far its AI
 * Employee goes. Nothing here reads mail; `intake.ts` asks this module which
 * inbox a message belongs to.
 */

export function watchedAddresses(inbox: Pick<SupportInbox, "addressesJson">): string[] {
  return parseJsonArray<unknown>(inbox.addressesJson).filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

export type InboxMatch = { inbox: SupportInbox; matchedAddress: string };

/**
 * The inbox a message addressed to these addresses belongs to. An inbox naming
 * the address always beats a whole-mailbox one; among those, the oldest wins, so
 * adding an inbox never moves mail another was already taking.
 */
export function matchInbox(
  inboxes: readonly SupportInbox[],
  delivered: readonly string[],
  mailboxAddress: string,
): InboxMatch | null {
  const ordered = [...inboxes].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  for (const inbox of ordered) {
    const watched = watchedAddresses(inbox);
    if (watched.length === 0) continue;
    const matched = matchWatchedAddress(watched, delivered);
    if (matched) return { inbox, matchedAddress: matched };
  }
  const everything = ordered.find((inbox) => watchedAddresses(inbox).length === 0);
  return everything ? { inbox: everything, matchedAddress: mailboxAddress.toLowerCase() } : null;
}

export async function activeInboxesFor(accountId: string): Promise<SupportInbox[]> {
  return AppDataSource.getRepository(SupportInbox).find({
    where: { accountId, status: "active" },
  });
}

/** Every address that means "the company wrote this" for one mailbox. */
export async function ownAddressesFor(
  account: Pick<MailAccount, "id" | "address">,
): Promise<string[]> {
  const inboxes = await AppDataSource.getRepository(SupportInbox).find({
    where: { accountId: account.id },
    select: { id: true, addressesJson: true, fromAddress: true },
  });
  const own = new Set<string>(account.address ? [account.address.toLowerCase()] : []);
  for (const inbox of inboxes) {
    for (const address of watchedAddresses(inbox)) own.add(address.toLowerCase());
    if (inbox.fromAddress) own.add(inbox.fromAddress.toLowerCase());
  }
  return [...own];
}

/** The same, from an inbox whose mailbox may have been disconnected. */
export async function ownAddressesForInbox(inbox: SupportInbox): Promise<string[]> {
  const account = await AppDataSource.getRepository(MailAccount).findOneBy({ id: inbox.accountId });
  return ownAddressesFor({ id: inbox.accountId, address: account?.address ?? "" });
}

function cleanAddresses(addresses: readonly string[]): string[] {
  if (addresses.length > SUPPORT_LIMITS.addressesPerInbox) {
    throw new SupportValidationError(
      `Watch at most ${SUPPORT_LIMITS.addressesPerInbox} addresses on one inbox.`,
    );
  }
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const raw of addresses) {
    const value = raw.trim();
    if (!value) continue;
    const address = normalizeEmail(value);
    if (!address) throw new SupportValidationError(`"${value}" is not an email address.`);
    const key = untaggedAddress(address);
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(address);
  }
  return cleaned;
}

/** No two inboxes on one mailbox may take the same mail, or the choice would be arbitrary. */
async function assertNoOverlap(args: {
  accountId: string;
  addresses: readonly string[];
  exceptInboxId?: string;
}): Promise<void> {
  const siblings = (
    await AppDataSource.getRepository(SupportInbox).find({ where: { accountId: args.accountId } })
  ).filter((inbox) => inbox.id !== args.exceptInboxId);
  if (args.addresses.length === 0) {
    const whole = siblings.find((inbox) => watchedAddresses(inbox).length === 0);
    if (whole) {
      throw new SupportConflictError(
        `"${whole.name}" already takes everything sent to this mailbox. Name the addresses this inbox should watch.`,
      );
    }
    return;
  }
  const wanted = new Set(args.addresses.map(untaggedAddress));
  for (const inbox of siblings) {
    const clash = watchedAddresses(inbox).find((address) => wanted.has(untaggedAddress(address)));
    if (clash) throw new SupportConflictError(`"${inbox.name}" already watches ${clash}.`);
  }
}

function cleanFromAddress(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const address = normalizeEmail(trimmed);
  if (!address) throw new SupportValidationError(`"${trimmed}" is not an email address.`);
  return address;
}

async function requireAccount(companyId: string, accountId: string): Promise<MailAccount> {
  const account = await AppDataSource.getRepository(MailAccount).findOneBy({
    id: accountId,
    companyId,
  });
  if (!account) throw new SupportNotFoundError("Mailbox not found");
  return account;
}

function auditInbox(
  actor: SupportActor,
  inbox: Pick<SupportInbox, "id" | "companyId" | "name">,
  action: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  return recordAudit({
    companyId: inbox.companyId,
    actorKind: actor.kind === "user" ? "user" : actor.kind === "ai" ? "ai" : "system",
    actorUserId: actor.kind === "user" ? actor.userId : null,
    actorEmployeeId: actor.kind === "ai" ? actor.employeeId : null,
    action: `support_inbox.${action}`,
    targetType: "support_inbox",
    targetId: inbox.id,
    targetLabel: inbox.name,
    metadata,
  });
}

export type CreateInboxInput = {
  accountId: string;
  name: string;
  addresses: string[];
  fromAddress?: string;
  fromName?: string;
  aiMode?: SupportAiMode;
  aiEmployeeId?: string | null;
  aiInstructions?: string;
  signature?: string;
  acknowledge?: boolean;
  acknowledgementBody?: string | null;
  archiveOnSolve?: boolean;
  autoReplyDailyLimit?: number;
  /** Bring this many days of existing mail in. 0 starts from now. */
  importDays?: number;
};

export async function createInbox(args: {
  companyId: string;
  input: CreateInboxInput;
  actor: SupportActor;
}): Promise<SupportInbox> {
  const { input } = args;
  const account = await requireAccount(args.companyId, input.accountId);
  const addresses = cleanAddresses(input.addresses);
  await assertNoOverlap({ accountId: account.id, addresses });
  if (input.aiEmployeeId) await assertEmployeeInCompany(args.companyId, input.aiEmployeeId);
  const importDays = Math.min(Math.max(input.importDays ?? 0, 0), SUPPORT_MAX_IMPORT_DAYS);
  const repo = AppDataSource.getRepository(SupportInbox);
  const inbox = await repo.save(
    repo.create({
      companyId: args.companyId,
      accountId: account.id,
      name: input.name.trim(),
      addressesJson: JSON.stringify(addresses),
      fromAddress: cleanFromAddress(input.fromAddress ?? ""),
      fromName: (input.fromName ?? "").trim(),
      aiMode: input.aiMode ?? "draft",
      aiEmployeeId: input.aiEmployeeId ?? null,
      aiInstructions: input.aiInstructions ?? "",
      signature: input.signature ?? "",
      acknowledge: input.acknowledge ?? false,
      acknowledgementBody: input.acknowledgementBody ?? null,
      archiveOnSolve: input.archiveOnSolve ?? false,
      autoReplyDailyLimit: input.autoReplyDailyLimit ?? 100,
      watchFrom: new Date(Date.now() - importDays * 24 * 60 * 60_000),
      // Even with nothing to bring in, the pass runs while the mailbox still
      // imports: mail arriving during an import is not yet marked as new.
      importStatus: "pending",
      createdByUserId: args.actor.kind === "user" ? args.actor.userId : null,
    }),
  );
  await auditInbox(args.actor, inbox, "create", { accountId: account.id, addresses });
  const { enqueueSupportJob } = await import("./queue.js");
  await enqueueSupportJob({ companyId: args.companyId, kind: "import", targetId: inbox.id });
  emitResourceChange(args.companyId, "support_inbox", inbox.id, { trigger: false });
  return inbox;
}

export type UpdateInboxInput = Partial<Omit<CreateInboxInput, "importDays">> & {
  status?: "active" | "paused";
};

export async function requireInbox(companyId: string, inboxId: string): Promise<SupportInbox> {
  const inbox = await AppDataSource.getRepository(SupportInbox).findOneBy({
    id: inboxId,
    companyId,
  });
  if (!inbox) throw new SupportNotFoundError("Support inbox not found");
  return inbox;
}

export async function updateInbox(args: {
  companyId: string;
  inboxId: string;
  input: UpdateInboxInput;
  actor: SupportActor;
}): Promise<SupportInbox> {
  const inbox = await requireInbox(args.companyId, args.inboxId);
  const { input } = args;
  const fields: Partial<SupportInbox> = {};
  const accountId = input.accountId ?? inbox.accountId;
  if (input.accountId !== undefined && input.accountId !== inbox.accountId) {
    await requireAccount(args.companyId, input.accountId);
    fields.accountId = input.accountId;
    // A newly attached mailbox starts from now; its history was never asked for.
    fields.watchFrom = new Date();
    fields.importStatus = "pending";
  }
  if (input.addresses !== undefined || fields.accountId) {
    const addresses = cleanAddresses(input.addresses ?? watchedAddresses(inbox));
    await assertNoOverlap({ accountId, addresses, exceptInboxId: inbox.id });
    fields.addressesJson = JSON.stringify(addresses);
  }
  if (input.name !== undefined) fields.name = input.name.trim();
  if (input.fromAddress !== undefined) fields.fromAddress = cleanFromAddress(input.fromAddress);
  if (input.fromName !== undefined) fields.fromName = input.fromName.trim();
  if (input.aiMode !== undefined) fields.aiMode = input.aiMode;
  if (input.aiEmployeeId !== undefined) {
    if (input.aiEmployeeId) await assertEmployeeInCompany(args.companyId, input.aiEmployeeId);
    fields.aiEmployeeId = input.aiEmployeeId;
  }
  if (input.aiInstructions !== undefined) fields.aiInstructions = input.aiInstructions;
  if (input.signature !== undefined) fields.signature = input.signature;
  if (input.acknowledge !== undefined) fields.acknowledge = input.acknowledge;
  if (input.acknowledgementBody !== undefined) {
    fields.acknowledgementBody = input.acknowledgementBody;
  }
  if (input.archiveOnSolve !== undefined) fields.archiveOnSolve = input.archiveOnSolve;
  if (input.autoReplyDailyLimit !== undefined) {
    fields.autoReplyDailyLimit = input.autoReplyDailyLimit;
  }
  if (input.status !== undefined) fields.status = input.status;
  if (Object.keys(fields).length > 0) {
    await AppDataSource.getRepository(SupportInbox).update({ id: inbox.id }, fields);
    await auditInbox(args.actor, inbox, "update", { fields: Object.keys(fields) });
    emitResourceChange(args.companyId, "support_inbox", inbox.id, { trigger: false });
    if (fields.importStatus === "pending") {
      const { enqueueSupportJob } = await import("./queue.js");
      await enqueueSupportJob({ companyId: args.companyId, kind: "import", targetId: inbox.id });
    }
  }
  return requireInbox(args.companyId, inbox.id);
}

/** Tickets stay: they are what customers asked, whether or not the mailbox does. */
export async function deleteInbox(args: {
  companyId: string;
  inboxId: string;
  actor: SupportActor;
}): Promise<void> {
  const inbox = await requireInbox(args.companyId, args.inboxId);
  await AppDataSource.getRepository(SupportInbox).delete({ id: inbox.id });
  // Its visitors' tokens answer to the widget, so they stop opening anything too.
  await AppDataSource.getRepository(SupportChatWidget).delete({
    inboxId: inbox.id,
    companyId: args.companyId,
  });
  const { cancelSupportJobs } = await import("./queue.js");
  await cancelSupportJobs({ companyId: args.companyId, kind: "import", targetId: inbox.id });
  await auditInbox(args.actor, inbox, "delete");
  emitResourceChange(args.companyId, "support_inbox", inbox.id, { trigger: false });
}

/** Bring more history in after the fact: moving the window back runs the import again. */
export async function requestInboxImport(args: {
  companyId: string;
  inboxId: string;
  days: number;
  actor: SupportActor;
}): Promise<SupportInbox> {
  const inbox = await requireInbox(args.companyId, args.inboxId);
  const days = Math.min(Math.max(args.days, 1), SUPPORT_MAX_IMPORT_DAYS);
  const from = new Date(Date.now() - days * 24 * 60 * 60_000);
  await AppDataSource.getRepository(SupportInbox).update(
    { id: inbox.id },
    {
      watchFrom: from < inbox.watchFrom ? from : inbox.watchFrom,
      importStatus: "pending",
    },
  );
  await auditInbox(args.actor, inbox, "import", { days });
  const { enqueueSupportJob } = await import("./queue.js");
  await enqueueSupportJob({ companyId: args.companyId, kind: "import", targetId: inbox.id });
  emitResourceChange(args.companyId, "support_inbox", inbox.id, { trigger: false });
  return requireInbox(args.companyId, inbox.id);
}

export type InboxView = ReturnType<typeof serializeInbox>;

export function serializeInbox(
  inbox: SupportInbox,
  account: MailAccount | null,
  stats?: { openTickets: number; autoRepliesToday: number },
  widget: SupportChatWidget | null = null,
) {
  return {
    id: inbox.id,
    name: inbox.name,
    status: inbox.status,
    accountId: inbox.accountId,
    mailbox: account
      ? {
          id: account.id,
          address: account.address,
          provider: account.provider,
          status: account.status,
          statusMessage: account.statusMessage,
          lastSyncAt: account.lastSyncAt?.toISOString() ?? null,
          importing: !account.backfilledAt,
        }
      : null,
    addresses: watchedAddresses(inbox),
    fromAddress: inbox.fromAddress,
    fromName: inbox.fromName,
    aiMode: inbox.aiMode,
    aiEmployeeId: inbox.aiEmployeeId,
    aiInstructions: inbox.aiInstructions,
    autoReplyDailyLimit: inbox.autoReplyDailyLimit,
    signature: inbox.signature,
    acknowledge: inbox.acknowledge,
    acknowledgementBody: inbox.acknowledgementBody,
    archiveOnSolve: inbox.archiveOnSolve,
    watchFrom: inbox.watchFrom.toISOString(),
    importStatus: inbox.importStatus,
    importedCount: inbox.importedCount,
    createdAt: inbox.createdAt.toISOString(),
    openTickets: stats?.openTickets ?? 0,
    autoRepliesToday: stats?.autoRepliesToday ?? 0,
    chatWidget: serializeChatWidget(widget),
  };
}

/** One inbox as the Settings page reads it. */
export async function inboxWithWidget(inbox: SupportInbox): Promise<InboxView> {
  const account = await AppDataSource.getRepository(MailAccount).findOneBy({ id: inbox.accountId });
  return serializeInbox(
    inbox,
    account,
    undefined,
    await widgetForInbox(inbox.companyId, inbox.id),
  );
}

export async function listInboxes(companyId: string): Promise<InboxView[]> {
  const inboxes = await AppDataSource.getRepository(SupportInbox).find({
    where: { companyId },
    order: { createdAt: "ASC" },
  });
  if (inboxes.length === 0) return [];
  const accounts = await AppDataSource.getRepository(MailAccount).find({
    where: { id: In([...new Set(inboxes.map((inbox) => inbox.accountId))]) },
  });
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const widgets = new Map(
    (await widgetsForCompany(companyId)).map((widget) => [widget.inboxId, widget]),
  );
  const { countOpenTicketsByInbox, countAutoRepliesToday } = await import("./tickets.js");
  const open = await countOpenTicketsByInbox(companyId);
  const views: InboxView[] = [];
  for (const inbox of inboxes) {
    views.push(
      serializeInbox(
        inbox,
        accountById.get(inbox.accountId) ?? null,
        {
          openTickets: open.get(inbox.id) ?? 0,
          autoRepliesToday: inbox.aiMode === "auto" ? await countAutoRepliesToday(inbox.id) : 0,
        },
        widgets.get(inbox.id) ?? null,
      ),
    );
  }
  return views;
}
