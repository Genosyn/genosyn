import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

import { dateTimeColumnType } from "./columnTypes.js";

/**
 * One immutable platform readout for a campaign and time window.
 *
 * Metrics are stored as integer counters/minor units plus decimal text for
 * provider-reported conversion value. That makes trends queryable without
 * pretending every platform defines a conversion identically.
 */
@Entity("marketing_performance_snapshots")
@Index(["companyId", "campaignId", "periodEnd"])
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

  @CreateDateColumn()
  createdAt!: Date;
}
