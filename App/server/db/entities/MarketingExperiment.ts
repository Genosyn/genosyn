import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

import { dateTimeColumnType } from "./columnTypes.js";

export type MarketingExperimentStatus = "draft" | "running" | "decided" | "stopped";
export const MARKETING_EXPERIMENT_STATUSES: MarketingExperimentStatus[] = [
  "draft",
  "running",
  "decided",
  "stopped",
];

/**
 * A falsifiable paid-media test. Creative ids live as JSON because an
 * experiment can compare two or more variants without a join entity whose only
 * field would be ordering.
 */
@Entity("marketing_experiments")
@Index(["companyId", "campaignId", "status"])
export class MarketingExperiment {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  campaignId!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "text", default: "" })
  hypothesis!: string;

  @Column({ type: "varchar", default: "draft" })
  status!: MarketingExperimentStatus;

  @Column({ type: "varchar", default: "conversions" })
  primaryMetric!: string;

  @Column({ type: "varchar", default: "" })
  minimumSampleSize!: string;

  @Column({ type: "text", default: "[]" })
  creativeIdsJson!: string;

  @Column({ type: "varchar", nullable: true })
  winnerCreativeId!: string | null;

  @Column({ type: "text", default: "" })
  decisionRationale!: string;

  @Column({ type: dateTimeColumnType, nullable: true })
  startsAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  endsAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  createdByUserId!: string | null;

  @Column({ type: "varchar", nullable: true })
  createdByEmployeeId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
