import { In, Not } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Account } from "../db/entities/Account.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { LedgerEntry, type LedgerReviewStatus } from "../db/entities/LedgerEntry.js";
import { LedgerLine } from "../db/entities/LedgerLine.js";
import { Membership } from "../db/entities/Membership.js";
import { Company } from "../db/entities/Company.js";
import { createNotifications } from "./notifications.js";
import { postLedgerEntry } from "./ledger.js";

export type LedgerReviewChange = {
  lineId: string;
  fromAccountId: string;
  toAccountId: string;
};

export type LedgerReviewChangeInput = {
  lineId: string;
  accountId: string;
};

export type HydratedLedgerEntry = LedgerEntry & {
  lines: LedgerLine[];
  totalCents: number;
  reviewChanges: LedgerReviewChange[];
  reviewedByEmployee: {
    id: string;
    name: string;
    slug: string;
  } | null;
};

function parseReviewChanges(raw: string | null): LedgerReviewChange[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (change): change is LedgerReviewChange =>
        !!change &&
        typeof change === "object" &&
        typeof (change as LedgerReviewChange).lineId === "string" &&
        typeof (change as LedgerReviewChange).fromAccountId === "string" &&
        typeof (change as LedgerReviewChange).toAccountId === "string",
    );
  } catch {
    return [];
  }
}

export async function hydrateLedgerEntries(entries: LedgerEntry[]): Promise<HydratedLedgerEntry[]> {
  if (entries.length === 0) return [];
  const reviewerIds = [
    ...new Set(
      entries.map((entry) => entry.reviewedByEmployeeId).filter((id): id is string => !!id),
    ),
  ];
  const [lines, reviewers] = await Promise.all([
    AppDataSource.getRepository(LedgerLine).find({
      where: { ledgerEntryId: In(entries.map((entry) => entry.id)) },
      order: { sortOrder: "ASC" },
    }),
    reviewerIds.length
      ? AppDataSource.getRepository(AIEmployee).find({
          where: { id: In(reviewerIds) },
          select: ["id", "name", "slug"],
        })
      : Promise.resolve([]),
  ]);
  const byEntry = new Map<string, LedgerLine[]>();
  for (const line of lines) {
    const existing = byEntry.get(line.ledgerEntryId) ?? [];
    existing.push(line);
    byEntry.set(line.ledgerEntryId, existing);
  }
  const reviewerById = new Map(reviewers.map((reviewer) => [reviewer.id, reviewer]));
  return entries.map((entry) => {
    const entryLines = byEntry.get(entry.id) ?? [];
    const reviewer = entry.reviewedByEmployeeId
      ? reviewerById.get(entry.reviewedByEmployeeId)
      : null;
    return {
      ...entry,
      lines: entryLines,
      totalCents: entryLines.reduce((sum, line) => sum + line.debitCents, 0),
      reviewChanges: parseReviewChanges(entry.reviewChangesJson),
      reviewedByEmployee: reviewer
        ? { id: reviewer.id, name: reviewer.name, slug: reviewer.slug }
        : null,
    };
  });
}

export async function listLedgerEntriesForReview(args: {
  companyId: string;
  reviewStatus?: LedgerReviewStatus;
  source?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}): Promise<HydratedLedgerEntry[]> {
  const qb = AppDataSource.getRepository(LedgerEntry)
    .createQueryBuilder("entry")
    .where("entry.companyId = :companyId", { companyId: args.companyId })
    .andWhere("entry.source != :reviewReclassSource", {
      reviewReclassSource: "ledger_reclass",
    })
    .orderBy("entry.date", "DESC")
    .addOrderBy("entry.createdAt", "DESC")
    .take(Math.min(Math.max(args.limit ?? 200, 1), 500));
  if (args.reviewStatus) {
    qb.andWhere("entry.reviewStatus = :reviewStatus", {
      reviewStatus: args.reviewStatus,
    });
  }
  if (args.source) qb.andWhere("entry.source = :source", { source: args.source });
  if (args.from) qb.andWhere("entry.date >= :from", { from: args.from });
  if (args.to) {
    const through = new Date(args.to.getTime());
    through.setUTCHours(23, 59, 59, 999);
    qb.andWhere("entry.date <= :to", { to: through });
  }
  return hydrateLedgerEntries(await qb.getMany());
}

export async function getLedgerEntryForReview(
  companyId: string,
  entryId: string,
): Promise<HydratedLedgerEntry | null> {
  const entry = await AppDataSource.getRepository(LedgerEntry).findOneBy({
    id: entryId,
    companyId,
  });
  if (!entry) return null;
  const [hydrated] = await hydrateLedgerEntries([entry]);
  return hydrated ?? null;
}

export async function ledgerReviewSummary(companyId: string): Promise<{
  unreviewed: number;
  aiReviewed: number;
  approved: number;
}> {
  const repo = AppDataSource.getRepository(LedgerEntry);
  const [unreviewed, aiReviewed, approved] = await Promise.all([
    repo.count({
      where: { companyId, reviewStatus: "unreviewed", source: Not("ledger_reclass") },
    }),
    repo.count({
      where: { companyId, reviewStatus: "ai_reviewed", source: Not("ledger_reclass") },
    }),
    repo.count({
      where: { companyId, reviewStatus: "approved", source: Not("ledger_reclass") },
    }),
  ]);
  return { unreviewed, aiReviewed, approved };
}

async function validateReviewChanges(
  companyId: string,
  entry: LedgerEntry,
  changes: LedgerReviewChangeInput[],
): Promise<LedgerReviewChange[]> {
  if (changes.length === 0) return [];
  const lineIds = changes.map((change) => change.lineId);
  if (new Set(lineIds).size !== lineIds.length) {
    throw new Error("Each ledger line can have only one category change");
  }
  const lines = await AppDataSource.getRepository(LedgerLine).find({
    where: { id: In(lineIds), ledgerEntryId: entry.id, companyId },
  });
  if (lines.length !== lineIds.length) {
    throw new Error("One or more proposed ledger lines do not belong to this transaction");
  }
  const lineById = new Map(lines.map((line) => [line.id, line]));
  const accountIds = [
    ...new Set([
      ...lines.map((line) => line.accountId),
      ...changes.map((change) => change.accountId),
    ]),
  ];
  const accounts = await AppDataSource.getRepository(Account).find({
    where: { id: In(accountIds), companyId },
  });
  if (accounts.length !== accountIds.length) {
    throw new Error("One or more proposed categories are missing or belong to another company");
  }
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const validated: LedgerReviewChange[] = [];
  for (const change of changes) {
    const line = lineById.get(change.lineId)!;
    if (line.accountId === change.accountId) continue;
    const from = accountById.get(line.accountId)!;
    const to = accountById.get(change.accountId)!;
    if (from.type !== "expense" && from.type !== "revenue") {
      throw new Error("Only expense and revenue category lines can be reclassified here");
    }
    if (from.type !== to.type) {
      throw new Error(`A ${from.type} line can only move to another ${from.type} account`);
    }
    if (to.archivedAt) throw new Error(`Category ${to.code} ${to.name} is archived`);
    validated.push({
      lineId: line.id,
      fromAccountId: line.accountId,
      toAccountId: to.id,
    });
  }
  return validated;
}

export async function stageAiLedgerReview(args: {
  companyId: string;
  entryId: string;
  employeeId: string;
  changes: LedgerReviewChangeInput[];
  note?: string;
}): Promise<HydratedLedgerEntry> {
  const repo = AppDataSource.getRepository(LedgerEntry);
  const entry = await repo.findOneBy({ id: args.entryId, companyId: args.companyId });
  if (!entry) throw new Error("Transaction not found");
  if (entry.reviewStatus === "approved") {
    throw new Error("This transaction already has final human approval");
  }
  const changes = await validateReviewChanges(args.companyId, entry, args.changes);
  entry.reviewStatus = "ai_reviewed";
  entry.reviewChangesJson = JSON.stringify(changes);
  entry.reviewNote = args.note?.trim() || null;
  entry.reviewedByEmployeeId = args.employeeId;
  entry.reviewedAt = new Date();
  await repo.save(entry);
  await notifyFinanceReviewReady(entry, args.employeeId);
  return (await getLedgerEntryForReview(args.companyId, entry.id))!;
}

export async function approveLedgerReview(args: {
  companyId: string;
  entryId: string;
  userId: string;
  changes?: LedgerReviewChangeInput[];
  note?: string;
}): Promise<HydratedLedgerEntry> {
  const repo = AppDataSource.getRepository(LedgerEntry);
  const entry = await repo.findOneBy({ id: args.entryId, companyId: args.companyId });
  if (!entry) throw new Error("Transaction not found");
  if (entry.reviewStatus === "approved") {
    return (await getLedgerEntryForReview(args.companyId, entry.id))!;
  }
  const staged = parseReviewChanges(entry.reviewChangesJson).map((change) => ({
    lineId: change.lineId,
    accountId: change.toAccountId,
  }));
  const changes = await validateReviewChanges(args.companyId, entry, args.changes ?? staged);

  if (changes.length > 0) {
    const alreadyPosted = await AppDataSource.getRepository(LedgerEntry).findOneBy({
      companyId: args.companyId,
      source: "ledger_reclass",
      sourceRefId: entry.id,
    });
    if (!alreadyPosted) {
      const lines = await AppDataSource.getRepository(LedgerLine).find({
        where: { id: In(changes.map((change) => change.lineId)) },
      });
      const lineById = new Map(lines.map((line) => [line.id, line]));
      await postLedgerEntry({
        companyId: args.companyId,
        // A category correction belongs to the same accounting period as the
        // transaction it corrects, so historical statements remain accurate.
        date: entry.date,
        memo: `Approved category changes for ${entry.memo || entry.id.slice(0, 8)}`,
        source: "ledger_reclass",
        sourceRefId: entry.id,
        createdById: args.userId,
        reviewStatus: "approved",
        lines: changes.flatMap((change) => {
          const line = lineById.get(change.lineId)!;
          const amount = line.debitCents || line.creditCents;
          const description = `Reclassifies ${entry.id.slice(0, 8)}`;
          return line.debitCents > 0
            ? [
                { accountId: change.toAccountId, debitCents: amount, description },
                { accountId: change.fromAccountId, creditCents: amount, description },
              ]
            : [
                { accountId: change.fromAccountId, debitCents: amount, description },
                { accountId: change.toAccountId, creditCents: amount, description },
              ];
        }),
      });
    }
  }

  entry.reviewStatus = "approved";
  entry.reviewChangesJson = JSON.stringify(changes);
  if (args.note !== undefined) entry.reviewNote = args.note.trim() || null;
  entry.approvedById = args.userId;
  entry.approvedAt = new Date();
  await repo.save(entry);
  return (await getLedgerEntryForReview(args.companyId, entry.id))!;
}

export async function returnLedgerReview(args: {
  companyId: string;
  entryId: string;
  note?: string;
}): Promise<HydratedLedgerEntry> {
  const repo = AppDataSource.getRepository(LedgerEntry);
  const entry = await repo.findOneBy({ id: args.entryId, companyId: args.companyId });
  if (!entry) throw new Error("Transaction not found");
  if (entry.reviewStatus === "approved") {
    throw new Error("An approved transaction cannot be returned to the review queue");
  }
  entry.reviewStatus = "unreviewed";
  entry.reviewChangesJson = null;
  entry.reviewNote = args.note?.trim() || null;
  entry.reviewedByEmployeeId = null;
  entry.reviewedAt = null;
  await repo.save(entry);
  return (await getLedgerEntryForReview(args.companyId, entry.id))!;
}

export type BulkReviewAction = "approve" | "return" | "delete" | "recategorize";

export type BulkReviewResult = {
  action: BulkReviewAction;
  succeeded: string[];
  skipped: Array<{ id: string; reason: string }>;
};

/**
 * Apply one review action to a batch of transactions. Each entry is handled
 * independently: a failure on one (already approved, wrong line shape, …)
 * records a skip reason and never aborts the rest of the batch. Approve,
 * return, and recategorize all post through the single-entry helpers so the
 * ledger side effects and validation stay identical to the one-at-a-time flow.
 */
export async function bulkLedgerReview(args: {
  companyId: string;
  userId: string;
  action: BulkReviewAction;
  entryIds: string[];
  toAccountId?: string;
  note?: string;
}): Promise<BulkReviewResult> {
  const ids = [...new Set(args.entryIds)];
  const succeeded: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  if (args.action === "recategorize") {
    return recategorizeBatch({ ...args, entryIds: ids });
  }

  for (const id of ids) {
    try {
      if (args.action === "approve") {
        await approveLedgerReview({
          companyId: args.companyId,
          entryId: id,
          userId: args.userId,
          note: args.note,
        });
      } else if (args.action === "return") {
        await returnLedgerReview({ companyId: args.companyId, entryId: id, note: args.note });
      } else {
        await deleteLedgerEntry(args.companyId, id);
      }
      succeeded.push(id);
    } catch (err) {
      skipped.push({ id, reason: (err as Error).message || "Could not update transaction" });
    }
  }
  return { action: args.action, succeeded, skipped };
}

/** Mirrors the single-entry DELETE guard: only unapproved, manually posted
 *  transactions can be removed; everything else must be voided at the source. */
async function deleteLedgerEntry(companyId: string, entryId: string): Promise<void> {
  const repo = AppDataSource.getRepository(LedgerEntry);
  const entry = await repo.findOneBy({ id: entryId, companyId });
  if (!entry) throw new Error("Transaction not found");
  if (entry.reviewStatus === "approved") {
    throw new Error("Approved transactions are locked — post a reversing entry instead");
  }
  if (entry.source !== "manual") {
    throw new Error("Auto-posted entries cannot be deleted — void the source instead");
  }
  await AppDataSource.getRepository(LedgerLine).delete({ ledgerEntryId: entry.id });
  await repo.delete({ id: entry.id });
}

/** Move every selected transaction's single expense/revenue line to one target
 *  category and approve it in the same step (posting a reclass is itself the
 *  human sign-off). Transactions whose editable line does not match the target
 *  account type, or that carry more than one such line, are skipped so the
 *  owner can open them and decide by hand. */
async function recategorizeBatch(args: {
  companyId: string;
  userId: string;
  entryIds: string[];
  toAccountId?: string;
  note?: string;
}): Promise<BulkReviewResult> {
  const succeeded: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  if (!args.toAccountId) {
    return { action: "recategorize", succeeded, skipped };
  }
  const target = await AppDataSource.getRepository(Account).findOneBy({
    id: args.toAccountId,
    companyId: args.companyId,
  });
  if (!target) throw new Error("Target category not found");
  if (target.type !== "expense" && target.type !== "revenue") {
    throw new Error("Only expense and revenue categories can be applied in bulk");
  }
  if (target.archivedAt) throw new Error(`Category ${target.code} ${target.name} is archived`);

  const accounts = await AppDataSource.getRepository(Account).find({
    where: { companyId: args.companyId },
  });
  const accountById = new Map(accounts.map((account) => [account.id, account]));

  for (const id of args.entryIds) {
    try {
      const entry = await getLedgerEntryForReview(args.companyId, id);
      if (!entry) throw new Error("Transaction not found");
      if (entry.reviewStatus === "approved") {
        throw new Error("Already approved — locked");
      }
      const candidates = entry.lines.filter(
        (line) => accountById.get(line.accountId)?.type === target.type,
      );
      if (candidates.length === 0) {
        throw new Error(`No ${target.type} line to recategorize`);
      }
      if (candidates.length > 1) {
        throw new Error(`Has ${candidates.length} ${target.type} lines — open it to choose`);
      }
      await approveLedgerReview({
        companyId: args.companyId,
        entryId: id,
        userId: args.userId,
        changes: [{ lineId: candidates[0].id, accountId: target.id }],
        note: args.note,
      });
      succeeded.push(id);
    } catch (err) {
      skipped.push({ id, reason: (err as Error).message || "Could not recategorize" });
    }
  }
  return { action: "recategorize", succeeded, skipped };
}

async function notifyFinanceReviewReady(entry: LedgerEntry, employeeId: string): Promise<void> {
  const [company, employee, memberships] = await Promise.all([
    AppDataSource.getRepository(Company).findOneBy({ id: entry.companyId }),
    AppDataSource.getRepository(AIEmployee).findOneBy({ id: employeeId }),
    AppDataSource.getRepository(Membership).find({
      where: { companyId: entry.companyId, role: In(["owner", "admin"]) },
    }),
  ]);
  if (!company || !employee || memberships.length === 0) return;
  await createNotifications(
    memberships.map((membership) => ({
      companyId: entry.companyId,
      userId: membership.userId,
      kind: "finance_review_ready" as const,
      title: `${employee.name} reviewed a finance transaction`,
      body: entry.memo || `Transaction ${entry.id.slice(0, 8)} is ready for final approval.`,
      link: `/c/${company.slug}/finance/transactions?status=ai_reviewed`,
      actorKind: "ai" as const,
      actorId: employee.id,
      entityKind: "ledger_entry" as const,
      entityId: entry.id,
    })),
  );
}
