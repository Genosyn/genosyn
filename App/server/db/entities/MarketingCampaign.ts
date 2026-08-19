import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

import { dateTimeColumnType } from "./columnTypes.js";

export type MarketingCampaignStatus =
  | "draft"
  | "ready"
  | "active"
  | "paused"
  | "completed"
  | "archived";
export type MarketingCampaignObjective =
  | "awareness"
  | "traffic"
  | "leads"
  | "sales"
  | "retention";
export type MarketingAutonomyMode = "observe" | "optimize" | "autonomous";
/** How to read `targetValue` against the measured `successMetric`. */
export type MarketingTargetDirection = "at_most" | "at_least";

export const MARKETING_CAMPAIGN_STATUSES: MarketingCampaignStatus[] = [
  "draft",
  "ready",
  "active",
  "paused",
  "completed",
  "archived",
];
export const MARKETING_CAMPAIGN_OBJECTIVES: MarketingCampaignObjective[] = [
  "awareness",
  "traffic",
  "leads",
  "sales",
  "retention",
];
export const MARKETING_AUTONOMY_MODES: MarketingAutonomyMode[] = [
  "observe",
  "optimize",
  "autonomous",
];
export const MARKETING_TARGET_DIRECTIONS: MarketingTargetDirection[] = ["at_most", "at_least"];

/**
 * The durable brief and operating policy for one paid-media campaign.
 *
 * The external ad platform remains the source of truth for delivery and spend.
 * This row is the source of truth for why the campaign exists, what success
 * means, who may operate it, and which platform object it maps to. AI employees
 * use it as their shared workspace between Routines instead of reconstructing
 * strategy from ad-platform names on every run.
 */
@Entity("marketing_campaigns")
@Index(["companyId", "status"])
@Index(["companyId", "ownerEmployeeId"])
@Index(["companyId", "connectionId", "externalCampaignId"])
export class MarketingCampaign {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar" })
  objective!: MarketingCampaignObjective;

  @Column({ type: "varchar", default: "draft" })
  status!: MarketingCampaignStatus;

  @Column({ type: "varchar", default: "observe" })
  autonomyMode!: MarketingAutonomyMode;

  /** Provider id such as google-ads, meta-ads, or browser-managed. */
  @Column({ type: "varchar", default: "" })
  channel!: string;

  @Column({ type: "varchar", nullable: true })
  connectionId!: string | null;

  @Column({ type: "varchar", default: "" })
  externalAccountId!: string;

  @Column({ type: "varchar", default: "" })
  externalCampaignId!: string;

  @Column({ type: "varchar", nullable: true })
  ownerEmployeeId!: string | null;

  @Column({ type: "text", default: "" })
  brief!: string;

  @Column({ type: "text", default: "" })
  audience!: string;

  @Column({ type: "text", default: "" })
  offer!: string;

  @Column({ type: "varchar", default: "" })
  landingPageUrl!: string;

  @Column({ type: "varchar", default: "conversions" })
  successMetric!: string;

  /** Decimal target encoded as text so CPA/ROAS values retain exact input. */
  @Column({ type: "varchar", default: "" })
  targetValue!: string;

  /**
   * Which side of `targetValue` counts as winning. A cost target is met at or
   * below its number; a return target is met at or above it. Without this the
   * measured result and the goal cannot be compared at all, which is why the
   * target used to be prose nobody could act on.
   */
  @Column({ type: "varchar", default: "at_most" })
  targetDirection!: MarketingTargetDirection;

  /** Planned daily budget in minor currency units; live spend stays external. */
  @Column({ type: "integer", default: 0 })
  dailyBudgetMinor!: number;

  @Column({ type: "varchar", default: "USD" })
  currency!: string;

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
