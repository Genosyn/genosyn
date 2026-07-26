import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/**
 * One durable import decision, split out of RevenueImportBatch's legacy JSON
 * blobs so reports can paginate and export without loading the entire batch.
 */
@Entity("revenue_import_rows")
@Index(["batchId", "sortOrder"])
@Index(["companyId", "resourceType", "nativeId"])
@Index(["companyId", "sourceId"])
export class RevenueImportRow {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  batchId!: string;

  @Column({ type: "varchar" })
  resourceType!: "account" | "contact" | "deal" | "partnership";

  @Column({ type: "varchar" })
  sourceId!: string;

  @Column({ type: "varchar", nullable: true })
  nativeId!: string | null;

  @Column({ type: "varchar" })
  action!: string;

  @Column({ type: "varchar" })
  status!: "created" | "matched" | "skipped" | "failed" | "rolled_back";

  @Column({ type: "text", default: "" })
  reason!: string;

  @Column({ type: "text" })
  decisionJson!: string;

  @Column({ type: "int", default: 0 })
  sortOrder!: number;

  @CreateDateColumn()
  createdAt!: Date;
}
