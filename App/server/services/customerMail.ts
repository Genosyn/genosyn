import { In, IsNull } from "typeorm";

import { AppDataSource } from "../db/datasource.js";
import { Contact } from "../db/entities/Contact.js";
import { Customer } from "../db/entities/Customer.js";
import { CustomerContact } from "../db/entities/CustomerContact.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { MailMessage } from "../db/entities/MailMessage.js";
import { MailMessageAddress } from "../db/entities/MailMessageAddress.js";
import { MailThread } from "../db/entities/MailThread.js";
import { normalizeEmail } from "../lib/emailAddress.js";
import {
  addressInDomain,
  baseDomainOf,
  mailAddressIndexPending,
} from "./mail/addressIndex.js";
import { decodeHtmlEntities } from "./mail/gmailClient.js";
import { columnHasLabel } from "./mail/store.js";
import { companyDomains, isFreeMailDomain } from "./meetings/domains.js";
import { normalizeAccountDomain } from "./revenue/accounts.js";

/**
 * Every mail conversation the company has had with one Customer.
 *
 * The Revenue mail link already writes `email_in` / `email_out` Activities,
 * but only for Revenue Contacts that existed when the message synced. A
 * Customer's billing email, its billing contacts, and everyone else at its
 * domain never reach that table, and neither does mail that arrived before
 * the Contact was created. So this reads the address index instead
 * (`services/mail/addressIndex.ts`): a message belongs to the Customer when
 * its From, To, or Cc holds one of the Customer's addresses or an address at
 * its domain, subdomains included.
 *
 * Every read is bounded by an index: addresses by `(companyId, address)`, the
 * domain by `(companyId, baseDomain)`, then the matched messages and threads
 * by primary key. Every Member can read every mailbox (there are no
 * per-mailbox rules for humans), so listing these threads reveals nothing a
 * viewer could not already open in Mail.
 */

export const DEFAULT_CUSTOMER_MAIL_PAGE_SIZE = 25;

/** A Customer with more distinct addresses than this outside its own domain
 * is a data problem, not a mail history. */
const MAX_SEARCH_ADDRESSES = 100;

/** Ids per `In(...)`, well under SQLite's bound-parameter ceiling. */
const ID_CHUNK = 500;

/** People shown per thread; the rest are counted in `peopleTotal`. */
const MAX_PEOPLE_PER_THREAD = 4;

export type CustomerMailPerson = {
  email: string;
  /** Contact name when the address belongs to one, else the sender's display name. */
  name: string;
};

export type CustomerMailThread = {
  id: string;
  accountId: string;
  /** The connected mailbox the conversation lives in. */
  mailboxAddress: string;
  subject: string;
  snippet: string;
  participants: string;
  unread: boolean;
  messageCount: number;
  hasAttachments: boolean;
  lastMessageAt: string | null;
  /** The Customer's people on the thread — why it is listed here. */
  people: CustomerMailPerson[];
  peopleTotal: number;
};

export type CustomerMailPage = {
  threads: CustomerMailThread[];
  total: number;
  limit: number;
  offset: number;
  /** Exact addresses searched, de-duplicated and lowercased. */
  addresses: string[];
  /** The domain searched, or null when unset, free mail, or the company's own. */
  domain: string | null;
  /** Connected mailboxes. Zero means there is no mail to search, not none to find. */
  mailboxCount: number;
  /** Still indexing mail mirrored before the index existed: older threads may be missing. */
  indexing: boolean;
};

/**
 * The domain to match for a Customer, or null when matching it would sweep in
 * mail that is not theirs: a free-mail host would claim every Gmail user, and
 * the company's own domain would claim every internal message.
 */
function searchableDomain(raw: string, ownDomains: Set<string>): string | null {
  const domain = normalizeAccountDomain(raw);
  if (!domain || !domain.includes(".")) return null;
  if (isFreeMailDomain(domain) || ownDomains.has(domain)) return null;
  return domain;
}

/**
 * Batches of ids, yielding to the event loop between them: a Customer with
 * years of mail has thousands of messages, and better-sqlite3 holds the event
 * loop for the whole of each statement.
 */
async function* chunks<T>(items: T[]): AsyncGenerator<T[]> {
  for (let start = 0; start < items.length; start += ID_CHUNK) {
    if (start > 0) await new Promise((resolve) => setImmediate(resolve));
    yield items.slice(start, start + ID_CHUNK);
  }
}

export async function listCustomerMail(
  companyId: string,
  customer: Customer,
  options: { limit?: number; offset?: number } = {},
): Promise<CustomerMailPage> {
  const limit = options.limit ?? DEFAULT_CUSTOMER_MAIL_PAGE_SIZE;
  const offset = options.offset ?? 0;

  const [mailboxes, billingContacts, revenueContacts, ownDomains] = await Promise.all([
    AppDataSource.getRepository(MailAccount).find({
      where: { companyId },
      select: { id: true, address: true },
    }),
    AppDataSource.getRepository(CustomerContact).find({
      where: { companyId, customerId: customer.id },
      select: { id: true, name: true, email: true },
      order: { sortOrder: "ASC", createdAt: "ASC", id: "ASC" },
    }),
    AppDataSource.getRepository(Contact).find({
      where: { companyId, customerId: customer.id, archivedAt: IsNull() },
      select: { id: true, name: true, email: true },
      order: { createdAt: "ASC", id: "ASC" },
    }),
    companyDomains(companyId),
  ]);

  // A mailbox's own address on a Customer would match every message it holds.
  const mailboxAddresses = new Set(
    mailboxes.map((mailbox) => normalizeEmail(mailbox.address)).filter((a): a is string => !!a),
  );
  const domain = searchableDomain(customer.domain, ownDomains);

  const names = new Map<string, string>();
  const addresses: string[] = [];
  const addAddress = (raw: string, name: string) => {
    const address = normalizeEmail(raw);
    if (!address || mailboxAddresses.has(address)) return;
    if (name.trim() && !names.has(address)) names.set(address, name.trim());
    if (!addresses.includes(address)) addresses.push(address);
  };
  addAddress(customer.email, "");
  for (const contact of billingContacts) addAddress(contact.email, contact.name);
  for (const contact of revenueContacts) addAddress(contact.email, contact.name);
  const searched = addresses.slice(0, MAX_SEARCH_ADDRESSES);

  const mailboxIds = mailboxes.map((mailbox) => mailbox.id);
  const empty: CustomerMailPage = {
    threads: [],
    total: 0,
    limit,
    offset,
    addresses: searched,
    domain,
    mailboxCount: mailboxes.length,
    indexing: await mailAddressIndexPending(companyId, mailboxIds),
  };
  if (mailboxes.length === 0 || (searched.length === 0 && !domain)) return empty;

  // The domain lookup already covers every searched address at that domain.
  const outsideDomain = searched.filter((address) => !addressInDomain(address, domain));
  const addressRows = AppDataSource.getRepository(MailMessageAddress);
  const [exact, atDomain] = await Promise.all([
    outsideDomain.length > 0
      ? addressRows.find({
          where: { companyId, address: In(outsideDomain) },
          select: { messageId: true, address: true },
        })
      : Promise.resolve([]),
    domain
      ? addressRows.find({
          where: { companyId, baseDomain: baseDomainOf(domain) },
          select: { messageId: true, address: true },
        })
      : Promise.resolve([]),
  ]);

  // Which of the Customer's addresses each message carries.
  const byMessage = new Map<string, Set<string>>();
  for (const row of [...exact, ...atDomain.filter((r) => addressInDomain(r.address, domain))]) {
    if (mailboxAddresses.has(row.address)) continue;
    const set = byMessage.get(row.messageId) ?? new Set<string>();
    set.add(row.address);
    byMessage.set(row.messageId, set);
  }
  if (byMessage.size === 0) return empty;

  // Group into conversations. A message deleted since it was indexed is
  // simply not found; an unsent draft is not a conversation with anyone yet.
  // Messages and threads are fetched by primary key alone and their company
  // checked here: next to `companyId = ?`, a planner without statistics may
  // prefer the company index and read every row the company has.
  const matches = new Map<string, Map<string, string>>();
  for await (const ids of chunks([...byMessage.keys()])) {
    const messages = await AppDataSource.getRepository(MailMessage).find({
      where: { id: In(ids) },
      select: {
        id: true,
        companyId: true,
        threadId: true,
        gmailDraftId: true,
        fromName: true,
        fromEmail: true,
      },
    });
    for (const message of messages) {
      if (message.companyId !== companyId || message.gmailDraftId) continue;
      const sender = normalizeEmail(message.fromEmail);
      const people = matches.get(message.threadId) ?? new Map<string, string>();
      for (const address of byMessage.get(message.id) ?? []) {
        const name = names.get(address) ?? (address === sender ? message.fromName.trim() : "");
        if (!people.has(address) || (!people.get(address) && name)) people.set(address, name);
      }
      matches.set(message.threadId, people);
    }
  }
  if (matches.size === 0) return empty;

  const threads: MailThread[] = [];
  for await (const ids of chunks([...matches.keys()])) {
    threads.push(
      ...(await AppDataSource.getRepository(MailThread).find({ where: { id: In(ids) } })),
    );
  }

  // Same exclusions as the mailbox's own "All mail" view.
  const visible = threads
    .filter(
      (thread) =>
        thread.companyId === companyId &&
        !columnHasLabel(thread.labelIds, "TRASH") &&
        !columnHasLabel(thread.labelIds, "SPAM"),
    )
    .sort((a, b) => {
      const at = a.lastMessageAt?.getTime() ?? 0;
      const bt = b.lastMessageAt?.getTime() ?? 0;
      return bt - at || b.id.localeCompare(a.id);
    });

  const mailboxById = new Map(mailboxes.map((mailbox) => [mailbox.id, mailbox.address]));
  return {
    ...empty,
    total: visible.length,
    threads: visible.slice(offset, offset + limit).map((thread) => {
      const people = [...(matches.get(thread.id) ?? new Map<string, string>())].map(
        ([email, name]) => ({ email, name }),
      );
      return {
        id: thread.id,
        accountId: thread.accountId,
        mailboxAddress: mailboxById.get(thread.accountId) ?? "",
        subject: thread.subject,
        snippet: decodeHtmlEntities(thread.snippet),
        participants: thread.participants,
        unread: thread.unread,
        messageCount: thread.messageCount,
        hasAttachments: thread.hasAttachments,
        lastMessageAt: thread.lastMessageAt ? thread.lastMessageAt.toISOString() : null,
        people: people.slice(0, MAX_PEOPLE_PER_THREAD),
        peopleTotal: people.length,
      };
    }),
  };
}
