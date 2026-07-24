import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import {
  FinanceProposal,
  type FinanceProposalActorType,
  type FinanceProposalStatus,
} from "../db/entities/FinanceProposal.js";
import { postLedgerEntry } from "./ledger.js";

/**
 * The finance-proposal spine (M33 A3).
 *
 * A proposal is a *staged* finance mutation: it is validated and stored but
 * never executed at create time. It sits `pending` until a human applies it
 * (dispatched by `kind` to the real finance service) or rejects it. This is
 * two things at once:
 *
 *   1. The maker-checker control for humans — one member proposes a balanced
 *      journal entry, another applies it (segregation of duties).
 *   2. The spine every AI-authored ledger effect will flow through in later
 *      M33 increments. AI employees can propose; the apply step is always a
 *      human hand, so no AI ever moves money unattended.
 *
 * Add a kind by extending `FinanceProposalKind`, adding a payload schema, and
 * adding a case to `dispatchApply`. The queue, the apply gate and the audit
 * fields are all kind-agnostic.
 */

// ─────────────────────────── Payload schemas ───────────────────────────

const journalLineSchema = z.object({
  accountId: z.string().uuid(),
  debitCents: z.number().int().min(0),
  creditCents: z.number().int().min(0),
  description: z.string().max(500).optional(),
});

/** `journal_entry` payload. `date` is an ISO string (date-only or full); it is
 *  re-parsed at apply time so a proposal staged before a period closed still
 *  fails cleanly if the period closed underneath it. */
export const journalEntryPayloadSchema = z.object({
  date: z.string().min(1),
  memo: z.string().max(500).optional().default(""),
  lines: z.array(journalLineSchema).min(2),
});
export type JournalEntryPayload = z.infer<typeof journalEntryPayloadSchema>;

/** Who is staging a proposal. Human proposers pass their userId; AI callers
 *  (later increments) pass the employeeId. `label` is a display-name snapshot
 *  so the queue reads well even after the actor is renamed or removed. */
export type ProposalActor = {
  type: FinanceProposalActorType;
  id: string | null;
  label: string | null;
};

// ─────────────────────── Well-formedness (create) ──────────────────────

/**
 * Reject an obviously-broken journal payload before it ever reaches the queue —
 * unbalanced, zero-sum, or a line with both/neither of debit and credit. Apply
 * re-checks all of this (plus account existence and closed periods) via
 * `postLedgerEntry`; this is just so a reviewer never sees junk.
 */
function assertJournalWellFormed(p: JournalEntryPayload): void {
  let debit = 0;
  let credit = 0;
  for (const l of p.lines) {
    if ((l.debitCents > 0 && l.creditCents > 0) || (l.debitCents === 0 && l.creditCents === 0)) {
      throw new Error("Each line must have exactly one of debit or credit set");
    }
    debit += l.debitCents;
    credit += l.creditCents;
  }
  if (debit === 0) throw new Error("A journal entry needs a non-zero amount");
  if (debit !== credit) {
    throw new Error(`Entry is unbalanced: debits ${debit} ≠ credits ${credit}`);
  }
}

function summarizeJournal(p: JournalEntryPayload): string {
  const total = p.lines.reduce((s, l) => s + l.debitCents, 0);
  const n = p.lines.length;
  return `${n} line${n === 1 ? "" : "s"} · ${(total / 100).toFixed(2)}`;
}

// ─────────────────────────────── Create ────────────────────────────────

/**
 * Stage a journal-entry proposal. Validates the payload shape and balance but
 * does NOT post anything — that waits for a human `apply`.
 */
export async function createJournalEntryProposal(
  companyId: string,
  rawPayload: unknown,
  actor: ProposalActor,
): Promise<FinanceProposal> {
  const payload = journalEntryPayloadSchema.parse(rawPayload);
  assertJournalWellFormed(payload);
  const repo = AppDataSource.getRepository(FinanceProposal);
  const proposal = repo.create({
    companyId,
    kind: "journal_entry",
    status: "pending",
    proposedByType: actor.type,
    proposedById: actor.id,
    proposedByLabel: actor.label,
    title: payload.memo.trim() || "Journal entry",
    summary: summarizeJournal(payload),
    payloadJson: JSON.stringify(payload),
    resultJson: null,
    appliedEntryId: null,
    errorMessage: null,
  });
  return repo.save(proposal);
}

// ─────────────────────────── Apply / reject ────────────────────────────

type ApplyResult = { entryId: string };

/**
 * Apply a pending proposal: dispatch by kind to the real finance service,
 * record what it produced, and mark it applied. The apply step is the human
 * gate — the caller is the reviewer, never the proposer's automation.
 *
 * On failure the proposal is left `pending` (so a human can fix the cause and
 * retry) with `errorMessage` set, and the error is re-thrown for the route.
 */
export async function applyFinanceProposal(
  proposal: FinanceProposal,
  reviewer: { userId: string | null; note?: string | null },
): Promise<FinanceProposal> {
  if (proposal.status !== "pending") {
    throw new Error(`This proposal is already ${proposal.status}`);
  }
  const repo = AppDataSource.getRepository(FinanceProposal);
  let result: ApplyResult;
  try {
    result = await dispatchApply(proposal, reviewer.userId);
  } catch (err) {
    proposal.errorMessage = (err as Error).message;
    await repo.save(proposal);
    throw err;
  }
  proposal.status = "applied";
  proposal.appliedEntryId = result.entryId;
  proposal.resultJson = JSON.stringify(result);
  proposal.errorMessage = null;
  proposal.decidedAt = new Date();
  proposal.decidedByUserId = reviewer.userId;
  proposal.reviewNote = reviewer.note ?? null;
  return repo.save(proposal);
}

async function dispatchApply(
  proposal: FinanceProposal,
  reviewerUserId: string | null,
): Promise<ApplyResult> {
  switch (proposal.kind) {
    case "journal_entry":
      return applyJournalEntry(proposal, reviewerUserId);
    default:
      // Exhaustiveness guard — a new kind must add its case here.
      throw new Error(`Unknown finance-proposal kind: ${proposal.kind as string}`);
  }
}

async function applyJournalEntry(
  proposal: FinanceProposal,
  reviewerUserId: string | null,
): Promise<ApplyResult> {
  const payload = journalEntryPayloadSchema.parse(JSON.parse(proposal.payloadJson));
  const date = new Date(payload.date);
  if (Number.isNaN(date.getTime())) throw new Error("This proposal has an invalid date");
  // `postLedgerEntry` is the source of truth: it re-checks balance, line shape,
  // account membership/archived state, and refuses to post into a closed
  // period. `source: "manual"` with a `finance_proposal:` ref keeps it a real
  // manual journal while tagging it as one that went through the review gate.
  const { entry } = await postLedgerEntry({
    companyId: proposal.companyId,
    date,
    memo: payload.memo || "",
    source: "manual",
    sourceRefId: `finance_proposal:${proposal.id}`,
    createdById: reviewerUserId,
    lines: payload.lines.map((l) => ({
      accountId: l.accountId,
      debitCents: l.debitCents,
      creditCents: l.creditCents,
      description: l.description ?? "",
    })),
  });
  return { entryId: entry.id };
}

/** Reject a pending proposal. Nothing is posted; the record is kept for audit. */
export async function rejectFinanceProposal(
  proposal: FinanceProposal,
  reviewer: { userId: string | null; note?: string | null },
): Promise<FinanceProposal> {
  if (proposal.status !== "pending") {
    throw new Error(`This proposal is already ${proposal.status}`);
  }
  proposal.status = "rejected";
  proposal.decidedAt = new Date();
  proposal.decidedByUserId = reviewer.userId;
  proposal.reviewNote = reviewer.note ?? null;
  return AppDataSource.getRepository(FinanceProposal).save(proposal);
}

// ─────────────────────────────── Read ──────────────────────────────────

export async function listFinanceProposals(
  companyId: string,
  opts?: { status?: FinanceProposalStatus },
): Promise<FinanceProposal[]> {
  const where: { companyId: string; status?: FinanceProposalStatus } = { companyId };
  if (opts?.status) where.status = opts.status;
  return AppDataSource.getRepository(FinanceProposal).find({
    where,
    order: { createdAt: "DESC" },
  });
}

export async function getFinanceProposal(
  companyId: string,
  id: string,
): Promise<FinanceProposal | null> {
  return AppDataSource.getRepository(FinanceProposal).findOneBy({ id, companyId });
}
