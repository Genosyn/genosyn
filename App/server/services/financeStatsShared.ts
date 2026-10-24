import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Customer } from "../db/entities/Customer.js";
import type { StatsCustomer, StatsDocuments } from "../../shared/financeStats.js";

/**
 * Pieces `services/invoiceStats.ts` and `services/estimateStats.ts` both
 * build their figures from, so a figure means the same on both pages.
 */

export function emptyDocuments(): StatsDocuments {
  return { count: 0, amountCents: 0, ids: [] };
}

/** Count one document, already in the home currency, into a figure. */
export function addDocument(group: StatsDocuments, id: string, amountCents: number): void {
  group.count += 1;
  group.amountCents += amountCents;
  group.ids.push(id);
}

/** A document's currency, upper-cased, the home currency when it names none. */
export function currencyOf(code: string | null | undefined, home: string): string {
  return (code || home).toUpperCase();
}

/**
 * Currencies a figure could not convert, with the documents each left out:
 * named under the figures rather than added in at face value.
 */
export class LeftOut {
  private readonly byCurrency = new Map<string, Set<string>>();

  add(currency: string, documentId: string): void {
    const ids = this.byCurrency.get(currency) ?? new Set<string>();
    ids.add(documentId);
    this.byCurrency.set(currency, ids);
  }

  list(): Array<{ currency: string; documents: number }> {
    return [...this.byCurrency.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, ids]) => ({ currency, documents: ids.size }));
  }
}

/**
 * The customer a figure owes the most to, ties to the name first
 * alphabetically, or null when nobody accounts for anything.
 */
export async function largestCustomer(
  companyId: string,
  byCustomer: Map<string, StatsDocuments>,
): Promise<StatsCustomer | null> {
  const ranked = [...byCustomer.entries()].filter(([, group]) => group.amountCents > 0);
  if (ranked.length === 0) return null;
  const top = ranked.reduce((max, [, group]) => Math.max(max, group.amountCents), 0);
  const tied = ranked.filter(([, group]) => group.amountCents === top);
  const customers = await AppDataSource.getRepository(Customer).find({
    where: { id: In(tied.map(([id]) => id)), companyId },
    select: ["id", "name", "slug"],
  });
  const [winner] = tied
    .map(([id, group]) => {
      const customer = customers.find((row) => row.id === id);
      return { id, name: customer?.name ?? "Removed customer", slug: customer?.slug ?? "", group };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { id: winner.id, name: winner.name, slug: winner.slug, ...winner.group };
}
