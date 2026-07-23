import { dateTimeColumnType } from "./columnTypes.js";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * Where a Contact sits in the revenue lifecycle. Deliberately short — a stage
 * ladder nobody maintains is worse than no ladder, and the interesting state
 * (what happened, what is open) lives on `Activity` and `Deal` rather than here.
 */
export type ContactLifecycleStage =
  | "subscriber"
  | "lead"
  | "qualified"
  | "opportunity"
  | "customer"
  | "churned"
  | "unqualified";

export const CONTACT_LIFECYCLE_STAGES: ContactLifecycleStage[] = [
  "subscriber",
  "lead",
  "qualified",
  "opportunity",
  "customer",
  "churned",
  "unqualified",
];

/**
 * A Contact is a **person** in the revenue system. See ROADMAP.md M32.
 *
 * The one design decision that matters here: `customerId` is **nullable**. A
 * Contact can exist before there is any account to attach them to, which is the
 * entire reason this entity exists rather than reusing `CustomerContact` — that
 * table requires a `customerId`, so it can only describe people you already
 * bill. Sales works the other way round: you meet the person first and the
 * billable account, if it ever appears, comes months later.
 *
 * `Customer` remains the **account**. A Customer is simply not billable until it
 * has an invoice, so no separate pre-revenue Account entity is needed and the
 * whole invoice / contract / statement chain keeps working unchanged.
 *
 * Identified in URLs by `id`, not a slug: a person's name is neither unique nor
 * stable, and an email in a path is ugly and leaks the address into logs. This
 * follows the `Todo` / `BaseRecord` precedent rather than the `Customer` one.
 *
 * `email` is indexed but **not** unique-constrained. Uniqueness per company is
 * enforced in `services/revenue/contacts.ts` because the natural constraint
 * ("unique when non-empty") is a partial index, which is not portable across
 * SQLite and Postgres — and plenty of real contacts have no email at all.
 * Addresses are stored already normalized by `lib/emailAddress.ts`.
 *
 * Ownership is `ownerId` (a human Member) **or** `ownerEmployeeId` (an AI
 * Employee), never both — mirroring the split author bookkeeping used by Notes.
 */
@Entity("contacts")
@Index(["companyId", "email"])
@Index(["companyId", "customerId"])
@Index(["companyId", "lifecycleStage"])
@Index(["companyId", "archivedAt"])
@Index(["companyId", "lastActivityAt"])
export class Contact {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  name!: string;

  /** Lowercased and validated on write. Empty when we only have a phone. */
  @Column({ type: "varchar", default: "" })
  email!: string;

  @Column({ type: "varchar", default: "" })
  phone!: string;

  /** Job title, as they'd write it on a business card. */
  @Column({ type: "varchar", default: "" })
  title!: string;

  @Column({ type: "varchar", default: "" })
  linkedinUrl!: string;

  @Column({ type: "varchar", default: "" })
  websiteUrl!: string;

  /**
   * The account they belong to, once one exists. Null for everyone you have
   * not billed yet — which early on is most of the list.
   */
  @Column({ type: "varchar", nullable: true })
  customerId!: string | null;

  /**
   * Free-text employer, for a Contact with no `Customer` row yet. Kept even
   * after `customerId` is set, because the two disagree often enough (parent
   * company vs. billing entity) that overwriting it loses information.
   */
  @Column({ type: "varchar", default: "" })
  companyName!: string;

  @Column({ type: "varchar", default: "lead" })
  lifecycleStage!: ContactLifecycleStage;

  /** Human Member who owns the relationship. Mutually exclusive with the below. */
  @Column({ type: "varchar", nullable: true })
  ownerId!: string | null;

  /** AI Employee who owns the relationship. */
  @Column({ type: "varchar", nullable: true })
  ownerEmployeeId!: string | null;

  /** Where they came from — `signal:trial-expiring`, `google-ads`, `referral`. */
  @Column({ type: "varchar", default: "" })
  source!: string;

  @Column({ type: "varchar", default: "" })
  sourceDetail!: string;

  /** 0-100 fit/intent score. 0 means unscored, not "bad". */
  @Column({ type: "int", default: 0 })
  score!: number;

  /** Free-form JSON from an enrichment provider the company brought its own key for. */
  @Column({ type: "text", nullable: true })
  enrichedJson!: string | null;

  @Column({ type: "text", default: "" })
  notes!: string;

  /**
   * Hard opt-out set by a human. Distinct from a `Suppression` row: this says
   * "never contact this person", the suppression list says "never mail this
   * address". Both are checked; either one blocks.
   */
  @Column({ type: "boolean", default: false })
  doNotContact!: boolean;

  /** Set when they use an unsubscribe link. Never cleared automatically. */
  @Column({ type: dateTimeColumnType, nullable: true })
  unsubscribedAt!: Date | null;

  /** Set when mail to them hard-bounces. */
  @Column({ type: dateTimeColumnType, nullable: true })
  bouncedAt!: Date | null;

  /**
   * Denormalized from the newest `Activity`, so the contact list can sort by
   * "most recently touched" without an aggregate per row.
   */
  @Column({ type: dateTimeColumnType, nullable: true })
  lastActivityAt!: Date | null;

  /** Soft-delete: archived contacts stay on historical activities and deals. */
  @Column({ type: dateTimeColumnType, nullable: true })
  archivedAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  @Column({ type: "varchar", nullable: true })
  createdByEmployeeId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
