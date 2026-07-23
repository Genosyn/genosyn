import { In, type SelectQueryBuilder } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { Routine } from "../../db/entities/Routine.js";
import { User } from "../../db/entities/User.js";
import { recordAudit } from "../audit.js";
import { discardMailDraft, notifyMailChanged, sendMailDraft } from "./actions.js";

/**
 * The Drafts review queue.
 *
 * The rest of the mail surface is thread-centric, but reviewing what the AI
 * wrote overnight is a *message* problem: a human wants one row per draft,
 * attributed to the Routine and AI Employee that produced it, filterable, and
 * actionable in bulk. Threads get in the way of all four, so this module reads
 * `mail_messages` directly (a draft is a row with a non-empty `gmailDraftId`).
 *
 * Sending is deliberately split across two calls:
 *   1. {@link previewDraftSend} resolves a selection once and reports what
 *      would happen — counts, a per-Routine breakdown, and a sample of the
 *      actual recipients — so the confirmation dialog can show *who* gets mail.
 *   2. {@link runBulkDraftAction} sends one small batch, and the client calls
 *      it repeatedly with the ids from step 1.
 * A single request cannot loop hundreds of sends: Gmail takes ~1-2s per send,
 * so 500 of them is a multi-minute request that any proxy would cut. Chunking
 * also buys real progress ("sent 75 of 320") instead of one long spinner.
 */

/** Per-request send/discard cap — see the chunking note above. */
export const MAX_BULK_DRAFT_IDS = 25;

/** Upper bound on ids handed back by the preview, so the payload stays sane. */
const PREVIEW_ID_CAP = 2000;

/** How many distinct recipients the confirmation dialog gets to show. */
const SAMPLE_RECIPIENTS = 8;

export type DraftFilter = {
  employeeId?: string;
  routineId?: string;
  q?: string;
  onlyMissingRecipient?: boolean;
  unattributed?: boolean;
  /**
   * Restrict to drafts that can actually be sent. The queue's "select all"
   * means "all *sendable* drafts matching this filter" — its checkbox says so
   * and no-recipient rows cannot be ticked — so the selection it sends must
   * carry that same restriction. Without it a bulk *discard* would delete the
   * very rows the UI showed as excluded.
   */
  sendableOnly?: boolean;
};

/**
 * What a bulk call acts on. `ids` is an explicit tick-box selection; `filter`
 * is "everything matching what I'm looking at" minus anything the human
 * un-ticked — which is how "select all 320" works without the client ever
 * holding 320 rows.
 */
export type DraftSelection = { ids: string[] } | { filter: DraftFilter; exclude: string[] };

export type DraftAuthor =
  | {
      kind: "employee";
      employee: { id: string; name: string; slug: string; role: string; avatarKey: string | null };
      routine: { id: string; name: string; slug: string } | null;
      runId: string | null;
    }
  | { kind: "member"; member: { id: string; name: string; avatarKey: string | null } }
  | { kind: "none" };

export type SerializedDraft = {
  id: string;
  threadId: string;
  subject: string;
  toEmails: string;
  ccEmails: string;
  snippet: string;
  bodyPreview: string;
  hasAttachments: boolean;
  missingRecipient: boolean;
  createdAt: string | null;
  author: DraftAuthor;
};

// ───────────────────────────── query helpers ─────────────────────────────

function baseDraftQuery(account: MailAccount): SelectQueryBuilder<MailMessage> {
  return AppDataSource.getRepository(MailMessage)
    .createQueryBuilder("m")
    .where("m.accountId = :aid", { aid: account.id })
    .andWhere("m.companyId = :cid", { cid: account.companyId })
    .andWhere("m.gmailDraftId <> ''");
}

/** LIKE metacharacters are escaped so a subject with `%` searches literally. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * A draft is unsendable only when it has no addressee at all. Cc-only and
 * Bcc-only drafts are perfectly valid mail, so checking `toEmails` alone would
 * strand them in the queue forever. TRIM is portable across both drivers, and
 * keeping the rule in one constant means the list, the totals, the preview, and
 * the send loop can never disagree about what "sendable" means.
 */
const HAS_NO_RECIPIENT =
  "(TRIM(m.toEmails) = '' AND TRIM(m.ccEmails) = '' AND TRIM(m.bccEmails) = '')";

/** The in-JS twin of {@link HAS_NO_RECIPIENT}. */
function hasRecipient(row: MailMessage): boolean {
  return `${row.toEmails} ${row.ccEmails} ${row.bccEmails}`.trim() !== "";
}

function applyDraftFilter(
  qb: SelectQueryBuilder<MailMessage>,
  filter: DraftFilter,
): SelectQueryBuilder<MailMessage> {
  if (filter.employeeId) {
    qb.andWhere("m.createdByEmployeeId = :eid", { eid: filter.employeeId });
  }
  if (filter.routineId) {
    qb.andWhere("m.createdByRoutineId = :rid", { rid: filter.routineId });
  }
  if (filter.unattributed) {
    qb.andWhere("m.createdByEmployeeId IS NULL").andWhere("m.createdByUserId IS NULL");
  }
  if (filter.onlyMissingRecipient) {
    qb.andWhere(HAS_NO_RECIPIENT);
  }
  if (filter.sendableOnly) {
    qb.andWhere(`NOT ${HAS_NO_RECIPIENT}`);
  }
  const q = filter.q?.trim().toLowerCase();
  if (q) {
    // LOWER on both sides rather than relying on collation — SQLite's LIKE is
    // case-insensitive for ASCII but Postgres's is not, and the queue has to
    // behave the same on both.
    qb.andWhere(
      `(LOWER(m.subject) LIKE :dq ESCAPE '\\' OR LOWER(m.toEmails) LIKE :dq ESCAPE '\\'` +
        ` OR LOWER(m.snippet) LIKE :dq ESCAPE '\\' OR LOWER(m.bodyText) LIKE :dq ESCAPE '\\')`,
      { dq: `%${escapeLike(q)}%` },
    );
  }
  return qb;
}

function toCount(value: unknown): number {
  // Postgres hands COUNT(*) back as a string; SQLite as a number.
  return typeof value === "number" ? value : Number(value ?? 0);
}

// ───────────────────────────── author resolution ─────────────────────────────

type AuthorMaps = {
  employees: Map<string, AIEmployee>;
  routines: Map<string, Routine>;
  members: Map<string, User>;
};

/**
 * One batched lookup for the whole page. Resolving per row would be an N+1 on
 * a list whose entire point is showing hundreds of rows at once.
 */
async function resolveAuthors(rows: MailMessage[]): Promise<AuthorMaps> {
  const routineIds = new Set<string>();
  const employeeIds = new Set<string>();
  const memberIds = new Set<string>();
  for (const row of rows) {
    if (row.createdByRoutineId) routineIds.add(row.createdByRoutineId);
    if (row.createdByEmployeeId) employeeIds.add(row.createdByEmployeeId);
    if (row.createdByUserId) memberIds.add(row.createdByUserId);
  }

  const routines = routineIds.size
    ? await AppDataSource.getRepository(Routine).find({ where: { id: In([...routineIds]) } })
    : [];
  // A draft can carry a routine but no employee id (older rows, or a routine
  // whose employee moved) — the routine still knows who owns it.
  for (const routine of routines) employeeIds.add(routine.employeeId);

  const [employees, members] = await Promise.all([
    employeeIds.size
      ? AppDataSource.getRepository(AIEmployee).find({ where: { id: In([...employeeIds]) } })
      : Promise.resolve([]),
    memberIds.size
      ? AppDataSource.getRepository(User).find({ where: { id: In([...memberIds]) } })
      : Promise.resolve([]),
  ]);

  return {
    employees: new Map(employees.map((e) => [e.id, e])),
    routines: new Map(routines.map((r) => [r.id, r])),
    members: new Map(members.map((m) => [m.id, m])),
  };
}

function buildAuthor(row: MailMessage, maps: AuthorMaps): DraftAuthor {
  const routine = row.createdByRoutineId ? (maps.routines.get(row.createdByRoutineId) ?? null) : null;
  const employeeId = row.createdByEmployeeId ?? routine?.employeeId ?? null;
  const employee = employeeId ? (maps.employees.get(employeeId) ?? null) : null;

  if (employee) {
    return {
      kind: "employee",
      employee: {
        id: employee.id,
        name: employee.name,
        slug: employee.slug,
        role: employee.role,
        avatarKey: employee.avatarKey,
      },
      routine: routine ? { id: routine.id, name: routine.name, slug: routine.slug } : null,
      runId: row.createdByRunId,
    };
  }

  const member = row.createdByUserId ? (maps.members.get(row.createdByUserId) ?? null) : null;
  if (member) {
    return {
      kind: "member",
      member: { id: member.id, name: member.name, avatarKey: member.avatarKey },
    };
  }

  // Synced in from Gmail, or written before attribution shipped. Saying
  // "unattributed" is honest; guessing an author would not be.
  return { kind: "none" };
}

/** Body preview for the list row — the drawer fetches the full thread. */
function bodyPreview(row: MailMessage): string {
  const text = (row.bodyText || row.snippet || "").replace(/\s+/g, " ").trim();
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

function serializeDraft(row: MailMessage, maps: AuthorMaps): SerializedDraft {
  return {
    id: row.id,
    threadId: row.threadId,
    subject: row.subject,
    toEmails: row.toEmails,
    ccEmails: row.ccEmails,
    snippet: row.snippet,
    bodyPreview: bodyPreview(row),
    hasAttachments: row.attachmentsJson !== "" && row.attachmentsJson !== "[]",
    missingRecipient: !hasRecipient(row),
    createdAt: row.createdAt ? row.createdAt.toISOString() : null,
    author: buildAuthor(row, maps),
  };
}

// ───────────────────────────── list ─────────────────────────────

export type DraftFacet = { id: string | null; name: string; count: number };

export type ListDraftsResult = {
  drafts: SerializedDraft[];
  /** Offset for the next page, or null when this was the last one. */
  nextOffset: number | null;
  facets: { employees: DraftFacet[]; routines: DraftFacet[] };
  totals: { total: number; sendable: number; missingRecipient: number };
};

/**
 * Facets are computed over *every* draft in the mailbox, not the filtered set,
 * so the employee/routine pickers keep offering the other options once a filter
 * is on. Totals below are the opposite — they describe what is on screen.
 */
async function draftFacets(account: MailAccount): Promise<ListDraftsResult["facets"]> {
  const raw = await baseDraftQuery(account)
    .select("m.createdByEmployeeId", "employeeId")
    .addSelect("m.createdByRoutineId", "routineId")
    .addSelect("COUNT(*)", "count")
    .groupBy("m.createdByEmployeeId")
    .addGroupBy("m.createdByRoutineId")
    .getRawMany<{ employeeId: string | null; routineId: string | null; count: number | string }>();

  const routineIds = raw.map((r) => r.routineId).filter((v): v is string => Boolean(v));
  const routines = routineIds.length
    ? await AppDataSource.getRepository(Routine).find({ where: { id: In([...new Set(routineIds)]) } })
    : [];
  const routineById = new Map(routines.map((r) => [r.id, r]));

  const employeeIds = new Set<string>();
  for (const r of raw) if (r.employeeId) employeeIds.add(r.employeeId);
  for (const r of routines) employeeIds.add(r.employeeId);
  const employees = employeeIds.size
    ? await AppDataSource.getRepository(AIEmployee).find({ where: { id: In([...employeeIds]) } })
    : [];
  const employeeById = new Map(employees.map((e) => [e.id, e]));

  const byEmployee = new Map<string | null, number>();
  const byRoutine = new Map<string | null, number>();
  for (const r of raw) {
    const count = toCount(r.count);
    const routine = r.routineId ? routineById.get(r.routineId) : undefined;
    const employeeId = r.employeeId ?? routine?.employeeId ?? null;
    byEmployee.set(employeeId, (byEmployee.get(employeeId) ?? 0) + count);
    byRoutine.set(r.routineId ?? null, (byRoutine.get(r.routineId ?? null) ?? 0) + count);
  }

  const employeeFacets: DraftFacet[] = [...byEmployee.entries()].map(([id, count]) => ({
    id,
    name: id ? (employeeById.get(id)?.name ?? "Removed employee") : "Not written by an AI employee",
    count,
  }));
  const routineFacets: DraftFacet[] = [...byRoutine.entries()].map(([id, count]) => ({
    id,
    name: id ? (routineById.get(id)?.name ?? "Removed routine") : "No routine",
    count,
  }));

  const byCountDesc = (a: DraftFacet, b: DraftFacet) => b.count - a.count;
  return {
    employees: employeeFacets.sort(byCountDesc),
    routines: routineFacets.sort(byCountDesc),
  };
}

export async function listDrafts(
  account: MailAccount,
  opts: { filter: DraftFilter; offset: number; limit: number },
): Promise<ListDraftsResult> {
  const filtered = applyDraftFilter(baseDraftQuery(account), opts.filter);

  const [total, missingRecipient] = await Promise.all([
    filtered.clone().getCount(),
    filtered.clone().andWhere(HAS_NO_RECIPIENT).getCount(),
  ]);

  // Newest first, ordered on (createdAt, id) and paged by offset.
  //
  // A timestamp cursor is the wrong tool here. `createdAt` is a plain
  // @CreateDateColumn, which on SQLite is filled by the column's
  // `datetime('now')` default — one-second resolution, so a sync pass or a
  // drafting routine routinely lands several drafts in the same second, and the
  // value is a *string* whose format need not match the one a Date parameter
  // serialises to. Comparing the two is a lexicographic coin flip that can drop
  // rows or repeat them. That is not a cosmetic paging bug: "Send all"
  // re-resolves from the filter rather than from what was rendered, so a draft
  // the list never showed is still a draft that gets sent.
  //
  // Adding `id` as a tiebreaker makes the ORDER BY a stable total order, and on
  // a total order offset paging visits every row exactly once — no datetime
  // comparison anywhere. The queue is bounded (hundreds, capped at 200 a page),
  // so the usual objection to OFFSET does not bite.
  //
  // Grouping stays client-side over everything loaded so far.
  const rows = await filtered
    .clone()
    .orderBy("m.createdAt", "DESC")
    .addOrderBy("m.id", "DESC")
    .skip(opts.offset)
    .take(opts.limit + 1)
    .getMany();
  const slice = rows.slice(0, opts.limit);
  const nextOffset = rows.length > opts.limit ? opts.offset + opts.limit : null;

  const maps = await resolveAuthors(slice);
  return {
    drafts: slice.map((row) => serializeDraft(row, maps)),
    nextOffset,
    facets: await draftFacets(account),
    totals: { total, sendable: total - missingRecipient, missingRecipient },
  };
}

// ───────────────────────────── selection ─────────────────────────────

/**
 * Turn either selection shape into concrete rows. Explicit ids are still
 * re-scoped to this account so a stray id from elsewhere cannot ride along.
 */
async function resolveSelection(
  account: MailAccount,
  selection: DraftSelection,
): Promise<MailMessage[]> {
  if ("ids" in selection) {
    if (selection.ids.length === 0) return [];
    return baseDraftQuery(account)
      .andWhere("m.id IN (:...ids)", { ids: selection.ids })
      .orderBy("m.createdAt", "DESC")
      .addOrderBy("m.id", "DESC")
      .getMany();
  }

  const qb = applyDraftFilter(baseDraftQuery(account), selection.filter)
    .orderBy("m.createdAt", "DESC")
    .addOrderBy("m.id", "DESC")
    .take(PREVIEW_ID_CAP);
  const rows = await qb.getMany();
  if (selection.exclude.length === 0) return rows;
  const excluded = new Set(selection.exclude);
  return rows.filter((row) => !excluded.has(row.id));
}

export type DraftSendPreview = {
  accountAddress: string;
  total: number;
  sendable: number;
  missingRecipient: number;
  byEmployee: DraftFacet[];
  byRoutine: DraftFacet[];
  sampleRecipients: string[];
  /** Every draft in the selection — what a discard acts on. */
  ids: string[];
  /** The subset carrying a recipient — what a send acts on. */
  sendableIds: string[];
  /** True when the selection was clipped at {@link PREVIEW_ID_CAP}. */
  truncated: boolean;
};

/** Split a comma-joined header into individual addresses. */
function addressesOf(toEmails: string): string[] {
  return toEmails
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Everything the confirmation dialog needs to make the blast radius concrete:
 * how many, from which Routines, and — most importantly — a sample of the real
 * addresses about to receive mail.
 */
export async function previewDraftSend(
  account: MailAccount,
  selection: DraftSelection,
): Promise<DraftSendPreview> {
  const rows = await resolveSelection(account, selection);
  const sendable = rows.filter(hasRecipient);
  const maps = await resolveAuthors(sendable);

  const byEmployee = new Map<string | null, { name: string; count: number }>();
  const byRoutine = new Map<string | null, { name: string; count: number }>();
  const recipients: string[] = [];
  const seenRecipient = new Set<string>();

  for (const row of sendable) {
    const author = buildAuthor(row, maps);
    const employeeKey = author.kind === "employee" ? author.employee.id : null;
    const employeeName =
      author.kind === "employee"
        ? author.employee.name
        : author.kind === "member"
          ? author.member.name
          : "Unattributed";
    const routineKey = author.kind === "employee" && author.routine ? author.routine.id : null;
    const routineName =
      author.kind === "employee" && author.routine ? author.routine.name : "No routine";

    const e = byEmployee.get(employeeKey);
    if (e) e.count += 1;
    else byEmployee.set(employeeKey, { name: employeeName, count: 1 });

    const r = byRoutine.get(routineKey);
    if (r) r.count += 1;
    else byRoutine.set(routineKey, { name: routineName, count: 1 });

    // Cc and Bcc receive the mail just as much as To does — sampling only To
    // would under-state the blast radius on exactly the sends where it matters.
    for (const address of addressesOf(
      [row.toEmails, row.ccEmails, row.bccEmails].filter(Boolean).join(","),
    )) {
      const key = address.toLowerCase();
      if (seenRecipient.has(key)) continue;
      seenRecipient.add(key);
      if (recipients.length < SAMPLE_RECIPIENTS) recipients.push(address);
    }
  }

  const toFacets = (m: Map<string | null, { name: string; count: number }>): DraftFacet[] =>
    [...m.entries()]
      .map(([id, v]) => ({ id, name: v.name, count: v.count }))
      .sort((a, b) => b.count - a.count);

  return {
    accountAddress: account.address,
    total: rows.length,
    sendable: sendable.length,
    missingRecipient: rows.length - sendable.length,
    byEmployee: toFacets(byEmployee),
    byRoutine: toFacets(byRoutine),
    sampleRecipients: recipients,
    ids: rows.map((row) => row.id),
    sendableIds: sendable.map((row) => row.id),
    truncated: !("ids" in selection) && rows.length >= PREVIEW_ID_CAP,
  };
}

// ───────────────────────────── bulk actions ─────────────────────────────

export type BulkDraftResult = {
  succeeded: string[];
  skipped: { id: string; reason: string }[];
};

/**
 * Send or discard one batch. Every item is isolated: a draft Gmail rejects is
 * recorded and the rest of the batch still goes out, because the alternative —
 * aborting mid-run — leaves the human with no idea which half was sent.
 *
 * Drafts with no recipient are re-checked here rather than trusted from the
 * client, so the count someone confirmed is the count that actually sends.
 */
export async function runBulkDraftAction(
  account: MailAccount,
  action: "send" | "discard",
  ids: string[],
  actorUserId: string | null,
): Promise<BulkDraftResult> {
  const rows = await resolveSelection(account, { ids });
  const found = new Set(rows.map((row) => row.id));

  const succeeded: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const id of ids) {
    if (!found.has(id)) skipped.push({ id, reason: "not-found" });
  }

  for (const row of rows) {
    if (action === "send" && !hasRecipient(row)) {
      skipped.push({ id: row.id, reason: "no-recipient" });
      continue;
    }
    try {
      if (action === "send") {
        const message = await sendMailDraft(account, row, { silent: true });
        succeeded.push(row.id);
        // One audit row per message, keyed to the message — same shape the
        // single-draft route writes, so existing audit consumers still work.
        await recordAudit({
          companyId: account.companyId,
          actorUserId,
          action: "mail.send",
          targetType: "mail_message",
          targetId: message.id,
          targetLabel: message.subject || "(no subject)",
          metadata: { fromDraft: true, bulk: true },
        });
      } else {
        await discardMailDraft(account, row, { silent: true });
        succeeded.push(row.id);
      }
    } catch (err) {
      skipped.push({
        id: row.id,
        reason: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  if (succeeded.length > 0) {
    // One broadcast for the batch — see the `silent` note on sendMailDraft.
    notifyMailChanged(account);
    await recordAudit({
      companyId: account.companyId,
      actorUserId,
      action: action === "send" ? "mail.draft.bulk_send" : "mail.draft.bulk_discard",
      targetType: "mail_account",
      targetId: account.id,
      targetLabel: account.address,
      metadata: { requested: ids.length, succeeded: succeeded.length, skipped: skipped.length },
    });
  }

  return { succeeded, skipped };
}
