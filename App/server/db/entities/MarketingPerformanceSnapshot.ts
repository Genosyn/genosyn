import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

import { dateTimeColumnType } from "./columnTypes.js";

/**
 * One immutable platform readout for a campaign and time window.
 *
 * Metrics are stored as integer counters/minor units plus decimal text for
 * provider-reported conversion value. That makes trends queryable without
 * pretending every platform defines a conversion identically.
 *
 * Rows are append-only. Recording the same campaign and period again marks the
 * previous row superseded rather than editing or deleting it, so the history of
 * what the platform said stays intact while exactly one live readout per window
 * feeds the numbers anyone acts on. Live windows for one campaign never
 * overlap, which is what makes summing them safe.
 */
@Entity("marketing_performance_snapshots")
@Index(["companyId", "campaignId", "periodEnd"])
@Index(["companyId", "campaignId", "periodStart", "periodEnd"])
export class MarketingPerformanceSnapshot {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  campaignId!: string;

  @Column({ type: dateTimeColumnType })
  periodStart!: Date;

  @Column({ type: dateTimeColumnType })
  periodEnd!: Date;

  @Column({ type: "integer", default: 0 })
  spendMinor!: number;

  @Column({ type: "integer", default: 0 })
  impressions!: number;

  @Column({ type: "integer", default: 0 })
  clicks!: number;

  @Column({ type: "varchar", default: "0" })
  conversions!: string;

  @Column({ type: "varchar", default: "0" })
  conversionValue!: string;

  @Column({ type: "varchar", default: "USD" })
  currency!: string;

  @Column({ type: "varchar", default: "" })
  source!: string;

  @Column({ type: "text", default: "{}" })
  rawJson!: string;

  @Column({ type: "varchar", nullable: true })
  recordedByEmployeeId!: string | null;

  /**
   * Set when a later readout restated the same campaign and period.
   * The superseded row stays for the audit trail and drops out of every
   * aggregate, so a Routine that retries after a crash cannot count the same
   * spend twice and a platform that settles its numbers late can correct them.
   */
  @Column({ type: dateTimeColumnType, nullable: true })
  supersededAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
