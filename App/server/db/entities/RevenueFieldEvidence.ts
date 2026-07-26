import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";
import { dateTimeColumnType } from "./columnTypes.js";

export type RevenueEvidenceStatus = "proposed" | "accepted" | "rejected" | "superseded";
export type RevenueEvidenceSourceType =
  | "email"
  | "document"
  | "integration"
  | "finance"
  | "website"
  | "import"
  | "manual";

/**
 * Provenance for a derived Revenue field value.
 *
 * The source value and confidence remain immutable evidence. Review changes
 * only `status` and confirmation timestamps, so a later proposal never erases
 * why an earlier value was accepted or rejected.
 */
@Entity("revenue_field_evidence")
@Index(["companyId", "resourceType", "resourceId", "fieldKey", "status"])
@Index(["companyId", "sourceType", "sourceId"])
export class RevenueFieldEvidence {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  resourceType!: "account" | "contact" | "deal" | "partnership";

  @Column({ type: "varchar" })
  resourceId!: string;

  @Column({ type: "varchar" })
  fieldKey!: string;

  @Column({ type: "varchar" })
  sourceType!: RevenueEvidenceSourceType;

  @Column({ type: "varchar" })
  sourceId!: string;

  @Column({ type: "varchar", default: "" })
  sourceLabel!: string;

  @Column({ type: "text" })
  extractedValueJson!: string;

  @Column({ type: "varchar", default: "" })
  normalizedValue!: string;

  /** Integer 0-100; avoids floating point differences across DB drivers. */
  @Column({ type: "int" })
  confidence!: number;

  @Column({ type: "varchar" })
  status!: RevenueEvidenceStatus;

  @Column({ type: dateTimeColumnType })
  extractedAt!: Date;

  @Column({ type: dateTimeColumnType, nullable: true })
  lastVerifiedAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  humanConfirmedAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  humanConfirmedById!: string | null;

  @Column({ type: "text", default: "" })
  metadataJson!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
