/**
 * The rules behind the Customer page, kept out of the component so they can be
 * tested without a DOM: which tab a URL names, where a mail conversation opens,
 * how the page says what it searched, and how an account's deals are ordered
 * and summed.
 */

export const CUSTOMER_TABS = [
  ["overview", "Overview"],
  ["emails", "Emails"],
  ["activity", "Activity"],
  ["deals", "Deals"],
  ["people", "People"],
  ["meetings", "Meetings"],
  ["billing", "Billing"],
  ["documents", "Documents"],
] as const;

export type CustomerTab = (typeof CUSTOMER_TABS)[number][0];

/** The tab a `?tab=` value names; anything unknown is the overview. */
export function parseCustomerTab(value: string | null): CustomerTab {
  const match = CUSTOMER_TABS.find(([key]) => key === value);
  return match ? match[0] : "overview";
}

/**
 * A conversation's link, selecting the mailbox it lives in. Mail opens the
 * active mailbox otherwise, and replying from the wrong one fails.
 */
export function customerMailThreadHref(
  companySlug: string,
  thread: { id: string; accountId: string },
): string {
  const query = new URLSearchParams({ account: thread.accountId });
  return `/c/${companySlug}/mail/t/${encodeURIComponent(thread.id)}?${query.toString()}`;
}

function inDomain(address: string, domain: string): boolean {
  const host = address.slice(address.indexOf("@") + 1);
  return host === domain || host.endsWith(`.${domain}`);
}

function otherAddresses(count: number): string {
  return `${count} other ${count === 1 ? "address" : "addresses"}`;
}

/**
 * What the Emails tab matched on, as a phrase: "anyone at acme.com and 1 other
 * address", or "billing@acme.com and pat@acme-holdings.com". Empty when
 * there was nothing to search.
 */
export function describeMailSearch(addresses: string[], domain: string | null): string {
  const outside = domain ? addresses.filter((address) => !inDomain(address, domain)) : addresses;
  if (domain) {
    return outside.length > 0
      ? `anyone at ${domain} and ${otherAddresses(outside.length)}`
      : `anyone at ${domain}`;
  }
  if (outside.length === 0) return "";
  if (outside.length === 1) return outside[0];
  if (outside.length === 2) return `${outside[0]} and ${outside[1]}`;
  return `${outside[0]} and ${otherAddresses(outside.length - 1)}`;
}

type DealLike = {
  status: "open" | "won" | "lost";
  amountCents: number;
  currency: string;
  updatedAt: string;
  closedAt: string | null;
};

function timeOf(iso: string | null): number {
  const at = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(at) ? 0 : at;
}

/** Open deals first, most recently touched first; then closed deals, newest close first. */
export function orderAccountDeals<T extends DealLike>(deals: T[]): T[] {
  const sortKey = (deal: T) =>
    deal.status === "open" ? timeOf(deal.updatedAt) : timeOf(deal.closedAt ?? deal.updatedAt);
  return [...deals].sort((a, b) => {
    const open = Number(b.status === "open") - Number(a.status === "open");
    return open || sortKey(b) - sortKey(a);
  });
}

/** Deal value per currency for one status — never summed across currencies. */
export function dealTotalsByCurrency(
  deals: DealLike[],
  status: DealLike["status"],
): [string, number][] {
  const totals = new Map<string, number>();
  for (const deal of deals) {
    if (deal.status !== status || deal.amountCents <= 0) continue;
    totals.set(deal.currency, (totals.get(deal.currency) ?? 0) + deal.amountCents);
  }
  return [...totals.entries()];
}
