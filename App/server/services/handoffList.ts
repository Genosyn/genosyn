import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { Handoff, type HandoffStatus } from "../db/entities/Handoff.js";
import {
  filterFingerprint,
  keysetPage,
  type Page,
  type PageLimits,
  pageQueryShape,
  type PageRequest,
} from "./listPaging.js";

/**
 * Handoffs — work one AI Employee delegated to another — one page at a time
 * (`services/listPaging.ts`), newest first, then by id.
 *
 * The `list_handoffs` AI tool (an employee's own inbox and outbox) and
 * `GET /handoffs` (when it is asked for a page) read this one function, so an
 * AI Employee and an API client reach the same handoffs in the same order. For
 * the same employee, direction and status the two are one list, and a cursor
 * from one continues the other.
 */

/** 50 handoffs by default, at most 200 a page. */
export const HANDOFF_PAGE: PageLimits = { defaultLimit: 50, maxLimit: 200 };

export const HANDOFF_STATUSES: HandoffStatus[] = ["pending", "completed", "declined", "cancelled"];

export type HandoffDirection = "incoming" | "outgoing" | "any";

export type HandoffListFilter = {
  /** Only handoffs this AI Employee sent or received; unset is the whole company's. */
  employeeId?: string;
  /** With `employeeId`: sent to it, sent by it, or either (the default). */
  direction?: HandoffDirection;
  /** One status; unset is every status. */
  status?: HandoffStatus;
};

/**
 * `GET /handoffs`'s query. The values stay as lenient as the route always
 * read them — an unknown direction is either side, an unknown status every
 * status ({@link handoffFilterFromQuery}) — so no existing caller is refused.
 */
export const handoffListQuerySchema = z.object({
  employeeId: z
    .string()
    .max(100)
    .optional()
    .describe("Only handoffs this AI Employee sent or received."),
  direction: z
    .string()
    .max(20)
    .optional()
    .describe(
      "With employeeId: incoming (sent to it), outgoing (sent by it), or any (either side, the default).",
    ),
  status: z
    .string()
    .max(40)
    .optional()
    .describe("pending, completed, declined or cancelled. all, or no status, is every status."),
  ...pageQueryShape,
});

/** The filter a `GET /handoffs` query names, read the way the route always read it. */
export function handoffFilterFromQuery(query: {
  employeeId?: string;
  direction?: string;
  status?: string;
}): HandoffListFilter {
  const employeeId = query.employeeId || undefined;
  const direction: HandoffDirection =
    query.direction === "incoming" || query.direction === "outgoing" ? query.direction : "any";
  const status = (HANDOFF_STATUSES as string[]).includes(query.status ?? "")
    ? (query.status as HandoffStatus)
    : undefined;
  return { employeeId, direction: employeeId ? direction : undefined, status };
}

/** Handoffs matching the filter, unordered: the shared WHERE of the page and the plain list. */
export function handoffListQuery(companyId: string, filter: HandoffListFilter) {
  const qb = AppDataSource.getRepository(Handoff)
    .createQueryBuilder("h")
    .where("h.companyId = :cid", { cid: companyId });
  if (filter.employeeId) {
    if (filter.direction === "incoming") {
      qb.andWhere("h.toEmployeeId = :eid", { eid: filter.employeeId });
    } else if (filter.direction === "outgoing") {
      qb.andWhere("h.fromEmployeeId = :eid", { eid: filter.employeeId });
    } else {
      qb.andWhere("(h.toEmployeeId = :eid OR h.fromEmployeeId = :eid)", {
        eid: filter.employeeId,
      });
    }
  }
  if (filter.status) qb.andWhere("h.status = :status", { status: filter.status });
  return qb;
}

/** Handoffs, newest first, one page at a time. A bad cursor throws a `ListQueryError`. */
export async function pageHandoffs<Out>(
  companyId: string,
  filter: HandoffListFilter,
  page: PageRequest & { budgetChars?: number },
  present: (handoffs: Handoff[]) => Promise<Out[]> | Out[],
): Promise<Page<Out>> {
  return keysetPage({
    query: () => handoffListQuery(companyId, filter),
    keys: [
      { column: "h.createdAt", direction: "DESC", type: "timestamp" },
      { column: "h.id", direction: "DESC", type: "string" },
    ],
    scope: "handoffs",
    fingerprint: filterFingerprint(companyId, {
      employee: filter.employeeId,
      direction: filter.employeeId ? (filter.direction ?? "any") : undefined,
      status: filter.status ?? "all",
    }),
    noun: "handoffs",
    limits: HANDOFF_PAGE,
    page,
    present,
  });
}
