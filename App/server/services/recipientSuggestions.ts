import { In, IsNull } from "typeorm";
import { z } from "zod";

import { AppDataSource } from "../db/datasource.js";
import { Activity } from "../db/entities/Activity.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Contact } from "../db/entities/Contact.js";
import type { Customer } from "../db/entities/Customer.js";
import { CustomerContact } from "../db/entities/CustomerContact.js";
import { Deal } from "../db/entities/Deal.js";
import { DealContact } from "../db/entities/DealContact.js";
import { Estimate } from "../db/entities/Estimate.js";
import { Invoice } from "../db/entities/Invoice.js";
import { Suppression } from "../db/entities/Suppression.js";
import { normalizeEmail } from "../lib/emailAddress.js";
import { searchableDomain } from "./customerMail.js";
import { sendActions } from "./documentRevisions.js";
import { addressInDomain } from "./mail/addressIndex.js";
import { companyDomains } from "./meetings/domains.js";

/**
 * The people a Member may want on an invoice or estimate email, offered in
 * the send dialog so they are added with one click instead of typed from
 * memory.
 *
 * Who counts as the customer's people, strongest tie first:
 *
 *   - the customer's billing email, the address documents go to by default;
 *   - its billing contacts (`CustomerContact`);
 *   - Revenue Contacts linked to the account (`Contact.customerId`);
 *   - Revenue Contacts on the account's Deals — the primary contact and the
 *     buying committee (`DealContact`);
 *   - Revenue Contacts at the account's **domain**, subdomains included —
 *     never a free-mail domain such as gmail.com, nor one of the company's own
 *     domains, which would sweep in every Gmail user or every colleague. That
 *     is the rule the customer's Emails tab already matches mail by
 *     (`searchableDomain`).
 *
 * Nobody is suggested whom the company must not email: archived Contacts are
 * left out, and so is any address a Contact marked Do not contact carries or
 * the suppression list holds. Suggestions are only ever offered; nothing here
 * adds anyone to an email.
 *
 * **Ranking.** Billing and finance people come first — the billing email,
 * anyone whose role, title or mailbox reads as billing (`isBillingRole`,
 * `isBillingMailbox`), and the primary contact — then everyone the company has
 * emailed, most recently first, then the rest. "Emailed" is read from rows the
 * server already wrote: the To and Cc of this customer's delivered invoice and
 * estimate emails, and outbound email Activities with a Revenue Contact.
 *
 * Every read is bounded: by `(companyId, customerId)` for the customer's own
 * rows, by `(dealId)` for the buying committee, by `(companyId, email)` for the
 * blocklists, by `(companyId, targetType, targetId)` for the send history of
 * the customer's latest documents, and by `(contactId, occurredAt)` for the
 * outbound email with its people. The domain match has no index to answer
 * "ends with", so it reads the company's addresses as the Contacts search
 * does — from the `(companyId, email)` index alone, never the rows — and is
 * capped.
 */

/** Why someone is suggested. A merged suggestion lists every reason, strongest first. */
export type RecipientSuggestionSource =
  | "billing_email"
  | "customer_contact"
  | "revenue_contact"
  | "deal"
  | "domain";

export type RecipientSuggestion = {
  /** Lowercased and accepted by the send endpoint's own address check. */
  email: string;
  /** The person's name, or "" when the address is all there is (the billing email). */
  name: string;
  /** Role or job title, from the strongest source that has one. */
  role: string;
  /** The customer's primary billing contact. */
  primary: boolean;
  /** The billing email, or a role, title or mailbox that reads as billing or finance. */
  billing: boolean;
  sources: RecipientSuggestionSource[];
  /** The most recently updated Deal they are on, when a Deal is why they are here. */
  dealTitle: string | null;
  /** The last time the company emailed them, as far as its own rows record. */
  lastEmailedAt: string | null;
};

export type RecipientSuggestionList = {
  suggestions: RecipientSuggestion[];
  /** The domain people were matched at, or null when unset, free mail, or the company's own. */
  domain: string | null;
};

export const DEFAULT_RECIPIENT_SUGGESTIONS = 50;
export const MAX_RECIPIENT_SUGGESTIONS = 100;

/** Rows read per source: far past anyone's real account, short of a runaway import. */
const ROWS_PER_SOURCE = 200;
const DEALS_READ = 50;
const DEAL_PEOPLE_READ = 500;
/** The latest documents of each kind whose sends say who was emailed. */
const DOCUMENTS_READ = 50;
/** Send rows read per kind of document: a backstop, not a window. */
const SENDS_READ = 1_000;
/** Ids per `In(...)`, well under SQLite's bound-parameter ceiling. */
const ID_CHUNK = 500;

const SOURCE_RANK: Record<RecipientSuggestionSource, number> = {
  billing_email: 0,
  customer_contact: 1,
  revenue_contact: 2,
  deal: 3,
  domain: 4,
};

// ───────────────────────────── pure parts ─────────────────────────────

/**
 * Words that put a role or job title in billing or finance. Deliberately
 * plain: "Accounts payable", "AP clerk", "Finance director", "CFO",
 * "Bookkeeper", "Controller". "Account manager" is sales and does not match;
 * "Accounts" on its own, the department, does.
 */
const BILLING_ROLE_PATTERNS: RegExp[] = [
  /\bbilling\b/i,
  /\binvoic(?:e|es|ing)\b/i,
  /\bfinanc\w*/i,
  /\baccounting\b/i,
  /\baccountants?\b/i,
  /\baccounts?[\s-]+(?:payable|receivable)s?\b/i,
  /\bpayables?\b/i,
  /\breceivables?\b/i,
  /\ba\/?p\b/i,
  /\bbookkeep(?:er|ers|ing)\b/i,
  /\b(?:comptroller|controller)\b/i,
  /\btreasur(?:er|y)\b/i,
  /\bcfo\b/i,
  /^accounts(?:\s+(?:team|department|dept\.?))?$/i,
];

export function isBillingRole(text: string | null | undefined): boolean {
  const value = (text ?? "").trim();
  if (!value) return false;
  return BILLING_ROLE_PATTERNS.some((pattern) => pattern.test(value));
}

/** Shared mailboxes a finance team reads: `ap@`, `billing@`, `accounts.payable@`. */
const BILLING_MAILBOXES = new Set([
  "accounting",
  "accounts",
  "accountspayable",
  "ap",
  "billing",
  "billings",
  "bookkeeping",
  "cfo",
  "finance",
  "invoice",
  "invoices",
  "invoicing",
  "payable",
  "payables",
  "payment",
  "payments",
  "remittance",
  "remittances",
  "treasury",
]);

export function isBillingMailbox(email: string): boolean {
  const at = email.indexOf("@");
  if (at <= 0) return false;
  const local = email.slice(0, at).toLowerCase().split("+")[0];
  const words = local.split(/[._-]+/).filter(Boolean);
  return BILLING_MAILBOXES.has(words.join("")) || words.some((word) => BILLING_MAILBOXES.has(word));
}

const sendableEmail = z.string().email().max(320);

/**
 * The address as a suggestion offers it, or null when the send endpoint would
 * refuse it — a suggestion that could not be sent to is worse than none.
 */
export function suggestionAddress(raw: string | null | undefined): string | null {
  const address = normalizeEmail(raw);
  if (!address) return null;
  return sendableEmail.safeParse(address).success ? address : null;
}

/** One person, from one source, before people are merged. */
export type RecipientCandidate = {
  email: string;
  name: string;
  role: string;
  source: RecipientSuggestionSource;
  primary?: boolean;
  dealTitle?: string | null;
};

/**
 * One suggestion per address. The strongest source names the person and
 * gives the role; every source is kept as a reason; anyone found billing by
 * any of their roles, or by their mailbox, is billing.
 */
export function mergeCandidates(
  candidates: RecipientCandidate[],
  lastEmailed: ReadonlyMap<string, Date> = new Map(),
): RecipientSuggestion[] {
  const strongestFirst = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort(
      (a, b) =>
        SOURCE_RANK[a.candidate.source] - SOURCE_RANK[b.candidate.source] || a.index - b.index,
    )
    .map(({ candidate }) => candidate);

  const merged = new Map<string, RecipientSuggestion>();
  const roles = new Map<string, string[]>();
  for (const candidate of strongestFirst) {
    const email = suggestionAddress(candidate.email);
    if (!email) continue;
    const name = candidate.name.trim();
    const role = candidate.role.trim();
    const seen = merged.get(email);
    if (!seen) {
      merged.set(email, {
        email,
        name,
        role,
        primary: Boolean(candidate.primary),
        billing: false,
        sources: [candidate.source],
        dealTitle: candidate.dealTitle?.trim() || null,
        lastEmailedAt: lastEmailed.get(email)?.toISOString() ?? null,
      });
      roles.set(email, role ? [role] : []);
      continue;
    }
    if (!seen.name && name) seen.name = name;
    if (!seen.role && role) seen.role = role;
    if (role) roles.get(email)?.push(role);
    seen.primary ||= Boolean(candidate.primary);
    if (!seen.sources.includes(candidate.source)) seen.sources.push(candidate.source);
    if (!seen.dealTitle && candidate.dealTitle?.trim()) seen.dealTitle = candidate.dealTitle.trim();
  }

  for (const suggestion of merged.values()) {
    suggestion.billing =
      suggestion.sources.includes("billing_email") ||
      isBillingMailbox(suggestion.email) ||
      (roles.get(suggestion.email) ?? []).some(isBillingRole);
  }
  return [...merged.values()];
}

/** 0: billing, finance and the primary contact. 1: emailed before. 2: everyone else. */
export function suggestionTier(suggestion: RecipientSuggestion): 0 | 1 | 2 {
  if (suggestion.billing || suggestion.primary) return 0;
  if (suggestion.lastEmailedAt) return 1;
  return 2;
}

/** Within the first tier: the billing email, then finance people, the primary contact first. */
function billingRank(suggestion: RecipientSuggestion): number {
  if (suggestion.sources.includes("billing_email")) return 0;
  if (suggestion.billing && suggestion.primary) return 1;
  if (suggestion.billing) return 2;
  return 3;
}

function strongestSource(suggestion: RecipientSuggestion): number {
  return Math.min(...suggestion.sources.map((source) => SOURCE_RANK[source]));
}

function emailedAt(suggestion: RecipientSuggestion): number | null {
  if (!suggestion.lastEmailedAt) return null;
  const at = Date.parse(suggestion.lastEmailedAt);
  return Number.isNaN(at) ? null : at;
}

/** Most recently emailed first; never emailed last. */
function byRecency(a: RecipientSuggestion, b: RecipientSuggestion): number {
  const aAt = emailedAt(a);
  const bAt = emailedAt(b);
  if (aAt === bAt) return 0;
  if (aAt === null) return 1;
  if (bAt === null) return -1;
  return bAt - aAt;
}

export function compareSuggestions(a: RecipientSuggestion, b: RecipientSuggestion): number {
  const tier = suggestionTier(a) - suggestionTier(b);
  if (tier !== 0) return tier;
  if (suggestionTier(a) === 0) {
    const billing = billingRank(a) - billingRank(b);
    if (billing !== 0) return billing;
  }
  const recency = byRecency(a, b);
  if (recency !== 0) return recency;
  const source = strongestSource(a) - strongestSource(b);
  if (source !== 0) return source;
  const label = (a.name || a.email).localeCompare(b.name || b.email, undefined, {
    sensitivity: "base",
  });
  return label !== 0 ? label : a.email.localeCompare(b.email);
}

export function rankSuggestions(suggestions: RecipientSuggestion[]): RecipientSuggestion[] {
  return [...suggestions].sort(compareSuggestions);
}

/**
 * The addresses one delivered send went to, read from its audit metadata:
 * Member sends record `status`, To and Cc; AI Employee sends record
 * `sendStatus` and To. A failed or skipped attempt emailed nobody.
 */
export function deliveredAddresses(metadataJson: string): string[] {
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(metadataJson || "{}") as Record<string, unknown>;
  } catch {
    return [];
  }
  if ((meta.status ?? meta.sendStatus) !== "sent") return [];
  const addresses: string[] = [];
  for (const field of [meta.toAddress, meta.ccAddress]) {
    if (typeof field !== "string") continue;
    for (const part of field.split(/[,;]/)) {
      const address = normalizeEmail(part);
      if (address) addresses.push(address);
    }
  }
  return addresses;
}

// ───────────────────────────── reads ─────────────────────────────

function chunked<T>(items: T[]): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += ID_CHUNK) {
    chunks.push(items.slice(start, start + ID_CHUNK));
  }
  return chunks;
}

/** `getRawMany` hands back SQLite datetimes as zone-less UTC strings. */
function rawDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    return new Date(/^\d{4}-\d{2}-\d{2} /.test(value) ? `${value.replace(" ", "T")}Z` : value);
  }
  return null;
}

type ContactRow = Pick<Contact, "id" | "name" | "email" | "title" | "doNotContact">;
const CONTACT_FIELDS: (keyof Contact)[] = ["id", "name", "email", "title", "doNotContact"];

/**
 * The company's live Contacts at `domain` or a subdomain of it. No index
 * answers "ends with", so the match reads the company's addresses — but only
 * from `(companyId, email)` itself, which holds them, rather than fetching
 * every Contact to test it; the few that match are then loaded by address.
 */
async function contactsAtDomain(companyId: string, domain: string): Promise<ContactRow[]> {
  const matched = await AppDataSource.getRepository(Contact)
    .createQueryBuilder("c")
    .select("c.email", "email")
    .where("c.companyId = :companyId", { companyId })
    .andWhere("(c.email LIKE :exact OR c.email LIKE :subdomain)", {
      exact: `%@${domain}`,
      subdomain: `%.${domain}`,
    })
    .limit(ROWS_PER_SOURCE * 2)
    .getRawMany<{ email: string }>();
  // LIKE reads `_` as a wildcard, and a hostname may hold one.
  const emails = [
    ...new Set(matched.map((row) => row.email).filter((email) => addressInDomain(email, domain))),
  ];
  const rows: ContactRow[] = [];
  for (const batch of chunked(emails)) {
    rows.push(
      ...(await AppDataSource.getRepository(Contact).find({
        where: { companyId, email: In(batch), archivedAt: IsNull() },
        select: CONTACT_FIELDS,
        order: { createdAt: "DESC", id: "ASC" },
      })),
    );
  }
  return rows.slice(0, ROWS_PER_SOURCE);
}

/** Everyone on the account's Deals, with the role they play on the most recently updated one. */
async function dealPeople(
  companyId: string,
  customerId: string,
): Promise<Array<{ contactId: string; role: string; dealTitle: string }>> {
  const deals = await AppDataSource.getRepository(Deal).find({
    where: { companyId, customerId, archivedAt: IsNull() },
    select: ["id", "title", "primaryContactId", "updatedAt"],
    order: { updatedAt: "DESC", id: "ASC" },
    take: DEALS_READ,
  });
  if (deals.length === 0) return [];
  const committee = await AppDataSource.getRepository(DealContact).find({
    where: { companyId, dealId: In(deals.map((deal) => deal.id)) },
    select: ["dealId", "contactId", "role", "sortOrder"],
    order: { sortOrder: "ASC", createdAt: "ASC" },
    take: DEAL_PEOPLE_READ,
  });
  const people = new Map<string, { contactId: string; role: string; dealTitle: string }>();
  // Deals are newest first, so the first deal to name someone is the one that says who they are.
  for (const deal of deals) {
    const onDeal = committee.filter((row) => row.dealId === deal.id);
    if (deal.primaryContactId && !people.has(deal.primaryContactId)) {
      const role = onDeal.find((row) => row.contactId === deal.primaryContactId)?.role ?? "";
      people.set(deal.primaryContactId, {
        contactId: deal.primaryContactId,
        role,
        dealTitle: deal.title,
      });
    }
    for (const row of onDeal) {
      if (people.has(row.contactId)) continue;
      people.set(row.contactId, {
        contactId: row.contactId,
        role: row.role,
        dealTitle: deal.title,
      });
    }
  }
  return [...people.values()];
}

/** Addresses nobody may be suggested at: a Contact marked Do not contact, or a suppression. */
async function blockedAddresses(companyId: string, emails: string[]): Promise<Set<string>> {
  const blocked = new Set<string>();
  for (const batch of chunked(emails)) {
    const [doNotContact, suppressed] = await Promise.all([
      AppDataSource.getRepository(Contact).find({
        where: { companyId, email: In(batch), doNotContact: true },
        select: ["email"],
      }),
      AppDataSource.getRepository(Suppression).find({
        where: { companyId, email: In(batch) },
        select: ["email"],
      }),
    ]);
    for (const row of [...doNotContact, ...suppressed]) {
      const address = normalizeEmail(row.email);
      if (address) blocked.add(address);
    }
  }
  return blocked;
}

/**
 * When the company last emailed each address, from what its own rows record:
 * the To and Cc of the customer's delivered invoice and estimate emails, and
 * outbound email Activities with a Revenue Contact.
 */
async function lastEmailedByAddress(
  companyId: string,
  customerId: string,
  contacts: Array<{ id: string; email: string }>,
): Promise<Map<string, Date>> {
  const latest = new Map<string, Date>();
  const note = (address: string, at: Date | null) => {
    if (!at || Number.isNaN(at.getTime())) return;
    const known = latest.get(address);
    if (!known || known < at) latest.set(address, at);
  };

  const [invoices, estimates] = await Promise.all([
    AppDataSource.getRepository(Invoice).find({
      where: { companyId, customerId },
      select: ["id"],
      order: { createdAt: "DESC", id: "ASC" },
      take: DOCUMENTS_READ,
    }),
    AppDataSource.getRepository(Estimate).find({
      where: { companyId, customerId },
      select: ["id"],
      order: { createdAt: "DESC", id: "ASC" },
      take: DOCUMENTS_READ,
    }),
  ]);
  // One record's audit rows are found through `(companyId, targetType,
  // targetId, createdAt)`. No ORDER BY: sorting the matches by date tempts the
  // planner onto `(companyId, createdAt)`, which walks the company's whole log
  // backwards looking for them. A document has a handful of send rows, so the
  // cap is a backstop and which rows are newest is worked out here.
  for (const [kind, documents] of [
    ["invoice", invoices],
    ["estimate", estimates],
  ] as const) {
    if (documents.length === 0) continue;
    const rows = await AppDataSource.getRepository(AuditEvent).find({
      where: {
        companyId,
        targetType: kind,
        targetId: In(documents.map((row) => row.id)),
        action: In(sendActions(kind)),
      },
      select: ["createdAt", "metadataJson"],
      take: SENDS_READ,
    });
    for (const row of rows) {
      for (const address of deliveredAddresses(row.metadataJson)) note(address, row.createdAt);
    }
  }

  // Through `(contactId, occurredAt)`. The company is checked on each group
  // rather than in the WHERE, where `companyId = ?` would steer the planner to
  // `(companyId, kind)` and every outbound email the company ever logged.
  const emailOf = new Map(contacts.map((contact) => [contact.id, contact.email]));
  for (const batch of chunked([...emailOf.keys()])) {
    const rows = await AppDataSource.getRepository(Activity)
      .createQueryBuilder("activity")
      .select("activity.contactId", "contactId")
      .addSelect("activity.companyId", "companyId")
      .addSelect("MAX(activity.occurredAt)", "at")
      .where("activity.contactId IN (:...ids)", { ids: batch })
      .andWhere("activity.kind = :kind", { kind: "email_out" })
      .groupBy("activity.contactId")
      .addGroupBy("activity.companyId")
      .getRawMany<{ contactId: string; companyId: string; at: unknown }>();
    for (const row of rows) {
      if (row.companyId !== companyId) continue;
      const address = normalizeEmail(emailOf.get(row.contactId));
      if (address) note(address, rawDate(row.at));
    }
  }
  return latest;
}

/** The customer's people for its send dialog, best first, at most `limit` of them. */
export async function listRecipientSuggestions(
  companyId: string,
  customer: Customer,
  options: { limit?: number } = {},
): Promise<RecipientSuggestionList> {
  const limit = Math.min(
    Math.max(Math.trunc(options.limit ?? DEFAULT_RECIPIENT_SUGGESTIONS), 1),
    MAX_RECIPIENT_SUGGESTIONS,
  );
  const domain = searchableDomain(customer.domain, await companyDomains(companyId));

  const [billingContacts, linked, onDeals, atDomain] = await Promise.all([
    AppDataSource.getRepository(CustomerContact).find({
      where: { companyId, customerId: customer.id },
      order: { sortOrder: "ASC", createdAt: "ASC", id: "ASC" },
      take: ROWS_PER_SOURCE,
    }),
    AppDataSource.getRepository(Contact).find({
      where: { companyId, customerId: customer.id, archivedAt: IsNull() },
      select: CONTACT_FIELDS,
      order: { createdAt: "ASC", id: "ASC" },
      take: ROWS_PER_SOURCE,
    }),
    dealPeople(companyId, customer.id),
    domain ? contactsAtDomain(companyId, domain) : Promise.resolve([]),
  ]);

  const contactsById = new Map<string, ContactRow>();
  for (const contact of [...linked, ...atDomain]) contactsById.set(contact.id, contact);
  const unread = onDeals.map((row) => row.contactId).filter((id) => !contactsById.has(id));
  for (const batch of chunked(unread)) {
    const rows = await AppDataSource.getRepository(Contact).find({
      where: { companyId, id: In(batch), archivedAt: IsNull() },
      select: CONTACT_FIELDS,
    });
    for (const contact of rows) contactsById.set(contact.id, contact);
  }

  const candidates: RecipientCandidate[] = [];
  if (customer.email) {
    candidates.push({ email: customer.email, name: "", role: "", source: "billing_email" });
  }
  for (const contact of billingContacts) {
    candidates.push({
      email: contact.email,
      name: contact.name,
      role: contact.role,
      source: "customer_contact",
      primary: contact.isPrimary,
    });
  }
  for (const contact of linked) {
    candidates.push({
      email: contact.email,
      name: contact.name,
      role: contact.title,
      source: "revenue_contact",
    });
  }
  for (const person of onDeals) {
    const contact = contactsById.get(person.contactId);
    if (!contact) continue;
    candidates.push({
      email: contact.email,
      name: contact.name,
      role: person.role || contact.title,
      source: "deal",
      dealTitle: person.dealTitle,
    });
  }
  for (const contact of atDomain) {
    candidates.push({
      email: contact.email,
      name: contact.name,
      role: contact.title,
      source: "domain",
    });
  }

  const people = [...contactsById.values()];
  const addresses = [
    ...new Set(
      candidates
        .map((candidate) => suggestionAddress(candidate.email))
        .filter((address): address is string => address !== null),
    ),
  ];
  const [blocked, lastEmailed] = await Promise.all([
    blockedAddresses(companyId, addresses),
    lastEmailedByAddress(
      companyId,
      customer.id,
      people.map((contact) => ({ id: contact.id, email: contact.email })),
    ),
  ]);
  // Do not contact is checked on every address above; the rows already read
  // say it for these people without another lookup.
  for (const contact of people) {
    const address = normalizeEmail(contact.email);
    if (contact.doNotContact && address) blocked.add(address);
  }

  const suggestions = rankSuggestions(
    mergeCandidates(candidates, lastEmailed).filter((suggestion) => !blocked.has(suggestion.email)),
  ).slice(0, limit);
  return { suggestions, domain };
}
