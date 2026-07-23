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
 * Derived from the stage's `kind` on every move — never set independently.
 * See `services/revenue/dealStage.ts`, which owns the invariant.
 */
export type DealStatus = "open" | "won" | "lost";

export const DEAL_STATUSES: DealStatus[] = ["open", "won", "lost"];

/**
 * A Deal is one revenue opportunity. See ROADMAP.md M32.
 *
 * The centre of the revenue section, and the object that was missing before it:
 * `Customer` describes somebody you already bill, so there was nowhere to put
 * money you are *trying* to win. Both `customerId` and `primaryContactId` are
 * nullable — a deal routinely starts as a name and a number before either side
 * of that relationship exists.
 *
 * **Ownership can be an AI Employee.** `ownerEmployeeId` is not decoration:
 * assigning a Deal to an employee kicks off a background work session the same
 * way assigning a Todo does (`services/todoKickoff.ts` is the precedent), so
 * "give this to Ava" means she researches the account, drafts the outreach and
 * logs the activity. Exactly one of `ownerId` / `ownerEmployeeId` is set.
 *
 * `amountCents` is capped by the write schema at 2_000_000_000 to stay inside a
 * 32-bit `int` on Postgres, like every other money column since M19.
 *
 * Addressed by `id` rather than a slug: deal titles repeat constantly
 * ("Acme — renewal") and are renamed mid-cycle, so a slug would be neither
 * unique nor stable.
 */
@Entity("deals")
@Index(["companyId", "status"])
@Index(["companyId", "stageId"])
@Index(["companyId", "customerId"])
@Index(["companyId", "primaryContactId"])
@Index(["companyId", "ownerEmployeeId"])
@Index(["companyId", "archivedAt"])
@Index(["companyId", "closedAt"])
@Index(["companyId", "expectedCloseDate"])
export class Deal {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  title!: string;

  @Column({ type: "text", default: "" })
  description!: string;

  /** The account, once there is one. */
  @Column({ type: "varchar", nullable: true })
  customerId!: string | null;

  /** The person driving it. Other stakeholders hang off `DealContact`. */
  @Column({ type: "varchar", nullable: true })
  primaryContactId!: string | null;

  @Column({ type: "varchar" })
  stageId!: string;

  /** Minor units of `currency`. */
  @Column({ type: "int", default: 0 })
  amountCents!: number;

  @Column({ type: "varchar", default: "USD" })
  currency!: string;

  /**
   * Per-deal close likelihood 0-100. Null inherits the stage's default, which
   * is what almost every deal does — an override is a deliberate act by a rep
   * who knows something the stage does not.
   */
  @Column({ type: "int", nullable: true })
  probabilityOverride!: number | null;

  /** Date only in practice, stored as a timestamp for driver portability. */
  @Column({ type: dateTimeColumnType, nullable: true })
  expectedCloseDate!: Date | null;

  /** Mirrors the current stage's `kind`. Never written independently. */
  @Column({ type: "varchar", default: "open" })
  status!: DealStatus;

  /** Set when the deal first reaches a terminal stage; cleared on reopen. */
  @Column({ type: dateTimeColumnType, nullable: true })
  closedAt!: Date | null;

  @Column({ type: "varchar", default: "" })
  lostReason!: string;

  /** Attribution — `google-ads`, `referral`, `signal:seat-expansion`. */
  @Column({ type: "varchar", default: "" })
  source!: string;

  @Column({ type: "varchar", nullable: true })
  ownerId!: string | null;

  @Column({ type: "varchar", nullable: true })
  ownerEmployeeId!: string | null;

  /** One line the owner keeps current: what has to happen next. */
  @Column({ type: "varchar", default: "" })
  nextStep!: string;

  @Column({ type: dateTimeColumnType, nullable: true })
  lastActivityAt!: Date | null;

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
