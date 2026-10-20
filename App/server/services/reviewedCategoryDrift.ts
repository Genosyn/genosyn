import { In } from "typeorm";
import { entryCategoryLockBySource, reversalKey } from "../../shared/entryCategory.js";
import { AppDataSource } from "../db/datasource.js";
import { Account, type AccountType } from "../db/entities/Account.js";
import { BillPayment } from "../db/entities/BillPayment.js";
import { InvoicePayment } from "../db/entities/InvoicePayment.js";
import { LedgerEntry, type LedgerEntrySource } from "../db/entities/LedgerEntry.js";
import { LedgerLine } from "../db/entities/LedgerLine.js";
import { type BookedLine, bookedLines } from "./ledger.js";

/**
 * Reversed entries that still carry a category Entry review gave them.
 *
 * Entry review approves a category change by posting a `ledger_reclass` keyed
 * on the entry it re-files, and leaves the entry's own lines as they were
 * posted. Whatever reverses an entry now reverses it as the books hold it
 * (`bookedLines`), and Entry review refuses a change nothing would take back
 * (`shared/entryCategory.ts`). Before that, a reviewed category could outlive
 * the entry it moved in three ways, each a `cause` on the change:
 *
 * - `reversed_without_it`: a void, a deleted payment, a reversed credit,
 *   refund or write-off, or an Undo on Banking reversed only the entry's own
 *   lines, so the reviewed category kept the money and the original one owed
 *   it;
 * - `approved_after_reversal`: Entry review re-filed an entry that had already
 *   been reversed;
 * - `approved_on_reversal`: Entry review re-filed the reversal itself.
 *
 * Each reversed entry is judged with its reversals and every change Entry
 * review approved on any of them. Together they should leave nothing on any
 * account, so what they do leave is the drift. A journal entry someone posted
 * by hand to correct one is not among them, so an entry fixed that way is
 * still listed.
 *
 * This only reads. `repair` says what would put each entry right; nothing
 * here applies it. A repair only moves money back between categories of one
 * kind, so total income and expenses stay as they are. An entry whose leftover
 * is anything else is `unrecognized`, with no repair.
 */

export type ReviewedCategoryDriftKind =
  /** Entry review's changes outlived the reversal, and are all that is left over. */
  | "left_behind"
  /** More than a category change is left over, so no repair is proposed. */
  | "unrecognized";

/** Why a reversal didn't take a category change back. */
export type ReviewedCategoryChangeCause =
  | "reversed_without_it"
  | "approved_after_reversal"
  | "approved_on_reversal";

export type DriftEntry = Pick<
  LedgerEntry,
  "id" | "source" | "sourceRefId" | "date" | "memo" | "createdById" | "createdAt"
>;

export type DriftChange = DriftEntry & {
  /** The entry it re-filed: the reversed entry or one of its reversals. */
  changedEntryId: string;
  cause: ReviewedCategoryChangeCause;
};

/** Debits minus credits left on one account. */
export type LeftoverAmount = { accountId: string; code: string; name: string; cents: number };

/**
 * One balanced change that leaves nothing on any account. The same shape as
 * a card purchase's `reclassify` repair (`cardCategoryDrift.ts`).
 */
export type ReviewedCategoryRepair = {
  kind: "reclassify";
  lines: Array<{ accountId: string; debitCents: number; creditCents: number }>;
};

export type ReviewedCategoryDrift = {
  kind: ReviewedCategoryDriftKind;
  /** The entry that was reversed, or null when a reversal names one that isn't in the books. */
  entry: DriftEntry | null;
  /** What reversed it, oldest first. */
  reversals: DriftEntry[];
  /** The changes Entry review approved on it or its reversals, oldest first. */
  changes: DriftChange[];
  /** What it and its reversals leave on each account, debits first, zeros left out. */
  leftover: LeftoverAmount[];
  /** Null for an `unrecognized` entry. */
  repair: ReviewedCategoryRepair | null;
  /** Why an `unrecognized` entry has no repair. */
  problem: string | null;
};

type Entry = DriftEntry;
type Key = { source: string; sourceRefId: string };

const ENTRY_COLUMNS: Array<keyof LedgerEntry> = [
  "id",
  "source",
  "sourceRefId",
  "date",
  "memo",
  "createdById",
  "createdAt",
];
const BANK_UNDO = "bank_categorization_void";
const PAYMENT_DELETION = "-deletion";
const BILL_ISSUE = "bill_issue:";
const BILL_VOID = "bill_void:";
const BILL_PAYMENT = "bill_payment:";
const BILL_PAYMENT_REVERSAL = "bill_payment_reversal:";
/** How `reverseLedgerEntriesForSources` names the entry each of its reversals reverses. */
const REVERSES = /\(reverses ([0-9a-f]{8})\)$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHUNK = 500;

/** Rows for many values, a bounded `IN` list at a time. */
async function inChunks<T>(values: string[], load: (part: string[]) => Promise<T[]>): Promise<T[]> {
  const rows: T[] = [];
  for (let start = 0; start < values.length; start += CHUNK) {
    rows.push(...(await load(values.slice(start, start + CHUNK))));
  }
  return rows;
}

/** Distinct ids, leaving out anything a uuid column would refuse. */
function uniqueIds(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => !!value && UUID.test(value)))];
}

function keyOf(key: Pick<Key, "source"> & { sourceRefId: string | null }): string {
  return JSON.stringify([key.source, key.sourceRefId]);
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function oldestFirst(a: Entry, b: Entry): number {
  return a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);
}

function isReversal(entry: Entry): boolean {
  return entry.source === BANK_UNDO || entryCategoryLockBySource(entry) === "reversal";
}

/** The key the entry's reversal is posted under. Banking keys an Undo on the categorization itself. */
function ownReversalKey(entry: Entry): Key | null {
  if (entry.source === "bank_categorization") return { source: BANK_UNDO, sourceRefId: entry.id };
  return reversalKey(entry);
}

/**
 * The keys of the entries a reversal posted under `key` reverses: the inverse
 * of `reversalKey` for every reversal posted before the fix. A void reverses
 * an invoice's issue and every revision an edit wrote, all keyed on the
 * invoice. An Undo on Banking names the categorization by id instead.
 */
function reversedKeys(key: Key): Key[] {
  const ref = key.sourceRefId;
  switch (key.source) {
    case "invoice_void":
      return ref.endsWith(PAYMENT_DELETION)
        ? [{ source: "invoice_payment", sourceRefId: ref.slice(0, -PAYMENT_DELETION.length) }]
        : [
            { source: "invoice_issue", sourceRefId: ref },
            { source: "invoice_revision", sourceRefId: ref },
          ];
    case "credit_note_void":
      return [{ source: "credit_note_issue", sourceRefId: ref }];
    case "credit_note_unapply":
      return [{ source: "credit_note_apply", sourceRefId: ref }];
    case "customer_refund_void":
      return [{ source: "customer_refund", sourceRefId: ref }];
    case "invoice_writeoff_reversal":
      return [{ source: "invoice_writeoff", sourceRefId: ref }];
    case "vendor_credit_void":
      return [{ source: "vendor_credit_issue", sourceRefId: ref }];
    case "vendor_credit_unapply":
      return [{ source: "vendor_credit_apply", sourceRefId: ref }];
    case "vendor_refund_void":
      return [{ source: "vendor_refund", sourceRefId: ref }];
    case "manual":
      if (ref.startsWith(BILL_VOID)) {
        return [{ source: "manual", sourceRefId: `${BILL_ISSUE}${ref.slice(BILL_VOID.length)}` }];
      }
      if (ref.startsWith(BILL_PAYMENT_REVERSAL)) {
        return [
          {
            source: "manual",
            sourceRefId: `${BILL_PAYMENT}${ref.slice(BILL_PAYMENT_REVERSAL.length)}`,
          },
        ];
      }
      return [];
    default:
      return [];
  }
}

/** Every entry posted under these keys, by key. */
async function entriesUnder(companyId: string, keys: Key[]): Promise<Map<string, Entry[]>> {
  const refsBySource = new Map<string, Set<string>>();
  for (const key of keys) {
    const refs = refsBySource.get(key.source) ?? new Set<string>();
    refs.add(key.sourceRefId);
    refsBySource.set(key.source, refs);
  }
  const found = new Map<string, Entry[]>();
  for (const [source, refs] of refsBySource) {
    const rows = await inChunks([...refs], (part) =>
      AppDataSource.getRepository(LedgerEntry).find({
        where: { companyId, source: source as LedgerEntrySource, sourceRefId: In(part) },
        select: ENTRY_COLUMNS,
      }),
    );
    for (const row of rows) push(found, keyOf(row), row);
  }
  return found;
}

/*
 * Before v1.47.0 voiding a paid invoice or bill reversed its payments as well
 * as its issue, all under the void's own key, so nothing is posted under the
 * payments' own keys. A void can therefore be reversing the document's
 * payments, and a payment can be reversed under its document's void.
 */

/** The key each payment's invoice or bill is voided under. */
async function voidsOfPayments(payments: Entry[]): Promise<Key[]> {
  const invoicePaymentIds = uniqueIds(
    payments.filter((entry) => entry.source === "invoice_payment").map((e) => e.sourceRefId),
  );
  const billPaymentIds = uniqueIds(
    payments
      .filter((entry) => entry.source === "manual" && entry.sourceRefId?.startsWith(BILL_PAYMENT))
      .map((entry) => entry.sourceRefId!.slice(BILL_PAYMENT.length)),
  );
  const [invoicePayments, billPayments] = await Promise.all([
    inChunks(invoicePaymentIds, (ids) =>
      AppDataSource.getRepository(InvoicePayment).find({
        where: { id: In(ids) },
        select: ["id", "invoiceId"],
      }),
    ),
    inChunks(billPaymentIds, (ids) =>
      AppDataSource.getRepository(BillPayment).find({
        where: { id: In(ids) },
        select: ["id", "billId"],
      }),
    ),
  ]);
  return [
    ...invoicePayments.map((p) => ({ source: "invoice_void", sourceRefId: p.invoiceId })),
    ...billPayments.map((p) => ({ source: "manual", sourceRefId: `${BILL_VOID}${p.billId}` })),
  ];
}

/** The payment entries of each voided invoice or bill, by the key it is voided under. */
async function paymentsOfVoids(companyId: string, keys: Key[]): Promise<Map<string, Entry[]>> {
  const invoiceIds = uniqueIds(
    keys
      .filter((key) => key.source === "invoice_void" && !key.sourceRefId.endsWith(PAYMENT_DELETION))
      .map((key) => key.sourceRefId),
  );
  const billIds = uniqueIds(
    keys
      .filter((key) => key.source === "manual" && key.sourceRefId.startsWith(BILL_VOID))
      .map((key) => key.sourceRefId.slice(BILL_VOID.length)),
  );
  const [invoicePayments, billPayments] = await Promise.all([
    inChunks(invoiceIds, (ids) =>
      AppDataSource.getRepository(InvoicePayment).find({
        where: { invoiceId: In(ids) },
        select: ["id", "invoiceId"],
      }),
    ),
    inChunks(billIds, (ids) =>
      AppDataSource.getRepository(BillPayment).find({
        where: { billId: In(ids) },
        select: ["id", "billId"],
      }),
    ),
  ]);
  const voidOf = new Map<string, string>([
    ...invoicePayments.map(
      (p) =>
        [
          keyOf({ source: "invoice_payment", sourceRefId: p.id }),
          keyOf({ source: "invoice_void", sourceRefId: p.invoiceId }),
        ] as const,
    ),
    ...billPayments.map(
      (p) =>
        [
          keyOf({ source: "manual", sourceRefId: `${BILL_PAYMENT}${p.id}` }),
          keyOf({ source: "manual", sourceRefId: `${BILL_VOID}${p.billId}` }),
        ] as const,
    ),
  ]);
  const found = await entriesUnder(companyId, [
    ...invoicePayments.map((p) => ({ source: "invoice_payment", sourceRefId: p.id })),
    ...billPayments.map((p) => ({ source: "manual", sourceRefId: `${BILL_PAYMENT}${p.id}` })),
  ]);
  const byVoid = new Map<string, Entry[]>();
  for (const [paymentKey, payments] of found) {
    const voidKey = voidOf.get(paymentKey);
    if (voidKey) for (const payment of payments) push(byVoid, voidKey, payment);
  }
  return byVoid;
}

/** What the lines leave on each account, as debits minus credits; zeros drop out. */
function netPerAccount(
  lines: ReadonlyArray<Pick<BookedLine, "accountId" | "debitCents" | "creditCents">>,
): Map<string, number> {
  const net = new Map<string, number>();
  for (const line of lines) {
    net.set(line.accountId, (net.get(line.accountId) ?? 0) + line.debitCents - line.creditCents);
  }
  for (const [accountId, cents] of net) if (cents === 0) net.delete(accountId);
  return net;
}

function pick(entry: Entry): DriftEntry {
  return {
    id: entry.id,
    source: entry.source,
    sourceRefId: entry.sourceRefId,
    date: entry.date,
    memo: entry.memo,
    createdById: entry.createdById,
    createdAt: entry.createdAt,
  };
}

type Unit = { entry: Entry | null; reversals: Entry[] };

/** What a reversed entry and its reversals leave on the books, or null when it is nothing. */
function judge(args: {
  unit: Unit;
  changesOf: Map<string, Entry[]>;
  ownOf: Map<string, LedgerLine[]>;
  bookedOf: Map<string, BookedLine[]>;
  accountOf: Map<string, Pick<Account, "id" | "code" | "name" | "type">>;
}): ReviewedCategoryDrift | null {
  const { unit, changesOf, ownOf, bookedOf, accountOf } = args;
  const { entry } = unit;
  const reversals = [...unit.reversals].sort(oldestFirst);
  const members = entry ? [entry, ...reversals] : reversals;
  const leftover = netPerAccount(members.flatMap((member) => bookedOf.get(member.id) ?? []));
  if (leftover.size === 0) return null;

  const reversedAt = reversals[0].createdAt.getTime();
  const changes = members
    .flatMap((member) =>
      (changesOf.get(member.id) ?? []).map((change) => ({ change, changed: member })),
    )
    .sort((a, b) => oldestFirst(a.change, b.change))
    .map(
      ({ change, changed }): DriftChange => ({
        ...pick(change),
        changedEntryId: changed.id,
        cause:
          changed !== entry
            ? "approved_on_reversal"
            : change.createdAt.getTime() < reversedAt
              ? "reversed_without_it"
              : "approved_after_reversal",
      }),
    );
  const amounts = [...leftover]
    .map(([accountId, cents]) => {
      const account = accountOf.get(accountId);
      return { accountId, code: account?.code ?? "", name: account?.name ?? "", cents };
    })
    .sort((a, b) => b.cents - a.cents || a.code.localeCompare(b.code));

  const problem = ((): string | null => {
    if (!entry) return "It reverses an entry that isn't in the books";
    if (reversals.length > 1) return "It was reversed more than once";
    if (netPerAccount(members.flatMap((member) => ownOf.get(member.id) ?? [])).size > 0) {
      return "Its reversal doesn't match it line for line, so more than a category change is left over";
    }
    const byType = new Map<AccountType, number>();
    for (const amount of amounts) {
      const type = accountOf.get(amount.accountId)?.type;
      if (type !== "expense" && type !== "revenue") {
        return "Money is left on an account that isn't an income or expense category";
      }
      byType.set(type, (byType.get(type) ?? 0) + amount.cents);
    }
    if ([...byType.values()].some((cents) => cents !== 0)) {
      return "A change moved money between income and expense";
    }
    return null;
  })();

  return {
    kind: problem ? "unrecognized" : "left_behind",
    entry: entry ? pick(entry) : null,
    reversals: reversals.map(pick),
    changes,
    leftover: amounts,
    repair: problem
      ? null
      : {
          kind: "reclassify",
          // Debits first, the way the rest of the ledger reads.
          lines: amounts
            .map((amount) => ({
              accountId: amount.accountId,
              debitCents: Math.max(-amount.cents, 0),
              creditCents: Math.max(amount.cents, 0),
            }))
            .sort((a, b) => b.debitCents - a.debitCents || b.creditCents - a.creditCents),
        },
    problem,
  };
}

/**
 * Every reversed entry in the company that still carries a category Entry
 * review gave it or its reversal, the most recently reversed first.
 */
export async function findReviewedCategoryDrift(
  companyId: string,
): Promise<ReviewedCategoryDrift[]> {
  const entries = AppDataSource.getRepository(LedgerEntry);
  const changes = await entries.find({
    where: { companyId, source: "ledger_reclass" },
    select: ENTRY_COLUMNS,
  });
  if (changes.length === 0) return [];
  const changesOf = new Map<string, Entry[]>();
  for (const change of changes) if (change.sourceRefId) push(changesOf, change.sourceRefId, change);

  // The entries Entry review re-filed, and the keys their reversals are posted under.
  const changed = await inChunks(uniqueIds([...changesOf.keys()]), (ids) =>
    entries.find({ where: { companyId, id: In(ids) }, select: ENTRY_COLUMNS }),
  );
  const keys = new Map<string, Key>();
  const addKey = (key: Key | null) => {
    if (key) keys.set(keyOf(key), key);
  };
  for (const entry of changed) {
    if (!isReversal(entry)) addKey(ownReversalKey(entry));
    else if (entry.sourceRefId) addKey({ source: entry.source, sourceRefId: entry.sourceRefId });
  }
  for (const key of await voidsOfPayments(changed)) addKey(key);

  // What was posted under each key, and every entry those reversals can be reversing.
  const posted = await entriesUnder(companyId, [...keys.values()]);
  const reversedUnder = [...posted.keys()].map((k) => keys.get(k)!);
  if (reversedUnder.length === 0) return [];
  const [originals, voidedPayments, undone] = await Promise.all([
    entriesUnder(companyId, reversedUnder.flatMap(reversedKeys)),
    paymentsOfVoids(companyId, reversedUnder),
    inChunks(
      uniqueIds(
        reversedUnder.filter((key) => key.source === BANK_UNDO).map((key) => key.sourceRefId),
      ),
      (ids) =>
        entries.find({
          where: { companyId, id: In(ids), source: "bank_categorization" },
          select: ENTRY_COLUMNS,
        }),
    ),
  ]);
  const undoneById = new Map<string, Entry>(undone.map((entry) => [entry.id, entry]));

  // Pair each reversal with the entry it reverses. A reversal posted by
  // `reverseLedgerEntriesForSources` names it; any other reversal is the only
  // one posted for the only entry its key can reverse.
  const units = new Map<string, Unit>();
  const orphans: Unit[] = [];
  for (const [k, reversals] of posted) {
    const key = keys.get(k)!;
    const own =
      key.source === BANK_UNDO
        ? [undoneById.get(key.sourceRefId)].filter((entry): entry is Entry => !!entry)
        : reversedKeys(key).flatMap((reversedKey) => originals.get(keyOf(reversedKey)) ?? []);
    const candidates = [...own, ...(voidedPayments.get(k) ?? [])];
    for (const reversal of reversals) {
      const names = REVERSES.exec(reversal.memo)?.[1]?.toLowerCase();
      const entry = names
        ? candidates.find((candidate) => candidate.id.toLowerCase().startsWith(names))
        : own.length === 1
          ? own[0]
          : undefined;
      if (!entry) {
        orphans.push({ entry: null, reversals: [reversal] });
        continue;
      }
      const unit = units.get(entry.id) ?? { entry, reversals: [] };
      unit.reversals.push(reversal);
      units.set(entry.id, unit);
    }
  }

  // Only what Entry review changed can have drifted this way.
  const touched = [...units.values(), ...orphans].filter((unit) =>
    [unit.entry, ...unit.reversals].some((member) => member && changesOf.has(member.id)),
  );
  if (touched.length === 0) return [];
  const memberIds = uniqueIds(
    touched.flatMap((unit) => [unit.entry?.id, ...unit.reversals.map((r) => r.id)]),
  );
  const [ownLines, booked, accounts] = await Promise.all([
    inChunks(memberIds, (ids) =>
      AppDataSource.getRepository(LedgerLine).find({
        where: { companyId, ledgerEntryId: In(ids) },
        select: ["id", "ledgerEntryId", "accountId", "debitCents", "creditCents"],
      }),
    ),
    inChunks(memberIds, async (ids) => [...(await bookedLines(companyId, ids))]),
    AppDataSource.getRepository(Account).find({
      where: { companyId },
      select: ["id", "code", "name", "type"],
    }),
  ]);
  const ownOf = new Map<string, LedgerLine[]>();
  for (const line of ownLines) push(ownOf, line.ledgerEntryId, line);
  const bookedOf = new Map(booked);
  const accountOf = new Map(accounts.map((account) => [account.id, account]));

  const drifts = touched
    .map((unit) => judge({ unit, changesOf, ownOf, bookedOf, accountOf }))
    .filter((drift): drift is ReviewedCategoryDrift => !!drift);
  const reversedAt = (drift: ReviewedCategoryDrift) => drift.reversals[0];
  return drifts.sort(
    (a, b) =>
      reversedAt(b).date.getTime() - reversedAt(a).date.getTime() ||
      -oldestFirst(reversedAt(a), reversedAt(b)),
  );
}
