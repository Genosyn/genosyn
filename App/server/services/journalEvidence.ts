import { And, LessThan, MoreThanOrEqual, type FindOperator } from "typeorm";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";

/** Leave room below the smallest runtime tool-result cap, including pretty JSON. */
export const JOURNAL_RESPONSE_CHAR_LIMIT = 7_500;
export const JOURNAL_BODY_CHUNK_MAX = 6_000;
const BODY_PREVIEW_LENGTH = 160;

export class JournalEvidenceError extends Error {}

const cursorSchema = z
  .object({
    employeeId: z.string().min(1).max(150),
    createdAt: z
      .string()
      .min(19)
      .max(40)
      .refine((value) => Number.isFinite(Date.parse(value))),
    id: z.string().uuid(),
  })
  .strict();

function readCursor(value: string, employeeId: string) {
  try {
    if (value.length > 500 || !/^[\w-]+$/.test(value)) throw new Error();
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (cursor.employeeId !== employeeId) throw new Error();
    return cursor;
  } catch {
    throw new JournalEvidenceError("Invalid Journal cursor for this AI Employee.");
  }
}

function writeCursor(entry: JournalEntry, createdAt: string): string {
  return Buffer.from(
    JSON.stringify({
      employeeId: entry.employeeId,
      createdAt,
      id: entry.id,
    }),
  ).toString("base64url");
}

async function scopedEmployee(companyId: string, employeeId: string) {
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: employeeId,
    companyId,
  });
  if (!employee) return null;
  return {
    id: employee.id,
    slug: employee.slug.slice(0, 120),
    name: employee.name.slice(0, 200),
    role: employee.role.slice(0, 200),
  };
}

function metadata(entry: JournalEntry) {
  return {
    id: entry.id,
    kind: entry.kind,
    title: entry.title.slice(0, 200),
    ...(entry.title.length > 200 ? { titleTruncated: true } : {}),
    createdAt: entry.createdAt.toISOString(),
    runId: entry.runId,
    routineId: entry.routineId,
  };
}

function responseLength(value: unknown) {
  return JSON.stringify(value, null, 2).length;
}

/** Newest first, with a timestamp/id keyset so equal timestamps cannot hide entries. */
export async function listJournalEvidence(args: {
  companyId: string;
  employeeId: string;
  limit?: number;
  since?: string;
  before?: string;
  cursor?: string;
}) {
  const employee = await scopedEmployee(args.companyId, args.employeeId);
  if (!employee) return null;
  const bounds: FindOperator<Date>[] = [];
  if (args.since) bounds.push(MoreThanOrEqual(new Date(args.since)));
  if (args.before) bounds.push(LessThan(new Date(args.before)));
  if (args.since && args.before && new Date(args.since) >= new Date(args.before)) {
    throw new JournalEvidenceError("Journal since must be earlier than before.");
  }
  const cursor = args.cursor ? readCursor(args.cursor, args.employeeId) : null;
  const limit = Math.max(1, Math.min(200, args.limit ?? 20));
  const query = AppDataSource.getRepository(JournalEntry)
    .createQueryBuilder("entry")
    .where({ employeeId: args.employeeId })
    // Preserve the database's timestamp precision. Postgres can retain microseconds;
    // converting its cursor to a JS Date would skip entries in the same millisecond.
    .addSelect("CAST(entry.createdAt AS text)", "cursorTimestamp")
    .addSelect("CAST(entry.id AS text)", "cursorEntryId")
    .orderBy("entry.createdAt", "DESC")
    .addOrderBy("entry.id", "DESC")
    .take(limit + 1);
  if (bounds.length) query.andWhere({ createdAt: And(...bounds) });
  if (cursor) {
    query.andWhere(
      "(entry.createdAt < :cursorTimestamp OR (entry.createdAt = :cursorTimestamp AND entry.id < :cursorId))",
      { cursorTimestamp: cursor.createdAt, cursorId: cursor.id },
    );
  }
  const { entities: rows, raw } = await query.getRawAndEntities<{
    cursorTimestamp: string;
    cursorEntryId: string;
  }>();
  const timestamps = new Map(raw.map((row) => [row.cursorEntryId, row.cursorTimestamp]));
  const entries: Array<
    ReturnType<typeof metadata> & {
      body: string;
      bodyLength: number;
      bodyTruncated: boolean;
    }
  > = [];
  const response = {
    employee,
    entries,
    hasMore: false,
    nextCursor: null as string | null,
    note: "Bodies are previews. Use get_journal_entry with entryId for the full text. Keep the same filters when following nextCursor.",
  };
  for (const row of rows.slice(0, limit)) {
    const entry = {
      ...metadata(row),
      body: row.body.slice(0, BODY_PREVIEW_LENGTH),
      bodyLength: row.body.length,
      bodyTruncated: row.body.length > BODY_PREVIEW_LENGTH,
    };
    entries.push(entry);
    const hasMore = entries.length < rows.length;
    const nextCursor = hasMore ? writeCursor(row, timestamps.get(row.id)!) : null;
    if (responseLength({ ...response, hasMore, nextCursor }) > JOURNAL_RESPONSE_CHAR_LIMIT) {
      entries.pop();
      break;
    }
    response.hasMore = hasMore;
    response.nextCursor = nextCursor;
  }
  return response;
}

/** Exact employee/company scoped retrieval; every character is recoverable by nextOffset. */
export async function getJournalEvidence(args: {
  companyId: string;
  employeeId: string;
  entryId: string;
  offset?: number;
  limit?: number;
}) {
  const employee = await scopedEmployee(args.companyId, args.employeeId);
  if (!employee) return null;
  const entry = await AppDataSource.getRepository(JournalEntry).findOneBy({
    id: args.entryId,
    employeeId: args.employeeId,
  });
  if (!entry) return null;
  const offset = args.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > entry.body.length) {
    throw new JournalEvidenceError(
      "Journal offset must be between 0 and bodyLength. Use nextOffset from the previous read.",
    );
  }
  const limit = Math.max(1, Math.min(JOURNAL_BODY_CHUNK_MAX, args.limit ?? 4_000));
  const result = (end: number) => ({
    employee,
    entry: { ...metadata(entry), body: entry.body.slice(offset, end) },
    offset,
    bodyLength: entry.body.length,
    hasMore: end < entry.body.length,
    nextOffset: end < entry.body.length ? end : null,
  });
  let low = offset;
  let high = Math.min(entry.body.length, offset + limit);
  // Escaped quotes/control characters can be much larger on the wire than their body length.
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (responseLength(result(middle)) <= JOURNAL_RESPONSE_CHAR_LIMIT) low = middle;
    else high = middle - 1;
  }
  // Do not split a UTF-16 surrogate pair when following server-issued offsets.
  if (low > offset && low < entry.body.length && /[\uD800-\uDBFF]/.test(entry.body[low - 1])) {
    low -= 1;
    // A one-character request still needs to make progress through an emoji.
    if (low === offset) low += 2;
  }
  return result(low);
}
