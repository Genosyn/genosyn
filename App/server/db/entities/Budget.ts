import { dateTimeColumnType } from "./columnTypes.js";
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from "typeorm";

/**
 * A monthly ad-spend envelope (M53) — the first Budget, scoped to the one
 * seam where an AI Employee can move money today: authorized ad-platform
 * budget deltas (`AdSpendEvent`). A human writes the envelope once; the
 * enforcement runs on every spend-increasing mutation, beside the
 * per-Connection caps, so thousands of in-budget actions proceed without a
 * human and the exhausted case refuses loudly.
 *
 * Scoping: null `connectionId` and `employeeId` cover the whole company; a
 * Connection scope caps one ad account's platform; an employee scope caps
 * one employee across every platform. All applicable budgets must pass — the
 * tightest one binds.
 *
 * Amounts are integer minor units, the company-wide money rule. Sums ignore
 * currency exactly as the rolling caps do — FX conversion for caps remains
 * deferred (M26) and this row inherits that stance.
 */
@Entity("budgets")
@Index(["companyId", "enabled"])
export class Budget {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  name!: string;

  /** The calendar-month envelope, in minor units. */
  @Column({ type: "integer" })
  amountMinor!: number;

  /** Display only, like the caps — sums do not convert. */
  @Column({ type: "varchar", default: "USD" })
  currency!: string;

  /** Cap one Connection's platform; null covers every ad Connection. */
  @Column({ type: "varchar", nullable: true })
  connectionId!: string | null;

  /** Cap one AI Employee across platforms; null covers every employee. */
  @Column({ type: "varchar", nullable: true })
  employeeId!: string | null;

  @Column({ type: "boolean", default: true })
  enabled!: boolean;

  /**
   * When owners were last paged about this budget refusing a mutation —
   * the once-per-month claim, so an employee retrying against an exhausted
   * envelope does not page on every attempt.
   */
  @Column({ type: dateTimeColumnType, nullable: true })
  lastExhaustedNotifiedAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
