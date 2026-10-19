import { ApiError, type Customer } from "./api";

/**
 * Merging duplicate accounts — the shapes and wording shared by Revenue's
 * account page and the Customers pages, which merge the same rows through
 * their own routes (`services/revenue/accounts.ts#mergeRevenueAccounts`).
 */

export type AccountMergeCounts = {
  contacts: number;
  deals: number;
  activities: number;
  partnerships: number;
  revenueDocuments: number;
  signalEvents: number;
  billingContacts: number;
  contracts: number;
  invoices: number;
  estimates: number;
  recurringInvoices: number;
  credits: number;
  customValuesCopied: number;
  customValueConflicts: number;
};

export type MergeConflict = {
  field: string;
  label: string;
  sourceValue: unknown;
  targetValue: unknown;
  resolution: "source" | "target";
};

export type AccountMergePreview = {
  source: Pick<Customer, "id" | "name" | "slug" | "archivedAt">;
  target: Pick<Customer, "id" | "name" | "slug" | "archivedAt">;
  counts: AccountMergeCounts;
  fieldConflicts?: MergeConflict[];
  customFieldConflicts?: MergeConflict[];
  /** Conflicts on billing details were left out: the viewer has no finance access. */
  billingWithheld?: true;
};

const COUNT_LABELS: Array<[keyof AccountMergeCounts, string]> = [
  ["contacts", "Contacts"],
  ["deals", "Deals"],
  ["activities", "Activities"],
  ["partnerships", "Partnerships"],
  ["revenueDocuments", "Revenue documents"],
  ["signalEvents", "Signal events"],
  ["billingContacts", "Billing contacts"],
  ["contracts", "Contracts"],
  ["invoices", "Invoices"],
  ["estimates", "Estimates"],
  ["recurringInvoices", "Recurring invoices"],
  ["credits", "Credits"],
  ["customValuesCopied", "Custom values copied"],
];

/** What a merge moves, by label, leaving out the kinds it has none of. */
export function mergeCountRows(counts: AccountMergeCounts): Array<[string, number]> {
  return COUNT_LABELS.map(([key, label]): [string, number] => [label, counts[key] ?? 0]).filter(
    ([, count]) => count > 0,
  );
}

export function displayMergeValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "Empty";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export type DuplicateReason = { kind: string; value?: string; score: number };

/** A likely duplicate of one customer, from Revenue's duplicate scan. */
export type CustomerDuplicate = {
  id: string;
  score: number;
  reasons: DuplicateReason[];
  customer: Pick<Customer, "id" | "slug" | "name" | "domain" | "email">;
};

function describeReason({ kind, value }: DuplicateReason): string {
  switch (kind) {
    case "exact_domain":
    case "aliased_domain":
      return value ? `same domain ${value}` : "same domain";
    case "exact_email":
    case "aliased_email":
      return value ? `same email ${value}` : "same email";
    case "exact_website":
      return "same website";
    case "normalized_name":
      return "same name";
    case "shared_source_id":
      return "same imported record";
    default:
      return kind.startsWith("shared_")
        ? `same ${kind.slice("shared_".length).replace(/_/g, " ")}`
        : kind.replace(/_/g, " ");
  }
}

/** Why the scan paired two customers, as one short phrase: "Same domain acme.com · same name". */
export function describeDuplicateReasons(reasons: DuplicateReason[]): string {
  const phrases = [...new Set(reasons.map(describeReason))];
  if (phrases.length === 0) return "Looks like the same company";
  const sentence = phrases.join(" · ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

export type DomainHolder = { id: string; slug: string; name: string };

/** The customer a refused save says already uses its domain, or null for any other refusal. */
export function domainConflictOf(error: unknown): DomainHolder | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const conflict = (error.data as { conflict?: Partial<DomainHolder> } | null)?.conflict;
  return conflict &&
    typeof conflict.id === "string" &&
    typeof conflict.slug === "string" &&
    typeof conflict.name === "string"
    ? { id: conflict.id, slug: conflict.slug, name: conflict.name }
    : null;
}
