import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";
import { dateTimeColumnType } from "./columnTypes.js";

/**
 * Durable, reviewable duplicate pair. Detection only proposes; the merge
 * service is the sole writer that can retire a source record.
 */
@Entity("revenue_duplicate_candidates")
@Index(["companyId", "resourceType", "status", "score"])
@Index(["companyId", "resourceType", "leftId", "rightId"], { unique: true })
export class RevenueDuplicateCandidate {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  resourceType!: "account" | "contact" | "deal" | "partnership";

  /** Pair ids are stored lexical-low then lexical-high for idempotency. */
  @Column({ type: "varchar" })
  leftId!: string;

  @Column({ type: "varchar" })
  rightId!: string;

  @Column({ type: "int" })
  score!: number;

  @Column({ type: "text" })
  reasonsJson!: string;

  @Column({ type: "varchar" })
  status!: "open" | "dismissed" | "merged";

  @Column({ type: "varchar", nullable: true })
  mergeOperationId!: string | null;

  @Column({ type: dateTimeColumnType })
  detectedAt!: Date;

  @Column({ type: dateTimeColumnType, nullable: true })
  resolvedAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  resolvedByUserId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
