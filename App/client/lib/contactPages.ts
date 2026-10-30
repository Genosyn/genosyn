/**
 * Revenue → Contacts, one page at a time from `GET …/revenue/contacts` — the
 * list, order and cursors an AI Employee's `list_contacts` reads
 * (`server/services/revenue/contacts.ts`, `pageContacts`).
 *
 * The page used to step through the list by offset. Logging an Activity moves
 * a contact to the top and archiving one takes it out, so the next offset
 * page then skipped or repeated a contact for every one that moved. A cursor
 * names the last contact shown instead, so Next carries on from exactly there.
 */

/** Contacts on one page of the list. */
export const CONTACT_PAGE_SIZE = 25;

/** What narrows the list, as the page holds it. */
export type ContactListFilters = {
  /** Words to find in a name, email, company or title; trimmed. */
  query: string;
  /** A lifecycle stage, or empty for every stage. */
  stage: string;
  showArchived: boolean;
};

/** One page as the server answers it. */
export type ContactPageResponse<Row> = {
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  note?: string;
  rows: Row[];
};

/**
 * The URL of one page: always with `limit`, which is what makes the server
 * answer a page, and with the cursor the page starts at after the first.
 */
export function contactPageUrl(
  companyId: string,
  filters: ContactListFilters,
  cursor: string | null,
  limit = CONTACT_PAGE_SIZE,
): string {
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  if (cursor) params.set("cursor", cursor);
  const q = filters.query.trim();
  if (q) params.set("q", q);
  if (filters.stage) params.set("lifecycleStage", filters.stage);
  if (filters.showArchived) params.set("includeArchived", "true");
  return `/api/companies/${companyId}/revenue/contacts?${params.toString()}`;
}
