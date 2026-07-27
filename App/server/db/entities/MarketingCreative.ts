import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

export type MarketingCreativeStatus =
  | "draft"
  | "review"
  | "approved"
  | "active"
  | "retired"
  | "rejected";
export type MarketingCreativeFormat = "text" | "image" | "video" | "carousel" | "responsive";

export const MARKETING_CREATIVE_STATUSES: MarketingCreativeStatus[] = [
  "draft",
  "review",
  "approved",
  "active",
  "retired",
  "rejected",
];
export const MARKETING_CREATIVE_FORMATS: MarketingCreativeFormat[] = [
  "text",
  "image",
  "video",
  "carousel",
  "responsive",
];

/** One testable message/asset variant inside a Marketing Campaign. */
@Entity("marketing_creatives")
@Index(["companyId", "campaignId", "status"])
@Index(["companyId", "variantGroup"])
export class MarketingCreative {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  campaignId!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar", default: "text" })
  format!: MarketingCreativeFormat;

  @Column({ type: "varchar", default: "draft" })
  status!: MarketingCreativeStatus;

  /** Variants with the same non-empty value are intended to compete. */
  @Column({ type: "varchar", default: "" })
  variantGroup!: string;

  @Column({ type: "text", default: "" })
  concept!: string;

  @Column({ type: "text", default: "" })
  headline!: string;

  @Column({ type: "text", default: "" })
  body!: string;

  @Column({ type: "varchar", default: "" })
  callToAction!: string;

  /** A company-controlled URL or Resource URL; assets are not copied into DB. */
  @Column({ type: "varchar", default: "" })
  assetUrl!: string;

  @Column({ type: "varchar", default: "" })
  destinationUrl!: string;

  @Column({ type: "varchar", default: "" })
  externalCreativeId!: string;

  @Column({ type: "text", default: "" })
  reviewNote!: string;

  @Column({ type: "varchar", nullable: true })
  createdByUserId!: string | null;

  @Column({ type: "varchar", nullable: true })
  createdByEmployeeId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
