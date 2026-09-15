import { In } from "typeorm";

import { AppDataSource } from "../db/datasource.js";
import { Customer } from "../db/entities/Customer.js";
import { CustomerContact } from "../db/entities/CustomerContact.js";
import { andWhereTokens, tokenizeQuery } from "./likeSearch.js";

export const DEFAULT_CUSTOMER_PAGE_SIZE = 25;

export type CustomerWithContacts = Customer & { contacts: CustomerContact[] };

export type CustomerListOptions = {
  q?: string;
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
};

export type CustomerList = {
  customers: CustomerWithContacts[];
  total: number;
  limit: number;
  offset: number;
};

/**
 * Attach each customer's billing contacts in one bounded query. Customer rows
 * stay untouched so callers can safely reuse them in other calculations.
 */
export async function hydrateCustomers(
  companyId: string,
  customers: Customer[],
): Promise<CustomerWithContacts[]> {
  if (customers.length === 0) return [];
  const contacts = await AppDataSource.getRepository(CustomerContact).find({
    where: { companyId, customerId: In(customers.map((customer) => customer.id)) },
    order: { sortOrder: "ASC", createdAt: "ASC", id: "ASC" },
  });
  const byCustomer = new Map<string, CustomerContact[]>();
  for (const contact of contacts) {
    const rows = byCustomer.get(contact.customerId) ?? [];
    rows.push(contact);
    byCustomer.set(contact.customerId, rows);
  }
  return customers.map((customer) => ({
    ...customer,
    contacts: byCustomer.get(customer.id) ?? [],
  }));
}

/**
 * Search and page Customers inside one company. The contact join is used only
 * for matching; a distinct customer selection prevents several matching
 * contacts from changing the total or consuming page slots.
 */
export async function listCustomers(
  companyId: string,
  options: CustomerListOptions = {},
): Promise<CustomerList> {
  const pageRequested = options.limit !== undefined || options.offset !== undefined;
  const limit = options.limit ?? DEFAULT_CUSTOMER_PAGE_SIZE;
  const offset = options.offset ?? 0;
  const tokens = tokenizeQuery(options.q ?? "");
  let query = AppDataSource.getRepository(Customer)
    .createQueryBuilder("customer")
    .where("customer.companyId = :companyId", { companyId });

  if (tokens.length > 0) {
    query = query.leftJoin(
      CustomerContact,
      "contact",
      "contact.companyId = customer.companyId AND contact.customerId = CAST(customer.id AS TEXT)",
    );
    query.distinct(true);
  }

  if (!options.includeArchived) query.andWhere("customer.archivedAt IS NULL");
  query = andWhereTokens(
    query,
    [
      "customer.name",
      "customer.domain",
      "customer.email",
      "customer.phone",
      "customer.taxNumber",
      "contact.name",
      "contact.email",
      "contact.phone",
      "contact.role",
    ],
    tokens,
    "customerSearch",
  );
  query.orderBy("customer.createdAt", "DESC").addOrderBy("customer.id", "DESC");
  if (pageRequested) query.skip(offset).take(limit);

  let customers: Customer[];
  let total: number;
  if (pageRequested) {
    [customers, total] = await query.getManyAndCount();
  } else {
    customers = await query.getMany();
    total = customers.length;
  }
  return {
    customers: await hydrateCustomers(companyId, customers),
    total,
    limit,
    offset,
  };
}
