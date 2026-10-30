import { Brackets, In, IsNull, LessThan, type SelectQueryBuilder } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { Contact, type ContactLifecycleStage } from "../../db/entities/Contact.js";
import { Customer } from "../../db/entities/Customer.js";
import { normalizeEmail } from "../../lib/emailAddress.js";
import {
  CURSOR_INVALID,
  decodeCursor,
  filterFingerprint,
  finishPage,
  type KeyedRow,
  type KeysetColumn,
  keysetRows,
  ListCursorError,
  type Page,
  type PageLimits,
  pageLimit,
  type PageRequest,
} from "../listPaging.js";
import { assertRevenueLinks, assertRevenueOwner } from "./integrity.js";
import {
  andWhereCustomFieldMatches,
  type CustomFieldFilter,
  customFieldKey,
  resolveCustomFieldFilter,
} from "./customFields.js";
import { findMergedRecordRedirect } from "./operations.js";

/**
 * Contacts — the person layer of the Revenue section.
 *
 * The one rule worth stating up front: **email is the identity key, and it is
 * enforced here rather than by the database.** The natural constraint is
 * "unique per company when non-empty", which is a partial index and not
 * portable across SQLite and Postgres — and plenty of legitimate contacts have
 * no email at all. So `contacts.email` carries a plain index and every write
 * path in this module goes through {@link findContactByEmail} first.
 *
 * That makes concurrent inserts of the same address theoretically possible.
 * {@link upsertContactByEmail} is written to converge rather than fail if it
 * happens, because the caller that hits it hardest is mail sync, and an import
 * that aborts halfway through somebody's mailbox is far worse than two rows
 * that a later write merges.
 */

export type ContactActor = {
  userId?: string | null;
  employeeId?: string | null;
};

export type ContactInput = {
  name: string;
  email?: string;
  phone?: string;
  title?: string;
  linkedinUrl?: string;
  websiteUrl?: string;
  customerId?: string | null;
  companyName?: string;
  lifecycleStage?: ContactLifecycleStage;
  ownerId?: string | null;
  ownerEmployeeId?: string | null;
  source?: string;
  sourceDetail?: string;
  score?: number;
  notes?: string;
  doNotContact?: boolean;
};

export type ContactListOptions = {
  q?: string;
  lifecycleStage?: ContactLifecycleStage;
  customerId?: string;
  ownerId?: string;
  ownerEmployeeId?: string;
  customFieldKey?: string;
  customFieldValue?: string;
  /** Include archived rows. Default false. */
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
};

/** Contact plus the account name, so a list row does not need an N+1 lookup. */
export type HydratedContact = Contact & {
  customerName: string | null;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function applySearch(qb: SelectQueryBuilder<Contact>, q: string): void {
  const term = `%${q.trim().toLowerCase()}%`;
  qb.andWhere(
    new Brackets((w) => {
      w.where("LOWER(c.name) LIKE :term", { term })
        .orWhere("LOWER(c.email) LIKE :term", { term })
        .orWhere("LOWER(c.companyName) LIKE :term", { term })
        .orWhere("LOWER(c.title) LIKE :term", { term });
    }),
  );
}

/**
 * The custom-field filter a contact list names, looked up once: `undefined`
 * when the list names none, `null` when the company has no such field (the
 * list is then empty, as it always was for an unknown field).
 */
async function contactCustomField(
  companyId: string,
  opts: Pick<ContactListOptions, "customFieldKey" | "customFieldValue">,
): Promise<CustomFieldFilter | null | undefined> {
  if (!opts.customFieldKey || opts.customFieldValue === undefined) return undefined;
  return resolveCustomFieldFilter(companyId, "contact", opts.customFieldKey, opts.customFieldValue);
}

/** Contacts matching the filters, unordered: the shared WHERE of the page and the plain list. */
function contactListQuery(
  companyId: string,
  opts: ContactListOptions,
  customField: CustomFieldFilter | undefined,
): SelectQueryBuilder<Contact> {
  const qb = AppDataSource.getRepository(Contact)
    .createQueryBuilder("c")
    .where("c.companyId = :companyId", { companyId });

  if (!opts.includeArchived) qb.andWhere("c.archivedAt IS NULL");
  if (opts.q) applySearch(qb, opts.q);
  if (opts.lifecycleStage) {
    qb.andWhere("c.lifecycleStage = :stage", { stage: opts.lifecycleStage });
  }
  if (opts.customerId) qb.andWhere("c.customerId = :cid", { cid: opts.customerId });
  if (opts.ownerId) qb.andWhere("c.ownerId = :oid", { oid: opts.ownerId });
  if (opts.ownerEmployeeId) {
    qb.andWhere("c.ownerEmployeeId = :oeid", { oeid: opts.ownerEmployeeId });
  }
  if (customField) andWhereCustomFieldMatches(qb, "c.id", customField);
  return qb;
}

/**
 * List with search + filters, newest activity first.
 *
 * Ordered by `lastActivityAt` rather than `createdAt` because the question a
 * salesperson opens this page to answer is "who have I not spoken to", and a
 * list sorted by when a row was imported answers a question nobody has.
 * NULLs sort last via a computed flag, which is portable; `NULLS LAST` is not.
 */
export async function listContacts(
  companyId: string,
  opts: ContactListOptions = {},
): Promise<{ rows: HydratedContact[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(opts.offset ?? 0, 0);

  const customField = await contactCustomField(companyId, opts);
  if (customField === null) return { rows: [], total: 0 };
  const qb = contactListQuery(companyId, opts, customField);

  const total = await qb.clone().getCount();

  const rows = await qb
    .addSelect("CASE WHEN c.lastActivityAt IS NULL THEN 1 ELSE 0 END", "nulls_last")
    .orderBy("nulls_last", "ASC")
    .addOrderBy("c.lastActivityAt", "DESC")
    .addOrderBy("c.createdAt", "DESC")
    .addOrderBy("c.id", "DESC")
    .skip(offset)
    .take(limit)
    .getMany();

  return { rows: await attachCustomerNames(companyId, rows), total };
}

/** `list_contacts`: 50 a page by default, at most 200. */
export const CONTACT_PAGE: PageLimits = { defaultLimit: DEFAULT_LIMIT, maxLimit: MAX_LIMIT };
/** `search_contacts`: a lookup wants the first few — 25 a page by default, at most 200. */
export const CONTACT_SEARCH_PAGE: PageLimits = { defaultLimit: 25, maxLimit: MAX_LIMIT };

/**
 * The contact list's own order, as two keysets read one after the other:
 * the contacts someone has spoken to, most recently touched first, then the
 * ones nobody has, newest first — ties broken by id, exactly `listContacts`'
 * order. Each part is a plain column order the `(companyId, lastActivityAt,
 * createdAt, id)` index walks, so a page reads about as many rows as it
 * shows instead of sorting the company's every contact.
 *
 * The first key is a constant per part: a cursor after a touched contact lets
 * every never-touched one through, and one after a never-touched contact
 * rules every touched one out. The never-touched part holds a constant in
 * place of the touched part's `createdAt`, so both keysets have one shape.
 */
const TOUCHED_KEYS: KeysetColumn[] = [
  { literal: 0, direction: "ASC" },
  { column: "c.lastActivityAt", direction: "DESC", type: "timestamp" },
  { column: "c.createdAt", direction: "DESC", type: "timestamp" },
  { column: "c.id", direction: "DESC", type: "string" },
];
const UNTOUCHED_KEYS: KeysetColumn[] = [
  { literal: 1, direction: "ASC" },
  { column: "c.createdAt", direction: "DESC", type: "timestamp" },
  { literal: 0, direction: "ASC" },
  { column: "c.id", direction: "DESC", type: "string" },
];

const CONTACT_SCOPE = "revenue.contacts";

export type ContactPageRequest = PageRequest & {
  budgetChars?: number;
  /** `list_contacts` 50 / 200 unless said otherwise. */
  limits?: PageLimits;
  /**
   * Rows to skip before the first page, for older Skills that still page by
   * offset. Ignored with a cursor, which already says where to go on.
   */
  offset?: number;
};

/**
 * Contacts in the list's order, one page at a time (`services/listPaging.ts`)
 * — what `list_contacts` and `search_contacts` read. A cursor names the last
 * contact shown, so logging an Activity between pages, which moves that
 * contact to the top, never makes the next page skip or repeat anyone else.
 */
export async function pageContacts<Out>(
  companyId: string,
  filter: Omit<ContactListOptions, "limit" | "offset">,
  page: ContactPageRequest,
  present: (rows: HydratedContact[]) => Out[] | Promise<Out[]>,
): Promise<Page<Out>> {
  const q = filter.q?.trim() ? filter.q.trim().toLowerCase() : undefined;
  const fingerprint = filterFingerprint(companyId, {
    q,
    lifecycleStage: filter.lifecycleStage,
    customerId: filter.customerId,
    ownerId: filter.ownerId,
    ownerEmployeeId: filter.ownerEmployeeId,
    customField:
      filter.customFieldKey && filter.customFieldValue !== undefined
        ? [customFieldKey(filter.customFieldKey), filter.customFieldValue.trim().toLowerCase()]
        : undefined,
    includeArchived: !!filter.includeArchived,
  });
  const after = page.cursor ? decodeCursor(CONTACT_SCOPE, fingerprint, page.cursor) : null;
  if (
    after &&
    (after.length !== 4 ||
      (after[0] !== 0 && after[0] !== 1) ||
      (after[0] === 1 &&
        (typeof after[1] !== "string" || after[2] !== 0 || typeof after[3] !== "string")))
  ) {
    throw new ListCursorError(CURSOR_INVALID);
  }
  const limit = pageLimit(page.limit, page.limits ?? CONTACT_PAGE);
  const customField = await contactCustomField(companyId, filter);
  if (customField === null) return { total: 0, hasMore: false, nextCursor: null, rows: [] };
  const query = () => contactListQuery(companyId, { ...filter, q }, customField);
  // Each part also takes the cursor's first column as a plain bound, which
  // the keyset already implies: the index then starts at the cursor instead
  // of walking every row before it.
  const touched = () => {
    const qb = query().andWhere("c.lastActivityAt IS NOT NULL");
    if (after?.[0] === 0) {
      qb.andWhere("c.lastActivityAt <= :touchedBound", { touchedBound: after[1] });
    }
    return qb;
  };
  const untouched = () => {
    const qb = query().andWhere("c.lastActivityAt IS NULL");
    // Past a never-touched contact, as one row-value range the index answers
    // directly — the keyset's OR form led SQLite to merge two index scans and
    // sort everything after the cursor. A cursor among the touched contacts
    // lets every never-touched one through.
    if (after?.[0] === 1) {
      qb.andWhere("(c.createdAt, c.id) < (:untouchedAt, :untouchedId)", {
        untouchedAt: after[1],
        untouchedId: after[3],
      });
    }
    return qb;
  };

  // An older Skill's offset counts across both parts: skip into the touched
  // contacts, and on into the never-touched ones past their end.
  const offset = !after && page.offset && page.offset > 0 ? page.offset : 0;
  const touchedCount = offset > 0 ? await touched().getCount() : 0;
  const [total, touchedRows] = await Promise.all([
    query().getCount(),
    // A cursor among the never-touched contacts rules every touched one out.
    after?.[0] === 1 || (offset > 0 && offset >= touchedCount)
      ? Promise.resolve([])
      : keysetRows(offset > 0 ? touched().offset(offset) : touched(), {
          keys: TOUCHED_KEYS,
          after,
          limit,
          prefix: "contact",
        }),
  ]);
  // limit + 1 rows say whether a page follows; the never-touched contacts
  // make up whatever the touched ones left short.
  const fetched: KeyedRow<Contact>[] =
    touchedRows.length > limit
      ? touchedRows
      : [
          ...touchedRows,
          ...(await keysetRows(
            offset > touchedCount ? untouched().offset(offset - touchedCount) : untouched(),
            {
              keys: UNTOUCHED_KEYS,
              // `untouched()` already applies the cursor, as a row value.
              after: null,
              limit: limit - touchedRows.length,
              prefix: "contact",
            },
          )),
        ];
  const kept = await attachCustomerNames(
    companyId,
    fetched.slice(0, limit).map((entry) => entry.row),
  );
  const presented = await present(kept);
  const byId = new Map(kept.map((row, index) => [row.id, presented[index]]));
  return finishPage({
    fetched,
    limit,
    total,
    noun: "contacts",
    scope: CONTACT_SCOPE,
    fingerprint,
    present: (row: Contact) => byId.get(row.id)!,
    budgetChars: page.budgetChars,
  });
}

/** One round-trip for the account names on a page of contacts. */
async function attachCustomerNames(companyId: string, rows: Contact[]): Promise<HydratedContact[]> {
  const ids = [...new Set(rows.map((r) => r.customerId).filter((id): id is string => !!id))];
  if (ids.length === 0) {
    return rows.map((r) => Object.assign(r, { customerName: null }));
  }
  const customers = await AppDataSource.getRepository(Customer).find({
    where: { companyId, id: In(ids) },
    select: { id: true, name: true },
  });
  const byId = new Map(customers.map((c) => [c.id, c.name]));
  return rows.map((r) =>
    Object.assign(r, { customerName: r.customerId ? (byId.get(r.customerId) ?? null) : null }),
  );
}

export async function getContact(companyId: string, id: string): Promise<Contact | null> {
  return AppDataSource.getRepository(Contact).findOneBy({ id, companyId });
}

/** Resolve by address. Returns null for an unusable address rather than throwing. */
export async function findContactByEmail(
  companyId: string,
  email: string,
): Promise<Contact | null> {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  return AppDataSource.getRepository(Contact).findOneBy({
    companyId,
    email: normalized,
  });
}

/**
 * Resolve many addresses at once, keyed by normalized address.
 *
 * Mail sync calls this per ingested thread, so it is one query regardless of
 * how many participants a thread has.
 */
export async function findContactsByEmails(
  companyId: string,
  emails: string[],
): Promise<Map<string, Contact>> {
  const normalized = [
    ...new Set(emails.map((e) => normalizeEmail(e)).filter((e): e is string => !!e)),
  ];
  const found = new Map<string, Contact>();
  if (normalized.length === 0) return found;
  const rows = await AppDataSource.getRepository(Contact).find({
    where: { companyId, email: In(normalized) },
  });
  for (const row of rows) found.set(row.email, row);
  return found;
}

export class DuplicateContactError extends Error {
  readonly existingId: string;

  constructor(email: string, existingId: string) {
    super(`A contact with the address ${email} already exists`);
    this.name = "DuplicateContactError";
    this.existingId = existingId;
  }
}

/**
 * Create a contact, refusing a duplicate address.
 *
 * Throws rather than silently merging: a human filling in the new-contact form
 * for somebody who already exists wants to be told, not to have their input
 * quietly discarded into an existing row.
 */
export async function createContact(
  companyId: string,
  input: ContactInput,
  actor: ContactActor = {},
): Promise<Contact> {
  await Promise.all([
    assertRevenueLinks(companyId, { customerId: input.customerId }),
    assertRevenueOwner(companyId, input),
  ]);
  const email = normalizeEmail(input.email ?? "") ?? "";
  if (email) {
    const existing = await findContactByEmail(companyId, email);
    if (existing) throw new DuplicateContactError(email, existing.id);
  }

  const repo = AppDataSource.getRepository(Contact);
  return repo.save(
    repo.create({
      companyId,
      name: input.name.trim(),
      email,
      phone: input.phone ?? "",
      title: input.title ?? "",
      linkedinUrl: input.linkedinUrl ?? "",
      websiteUrl: input.websiteUrl ?? "",
      customerId: input.customerId ?? null,
      companyName: input.companyName ?? "",
      lifecycleStage: input.lifecycleStage ?? "lead",
      ownerId: input.ownerId ?? null,
      ownerEmployeeId: input.ownerEmployeeId ?? null,
      source: input.source ?? "",
      sourceDetail: input.sourceDetail ?? "",
      score: clampScore(input.score),
      notes: input.notes ?? "",
      doNotContact: input.doNotContact ?? false,
      createdById: actor.userId ?? null,
      createdByEmployeeId: actor.employeeId ?? null,
    }),
  );
}

/**
 * Find-or-create by address, for automated callers.
 *
 * Used by mail sync and by signals, where the point is to end up with a row
 * rather than to report a conflict. Only fills fields that are currently empty,
 * so an automated import can never overwrite something a human typed — an
 * inbound email's display name must not clobber a carefully-corrected name.
 */
export async function upsertContactByEmail(
  companyId: string,
  input: ContactInput & { email: string },
  actor: ContactActor = {},
): Promise<Contact | null> {
  await assertRevenueLinks(companyId, { customerId: input.customerId });
  const email = normalizeEmail(input.email);
  if (!email) return null;

  const existing = await findContactByEmail(companyId, email);
  if (existing) {
    let dirty = false;
    if (!existing.name.trim() && input.name?.trim()) {
      existing.name = input.name.trim();
      dirty = true;
    }
    for (const field of ["title", "phone", "companyName", "source"] as const) {
      const incoming = input[field];
      if (!existing[field] && incoming) {
        existing[field] = incoming;
        dirty = true;
      }
    }
    if (!existing.customerId && input.customerId) {
      existing.customerId = input.customerId;
      dirty = true;
    }
    if (!dirty) return existing;
    return AppDataSource.getRepository(Contact).save(existing);
  }

  try {
    return await createContact(companyId, { ...input, email }, actor);
  } catch (err) {
    // Lost a race with a concurrent insert of the same address. Converge on
    // the winner rather than failing an import mid-mailbox.
    if (err instanceof DuplicateContactError) {
      return findContactByEmail(companyId, email);
    }
    throw err;
  }
}

export async function updateContact(
  companyId: string,
  id: string,
  patch: Partial<ContactInput>,
): Promise<Contact | null> {
  const repo = AppDataSource.getRepository(Contact);
  const contact = await repo.findOneBy({ id, companyId });
  if (!contact) return null;
  await Promise.all([
    assertRevenueLinks(companyId, { customerId: patch.customerId }),
    assertRevenueOwner(companyId, patch),
  ]);

  if (patch.email !== undefined) {
    const email = normalizeEmail(patch.email) ?? "";
    if (email && email !== contact.email) {
      const clash = await findContactByEmail(companyId, email);
      if (clash && clash.id !== id) throw new DuplicateContactError(email, clash.id);
    }
    contact.email = email;
  }
  if (patch.name !== undefined) contact.name = patch.name.trim();
  if (patch.phone !== undefined) contact.phone = patch.phone;
  if (patch.title !== undefined) contact.title = patch.title;
  if (patch.linkedinUrl !== undefined) contact.linkedinUrl = patch.linkedinUrl;
  if (patch.websiteUrl !== undefined) contact.websiteUrl = patch.websiteUrl;
  if (patch.customerId !== undefined) contact.customerId = patch.customerId;
  if (patch.companyName !== undefined) contact.companyName = patch.companyName;
  if (patch.lifecycleStage !== undefined) contact.lifecycleStage = patch.lifecycleStage;
  if (patch.ownerId !== undefined) {
    contact.ownerId = patch.ownerId;
    if (patch.ownerId) contact.ownerEmployeeId = null;
  }
  if (patch.ownerEmployeeId !== undefined) {
    contact.ownerEmployeeId = patch.ownerEmployeeId;
    if (patch.ownerEmployeeId) contact.ownerId = null;
  }
  if (patch.source !== undefined) contact.source = patch.source;
  if (patch.sourceDetail !== undefined) contact.sourceDetail = patch.sourceDetail;
  if (patch.score !== undefined) contact.score = clampScore(patch.score);
  if (patch.notes !== undefined) contact.notes = patch.notes;
  if (patch.doNotContact !== undefined) contact.doNotContact = patch.doNotContact;

  return repo.save(contact);
}

/** Soft delete. Archived contacts stay on historical activities and deals. */
export async function archiveContact(
  companyId: string,
  id: string,
  now = new Date(),
): Promise<Contact | null> {
  const repo = AppDataSource.getRepository(Contact);
  const contact = await repo.findOneBy({ id, companyId });
  if (!contact) return null;
  contact.archivedAt = now;
  return repo.save(contact);
}

export async function restoreContact(companyId: string, id: string): Promise<Contact | null> {
  const repo = AppDataSource.getRepository(Contact);
  const contact = await repo.findOneBy({ id, companyId });
  if (!contact) return null;
  const redirect = await findMergedRecordRedirect(companyId, "contact", id);
  if (redirect) {
    throw new Error(
      `Restore blocked: this Contact was merged into ${redirect.targetId}; undo the merge instead`,
    );
  }
  contact.archivedAt = null;
  return repo.save(contact);
}

/**
 * Record that something happened to these contacts.
 *
 * Denormalized onto the row so the list can sort by it. Only moves the value
 * forward — a backfilled two-year-old email must not make a contact look
 * freshly touched.
 */
export async function touchLastActivity(
  companyId: string,
  contactIds: string[],
  when: Date,
): Promise<void> {
  const ids = [...new Set(contactIds.filter(Boolean))];
  if (ids.length === 0) return;
  await AppDataSource.getRepository(Contact)
    .createQueryBuilder()
    .update(Contact)
    .set({ lastActivityAt: when })
    .where("companyId = :companyId", { companyId })
    .andWhere("id IN (:...ids)", { ids })
    .andWhere(
      new Brackets((w) => {
        w.where("lastActivityAt IS NULL").orWhere("lastActivityAt < :when", { when });
      }),
    )
    .execute();
}

/** Mark unsubscribed. Separate from the suppression row: this is the person. */
export async function markContactUnsubscribed(
  companyId: string,
  contactId: string,
  now = new Date(),
): Promise<void> {
  await AppDataSource.getRepository(Contact).update(
    { id: contactId, companyId, unsubscribedAt: IsNull() },
    { unsubscribedAt: now },
  );
}

export async function markContactBounced(
  companyId: string,
  email: string,
  now = new Date(),
): Promise<void> {
  const normalized = normalizeEmail(email);
  if (!normalized) return;
  await AppDataSource.getRepository(Contact).update(
    { companyId, email: normalized },
    { bouncedAt: now },
  );
}

/** Contacts with no activity since `before` — the "who have I neglected" list. */
export async function listStaleContacts(
  companyId: string,
  before: Date,
  limit = 25,
): Promise<Contact[]> {
  return AppDataSource.getRepository(Contact).find({
    where: [
      { companyId, archivedAt: IsNull(), lastActivityAt: LessThan(before) },
      { companyId, archivedAt: IsNull(), lastActivityAt: IsNull() },
    ],
    order: { lastActivityAt: "ASC" },
    take: Math.min(Math.max(limit, 1), MAX_LIMIT),
  });
}

function clampScore(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.round(value), 0), 100);
}
