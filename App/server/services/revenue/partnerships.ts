import { Brackets, In } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { Contact } from "../../db/entities/Contact.js";
import { Partnership } from "../../db/entities/Partnership.js";
import { PartnershipContact } from "../../db/entities/PartnershipContact.js";
import { assertClassification, classificationValue } from "./classifications.js";
import { matchingResourceIds } from "./customFields.js";
import { assertRevenueLinks, assertRevenueOwner } from "./integrity.js";

export type PartnershipWrite = {
  name?: string;
  type?: string;
  status?: string;
  customerId?: string | null;
  websiteUrl?: string;
  integrationContext?: string;
  channelContext?: string;
  notes?: string;
  ownerId?: string | null;
  ownerEmployeeId?: string | null;
  nextFollowUpAt?: Date | null;
  reminderAt?: Date | null;
};

async function applyPartnership(
  companyId: string,
  row: Partnership,
  input: PartnershipWrite,
): Promise<void> {
  if (input.name !== undefined) row.name = input.name.trim();
  if (input.type !== undefined) {
    const value = classificationValue(input.type);
    if (!value) throw new Error("Partnership type is required");
    await assertClassification(companyId, "partnership_type", value);
    row.type = value;
  }
  if (input.status !== undefined) {
    const value = classificationValue(input.status);
    if (!value) throw new Error("Partnership status is required");
    await assertClassification(companyId, "partnership_status", value);
    row.status = value;
  }
  if (input.customerId !== undefined) row.customerId = input.customerId;
  if (input.websiteUrl !== undefined) row.websiteUrl = input.websiteUrl.trim();
  if (input.integrationContext !== undefined) row.integrationContext = input.integrationContext;
  if (input.channelContext !== undefined) row.channelContext = input.channelContext;
  if (input.notes !== undefined) row.notes = input.notes;
  if (input.ownerId !== undefined) {
    row.ownerId = input.ownerId;
    if (input.ownerId) row.ownerEmployeeId = null;
  }
  if (input.ownerEmployeeId !== undefined) {
    row.ownerEmployeeId = input.ownerEmployeeId;
    if (input.ownerEmployeeId) row.ownerId = null;
  }
  if (input.nextFollowUpAt !== undefined) row.nextFollowUpAt = input.nextFollowUpAt;
  if (input.reminderAt !== undefined) row.reminderAt = input.reminderAt;
}

export async function listPartnerships(
  companyId: string,
  opts: {
    q?: string;
    status?: string;
    type?: string;
    customFieldKey?: string;
    customFieldValue?: string;
    includeArchived?: boolean;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ rows: Partnership[]; total: number }> {
  const qb = AppDataSource.getRepository(Partnership)
    .createQueryBuilder("p")
    .where("p.companyId = :companyId", { companyId });
  if (!opts.includeArchived) qb.andWhere("p.archivedAt IS NULL");
  if (opts.q) {
    qb.andWhere(
      new Brackets((where) =>
        where
          .where("LOWER(p.name) LIKE :q", { q: `%${opts.q!.toLowerCase()}%` })
          .orWhere("LOWER(p.notes) LIKE :q", { q: `%${opts.q!.toLowerCase()}%` }),
      ),
    );
  }
  if (opts.status) qb.andWhere("p.status = :status", { status: classificationValue(opts.status) });
  if (opts.type) qb.andWhere("p.type = :type", { type: classificationValue(opts.type) });
  if (opts.customFieldKey && opts.customFieldValue !== undefined) {
    const ids = await matchingResourceIds(
      companyId,
      "partnership",
      opts.customFieldKey,
      opts.customFieldValue,
    );
    if (ids.length === 0) return { rows: [], total: 0 };
    qb.andWhere("p.id IN (:...customIds)", { customIds: ids });
  }
  const total = await qb.clone().getCount();
  const rows = await qb
    .orderBy("p.nextFollowUpAt", "ASC")
    .addOrderBy("p.updatedAt", "DESC")
    .skip(Math.max(opts.offset ?? 0, 0))
    .take(Math.min(Math.max(opts.limit ?? 50, 1), 200))
    .getMany();
  return { rows, total };
}

export async function createPartnership(
  companyId: string,
  input: PartnershipWrite & { name: string },
  actor: { userId?: string | null; employeeId?: string | null } = {},
): Promise<Partnership> {
  await assertRevenueOwner(companyId, input);
  await assertRevenueLinks(companyId, { customerId: input.customerId });
  const repo = AppDataSource.getRepository(Partnership);
  const row = repo.create({
    companyId,
    name: input.name.trim(),
    type: "other",
    status: "prospecting",
    customerId: null,
    websiteUrl: "",
    integrationContext: "",
    channelContext: "",
    notes: "",
    ownerId: null,
    ownerEmployeeId: null,
    nextFollowUpAt: null,
    reminderAt: null,
    lastActivityAt: null,
    archivedAt: null,
    createdById: actor.userId ?? null,
    createdByEmployeeId: actor.employeeId ?? null,
  });
  await applyPartnership(companyId, row, input);
  return repo.save(row);
}

export async function getPartnership(
  companyId: string,
  id: string,
): Promise<{ partnership: Partnership; contacts: Array<PartnershipContact & { contact: Contact }> } | null> {
  const partnership = await AppDataSource.getRepository(Partnership).findOneBy({ companyId, id });
  if (!partnership) return null;
  const links = await AppDataSource.getRepository(PartnershipContact).find({
    where: { companyId, partnershipId: id },
    order: { isPrimary: "DESC", sortOrder: "ASC" },
  });
  const contacts = links.length
    ? await AppDataSource.getRepository(Contact).find({
        where: { companyId, id: In(links.map((link) => link.contactId)) },
      })
    : [];
  const byId = new Map(contacts.map((contact) => [contact.id, contact]));
  return {
    partnership,
    contacts: links
      .map((link) => {
        const contact = byId.get(link.contactId);
        return contact ? Object.assign(link, { contact }) : null;
      })
      .filter((row): row is PartnershipContact & { contact: Contact } => !!row),
  };
}

export async function updatePartnership(
  companyId: string,
  id: string,
  patch: PartnershipWrite & { archived?: boolean },
): Promise<Partnership | null> {
  const repo = AppDataSource.getRepository(Partnership);
  const row = await repo.findOneBy({ companyId, id });
  if (!row) return null;
  await assertRevenueOwner(companyId, patch);
  await assertRevenueLinks(companyId, { customerId: patch.customerId });
  await applyPartnership(companyId, row, patch);
  if (patch.archived !== undefined) row.archivedAt = patch.archived ? new Date() : null;
  return repo.save(row);
}

export async function addPartnershipContact(
  companyId: string,
  partnershipId: string,
  input: { contactId: string; role?: string; isPrimary?: boolean; replyAll?: boolean },
): Promise<PartnershipContact> {
  const partnership = await AppDataSource.getRepository(Partnership).findOneBy({
    companyId,
    id: partnershipId,
  });
  const contact = await AppDataSource.getRepository(Contact).findOneBy({
    companyId,
    id: input.contactId,
  });
  if (!partnership || !contact) throw new Error("Unknown partnership or contact");
  const repo = AppDataSource.getRepository(PartnershipContact);
  let row = await repo.findOneBy({ companyId, partnershipId, contactId: input.contactId });
  row ??= repo.create({
    companyId,
    partnershipId,
    contactId: input.contactId,
    role: "",
    isPrimary: false,
    replyAll: false,
    sortOrder: await repo.count({ where: { companyId, partnershipId } }),
  });
  if (input.role !== undefined) row.role = input.role.trim();
  if (input.isPrimary !== undefined) row.isPrimary = input.isPrimary;
  if (input.replyAll !== undefined) row.replyAll = input.replyAll;
  if (row.isPrimary) {
    await repo
      .createQueryBuilder()
      .update(PartnershipContact)
      .set({ isPrimary: false })
      .where("companyId = :companyId AND partnershipId = :partnershipId", {
        companyId,
        partnershipId,
      })
      .execute();
  }
  return repo.save(row);
}

export async function removePartnershipContact(
  companyId: string,
  partnershipId: string,
  contactId: string,
): Promise<boolean> {
  const result = await AppDataSource.getRepository(PartnershipContact).delete({
    companyId,
    partnershipId,
    contactId,
  });
  return (result.affected ?? 0) > 0;
}
