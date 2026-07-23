import { Brackets, In, IsNull, LessThan, type SelectQueryBuilder } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import {
  Contact,
  type ContactLifecycleStage,
} from "../../db/entities/Contact.js";
import { Customer } from "../../db/entities/Customer.js";
import { normalizeEmail } from "../../lib/emailAddress.js";

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

  const total = await qb.clone().getCount();

  const rows = await qb
    .addSelect("CASE WHEN c.lastActivityAt IS NULL THEN 1 ELSE 0 END", "nulls_last")
    .orderBy("nulls_last", "ASC")
    .addOrderBy("c.lastActivityAt", "DESC")
    .addOrderBy("c.createdAt", "DESC")
    .skip(offset)
    .take(limit)
    .getMany();

  return { rows: await attachCustomerNames(companyId, rows), total };
}

/** One round-trip for the account names on a page of contacts. */
async function attachCustomerNames(
  companyId: string,
  rows: Contact[],
): Promise<HydratedContact[]> {
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
    Object.assign(r, { customerName: r.customerId ? byId.get(r.customerId) ?? null : null }),
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
  if (patch.ownerId !== undefined) contact.ownerId = patch.ownerId;
  if (patch.ownerEmployeeId !== undefined) contact.ownerEmployeeId = patch.ownerEmployeeId;
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

export async function restoreContact(
  companyId: string,
  id: string,
): Promise<Contact | null> {
  const repo = AppDataSource.getRepository(Contact);
  const contact = await repo.findOneBy({ id, companyId });
  if (!contact) return null;
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
