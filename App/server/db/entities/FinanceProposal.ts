import { dateTimeColumnType } from "./columnTypes.js";
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

/**
 * Finance-proposal kinds. Each kind owns an `apply` path in
 * `services/financeProposals.ts` that dispatches to the real finance service,
 * plus its own payload shape validated at both create and apply time.
 *
 *   - `journal_entry` — a proposed manual balanced journal entry. Applying it
 *                       posts the entry via `postLedgerEntry`. Payload is
 *                       `{ date, memo, lines: [{ accountId, debitCents,
 *                       creditCents, description? }] }`.
 *
 * More kinds (bank categorization, bill creation, credit notes) land in later
 * M33 increments; the spine, the queue and the apply gate are kind-agnostic.
 */
export type FinanceProposalKind = "journal_entry";

export type FinanceProposalStatus = "pending" | "applied" | "rejected" | "superseded";

/** A human member staged it, or an AI employee did. */
export type FinanceProposalActorType = "human" | "ai";

/**
 * A staged, human-reviewed finance mutation — the spine every AI-authored
 * ledger effect flows through, and the maker-checker control for humans: one
 * member proposes a balanced journal entry, another applies it. Modelled on
 * `Approval` (the general human-in-the-loop gate) but finance-specific: it
 * links to the `LedgerEntry` an apply produces and lives behind the finance
 * surface.
 *
 * The proposed mutation is never executed at create time. It sits `pending`
 * until a member applies it (dispatched by `kind`) or rejects it. AI employees
 * can propose but never apply — the apply step is always a human hand.
 */
@Index(["companyId", "status"])
@Entity("finance_proposals")
export class FinanceProposal {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar", default: "journal_entry" })
  kind!: FinanceProposalKind;

  @Column({ type: "varchar", default: "pending" })
  status!: FinanceProposalStatus;

  /** Who staged this. AI proposals never apply themselves; a human always
   *  drives the apply step regardless of proposer. */
  @Column({ type: "varchar", default: "human" })
  proposedByType!: FinanceProposalActorType;

  /** userId for human proposers, employeeId for AI. Null only for legacy rows. */
  @Column({ type: "varchar", nullable: true })
  proposedById!: string | null;

  /** Display-name snapshot taken at propose time, so the queue still reads well
   *  after the member or employee is renamed or removed. */
  @Column({ type: "varchar", nullable: true })
  proposedByLabel!: string | null;

  /** Short label for the review-queue row. */
  @Column({ type: "varchar" })
  title!: string;

  /** One-line plain-text description of the effect. */
  @Column({ type: "text", nullable: true })
  summary!: string | null;

  /** The kind-specific proposed mutation, JSON-encoded. Validated on create and
   *  re-validated on apply (the world may have moved on since it was staged). */
  @Column({ type: "text" })
  payloadJson!: string;

  /** Outcome JSON written on a successful apply (e.g. `{ entryId }`). Null while
   *  pending and on rejection. */
  @Column({ type: "text", nullable: true })
  resultJson!: string | null;

  /** The `LedgerEntry` an apply produced, when the kind posts one — the durable
   *  link from a proposal to its books effect. Null while pending / on reject. */
  @Index()
  @Column({ type: "varchar", nullable: true })
  appliedEntryId!: string | null;

  /** Failure message if apply threw. The proposal stays `pending` (a human can
   *  fix the cause and retry), but the reason is surfaced in the queue. */
  @Column({ type: "text", nullable: true })
  errorMessage!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @Column({ type: dateTimeColumnType, nullable: true })
  decidedAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  decidedByUserId!: string | null;

  /** The reviewer's note recorded on apply or reject. */
  @Column({ type: "text", nullable: true })
  reviewNote!: string | null;
}
