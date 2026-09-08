import { In, IsNull, type FindOptionsWhere } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Estimate, type EstimateStatus } from "../db/entities/Estimate.js";
import { Product } from "../db/entities/Product.js";
import { TaxRate } from "../db/entities/TaxRate.js";
import { loadCustomerBySlug } from "./finance.js";
import { displayEstimateStatus, hydrateEstimates, loadEstimateBySlug } from "./estimates.js";

type Page = { limit: number; offset: number };

/** Compact summaries let an employee find prior work before opening its full lines. */
export async function listQuoteEstimates(
  companyId: string,
  input: Page & { customerSlug?: string; status?: EstimateStatus },
) {
  const where: FindOptionsWhere<Estimate> = { companyId };
  if (input.status) where.status = input.status;
  if (input.customerSlug) {
    const customer = await loadCustomerBySlug(companyId, input.customerSlug);
    if (!customer) return null;
    where.customerId = customer.id;
  }
  const [rows, total] = await AppDataSource.getRepository(Estimate).findAndCount({
    where,
    order: { createdAt: "DESC", id: "ASC" },
    skip: input.offset,
    take: input.limit,
  });
  const hydrated = await hydrateEstimates(companyId, rows);
  return {
    estimates: hydrated.map((estimate) => ({
      id: estimate.id,
      slug: estimate.slug,
      number: estimate.number || null,
      status: displayEstimateStatus(estimate),
      storedStatus: estimate.status,
      customer: estimate.customer
        ? { name: estimate.customer.name, slug: estimate.customer.slug }
        : null,
      currency: estimate.currency,
      totalCents: estimate.totalCents,
      issueDate: estimate.issueDate,
      validUntil: estimate.validUntil,
      notes: estimate.notes.slice(0, 1000),
      notesTruncated: estimate.notes.length > 1000,
    })),
    total,
    nextOffset: input.offset + rows.length < total ? input.offset + rows.length : null,
  };
}

export async function getQuoteEstimate(companyId: string, slug: string) {
  const estimate = await loadEstimateBySlug(companyId, slug);
  if (!estimate) return null;
  return (await hydrateEstimates(companyId, [estimate]))[0];
}

/** Catalogue facts only: never infer a price, convert its currency, or invent tax. */
export async function listQuoteProducts(
  companyId: string,
  input: Page & { includeArchived?: boolean; currency?: string },
) {
  const where: FindOptionsWhere<Product> = { companyId };
  if (!input.includeArchived) where.archivedAt = IsNull();
  if (input.currency) where.currency = input.currency;
  const [products, total] = await AppDataSource.getRepository(Product).findAndCount({
    where,
    order: { name: "ASC", id: "ASC" },
    skip: input.offset,
    take: input.limit,
  });
  const taxIds = products.flatMap((product) =>
    product.defaultTaxRateId ? [product.defaultTaxRateId] : [],
  );
  const taxes = taxIds.length
    ? await AppDataSource.getRepository(TaxRate).findBy({
        companyId,
        id: In(taxIds),
        archivedAt: IsNull(),
      })
    : [];
  const byTax = new Map(taxes.map((tax) => [tax.id, tax]));
  return {
    products: products.map((product) => {
      const tax = product.defaultTaxRateId ? byTax.get(product.defaultTaxRateId) : undefined;
      return {
        id: product.id,
        slug: product.slug,
        name: product.name,
        description: product.description.slice(0, 2000),
        descriptionTruncated: product.description.length > 2000,
        unitPriceCents: product.unitPriceCents,
        currency: product.currency,
        archived: !!product.archivedAt,
        defaultTaxRateId: tax?.id ?? null,
        defaultTaxRate: tax
          ? { id: tax.id, name: tax.name, ratePercent: tax.ratePercent, inclusive: tax.inclusive }
          : null,
        needsTaxReview: !!product.defaultTaxRateId && !tax,
      };
    }),
    total,
    nextOffset: input.offset + products.length < total ? input.offset + products.length : null,
  };
}
