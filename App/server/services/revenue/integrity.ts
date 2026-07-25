import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Contact } from "../../db/entities/Contact.js";
import { Customer } from "../../db/entities/Customer.js";
import { Deal } from "../../db/entities/Deal.js";
import { Membership } from "../../db/entities/Membership.js";
import { Partnership } from "../../db/entities/Partnership.js";

export type RevenueOwner = {
  ownerId?: string | null;
  ownerEmployeeId?: string | null;
};

export type RevenueLinks = {
  contactId?: string | null;
  customerId?: string | null;
  dealId?: string | null;
  partnershipId?: string | null;
};

/** Keep human and AI ownership exclusive and scoped to the current company. */
export async function assertRevenueOwner(
  companyId: string,
  owner: RevenueOwner,
): Promise<void> {
  if (owner.ownerId && owner.ownerEmployeeId) {
    throw new Error("Assign ownership to either a Member or an AI Employee, not both");
  }
  if (
    owner.ownerId &&
    !(await AppDataSource.getRepository(Membership).findOneBy({
      companyId,
      userId: owner.ownerId,
    }))
  ) {
    throw new Error("Unknown account owner");
  }
  if (
    owner.ownerEmployeeId &&
    !(await AppDataSource.getRepository(AIEmployee).findOneBy({
      companyId,
      id: owner.ownerEmployeeId,
    }))
  ) {
    throw new Error("Unknown AI Employee owner");
  }
}

/** Validate polymorphic Revenue links before writing an unbound identifier. */
export async function assertRevenueLinks(
  companyId: string,
  links: RevenueLinks,
  options: { requireOne?: boolean } = {},
): Promise<void> {
  const present = Object.values(links).filter((value): value is string => !!value);
  if (options.requireOne && present.length === 0) {
    throw new Error("Link this record to a Revenue resource");
  }
  const checks: Array<Promise<unknown> | null> = [
    links.contactId
      ? AppDataSource.getRepository(Contact).findOneBy({ companyId, id: links.contactId })
      : null,
    links.customerId
      ? AppDataSource.getRepository(Customer).findOneBy({ companyId, id: links.customerId })
      : null,
    links.dealId
      ? AppDataSource.getRepository(Deal).findOneBy({ companyId, id: links.dealId })
      : null,
    links.partnershipId
      ? AppDataSource.getRepository(Partnership).findOneBy({
          companyId,
          id: links.partnershipId,
        })
      : null,
  ];
  const resolved = await Promise.all(checks.map((check) => check ?? Promise.resolve(true)));
  if (resolved.some((row) => !row)) throw new Error("Unknown linked Revenue resource");
}
