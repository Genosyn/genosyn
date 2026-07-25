import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { dateTimeColumnType } from "./columnTypes.js";
import type { RevenueResourceType } from "./RevenueCustomField.js";

export type RevenueImportStatus = "completed" | "rolled_back" | "failed";

/**
 * Durable reconciliation ledger for a committed import. Dry runs do not write
 * rows; completed runs retain field mapping, duplicate decisions and a stable
 * source-row → native-id map so operators can reconcile or roll back safely.
 */
@Entity("revenue_import_batches")
@Index(["companyId", "createdAt"])
@Index(["companyId", "status"])
export class RevenueImportBatch {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  resourceType!: RevenueResourceType;

  @Column({ type: "varchar" })
  sourceKind!: "base" | "csv";

  @Column({ type: "varchar", default: "" })
  sourceLabel!: string;

  @Column({ type: "varchar", nullable: true })
  sourceBaseId!: string | null;

  @Column({ type: "varchar", nullable: true })
  sourceTableId!: string | null;

  @Column({ type: "varchar" })
  status!: RevenueImportStatus;

  @Column({ type: "text" })
  mappingJson!: string;

  @Column({ type: "text" })
  rowMapJson!: string;

  @Column({ type: "text" })
  createdIdsJson!: string;

  @Column({ type: "text" })
  reportJson!: string;

  @Column({ type: dateTimeColumnType, nullable: true })
  rolledBackAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  createdByUserId!: string | null;

  @Column({ type: "varchar", nullable: true })
  createdByEmployeeId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
