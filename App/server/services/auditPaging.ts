import type { SelectQueryBuilder } from "typeorm";
import type { AuditEvent } from "../db/entities/AuditEvent.js";
import {
  type CursorValue,
  decodeCursor,
  encodeCursor,
  type KeysetColumn,
  keysetRows,
} from "./listPaging.js";

/**
 * Reading the audit log back a page at a time, newest first: the company log
 * (`GET /audit`) and one record's History (`GET /history/:targetType/:targetId`).
 *
 * Both used to hand out the oldest row's `createdAt` as the cursor and read on
 * with `createdAt < cursor`. The log is written in bursts — a bulk action
 * audits every row it touched within the same millisecond — so every other
 * event sharing the boundary instant was skipped, and a page that ended
 * exactly at the last row still offered a cursor to an empty one. The cursor
 * is now a keyset on (createdAt, id) (`services/listPaging.ts`), bound to the
 * list and its filters. A bare timestamp from before still reads on the old
 * way, so a script holding one is not refused.
 */

/** Newest first, ties by id: the order every audit page reads. */
const AUDIT_KEYS: KeysetColumn[] = [
  { column: "e.createdAt", direction: "DESC", type: "timestamp" },
  { column: "e.id", direction: "DESC", type: "string" },
];

/** An ISO timestamp — the cursor the log handed out before it was a keyset. */
const TIMESTAMP_CURSOR = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

export type AuditPage = {
  rows: AuditEvent[];
  /** More events follow this page. */
  hasMore: boolean;
  /** Pass back as `cursor`, with the same filters, for the next page; null on the last. */
  nextCursor: string | null;
};

/**
 * One page of audit events. `qb` selects from `audit_events` as `e`, with the
 * list's filters and no order. A cursor this list did not issue — garbled,
 * another list's, or for other filters — throws `ListCursorError`.
 */
export async function pageAuditEvents(
  qb: SelectQueryBuilder<AuditEvent>,
  args: { scope: string; fingerprint: string; cursor?: string; take: number },
): Promise<AuditPage> {
  let after: CursorValue[] | null = null;
  if (args.cursor && TIMESTAMP_CURSOR.test(args.cursor) && !Number.isNaN(Date.parse(args.cursor))) {
    qb.andWhere("e.createdAt < :timestampCursor", { timestampCursor: new Date(args.cursor) });
  } else if (args.cursor) {
    after = decodeCursor(args.scope, args.fingerprint, args.cursor);
  }
  const fetched = await keysetRows(qb, {
    keys: AUDIT_KEYS,
    after,
    limit: args.take,
    prefix: "audit",
  });
  const kept = fetched.slice(0, args.take);
  const hasMore = fetched.length > args.take && kept.length > 0;
  return {
    rows: kept.map((entry) => entry.row),
    hasMore,
    nextCursor: hasMore
      ? encodeCursor(args.scope, args.fingerprint, kept[kept.length - 1].key)
      : null,
  };
}
