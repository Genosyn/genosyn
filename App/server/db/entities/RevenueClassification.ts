import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { dateTimeColumnType } from "./columnTypes.js";

export type RevenueClassificationKind =
  | "deal_source"
  | "committee_role"
  | "partnership_type"
  | "partnership_status";

export const REVENUE_CLASSIFICATION_KINDS: RevenueClassificationKind[] = [
  "deal_source",
  "committee_role",
  "partnership_type",
  "partnership_status",
];

/**
 * A company-owned controlled vocabulary. Values are stable machine keys while
 * labels are editable display copy, preventing report fragmentation without
 * hard-coding one sales process for every company.
 */
@Entity("revenue_classifications")
@Index(["companyId", "kind", "value"], { unique: true })
@Index(["companyId", "kind", "sortOrder"])
export class RevenueClassification {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  kind!: RevenueClassificationKind;

  @Column({ type: "varchar" })
  value!: string;

  @Column({ type: "varchar" })
  label!: string;

  @Column({ type: "int", default: 0 })
  sortOrder!: number;

  @Column({ type: dateTimeColumnType, nullable: true })
  archivedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
