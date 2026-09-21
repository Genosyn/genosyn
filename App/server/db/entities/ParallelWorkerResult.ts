import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/** Durable evidence from one bounded worker, independent of its parent's transcript. */
@Entity("parallel_worker_results")
@Index(["companyId", "employeeId", "scopeKey", "authority", "requesterUserId"])
@Index(["companyId", "employeeId", "scopeKey", "authority", "requesterUserId", "briefHash"], {
  unique: true,
})
export class ParallelWorkerResult {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  employeeId!: string;

  /** Server-resolved occurrence root or exact conversation; never a tool argument. */
  @Column({ type: "varchar" })
  scopeKey!: string;

  @Column({ type: "varchar" })
  authority!: "employee" | "member";

  @Column({ type: "varchar", default: "" })
  requesterUserId!: string;

  @Column({ type: "varchar", nullable: true })
  parentRunId!: string | null;

  @Column({ type: "varchar" })
  parentTurnId!: string;

  /** Matching an already completed brief reuses its evidence, never its effects. */
  @Column({ type: "varchar" })
  briefHash!: string;

  @Column({ type: "varchar" })
  label!: string;

  @Column({ type: "varchar", default: "pending" })
  status!: "pending" | "completed" | "failed";

  @Column({ type: "text", default: "" })
  output!: string;

  @Column({ type: "integer", default: 0 })
  totalChars!: number;

  @Column({ type: "text" })
  grantsJson!: string;

  @Column({ type: "text", default: "[]" })
  requiredToolsJson!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
