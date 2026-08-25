import { dateTimeColumnType } from "./columnTypes.js";
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/** One active chat-reply lease, shared across every API/worker replica. */
@Entity("workload_leases")
@Index(["companyId", "expiresAt"])
@Index(["employeeId", "expiresAt"])
@Index(["employeeId", "kind", "scopeKey"])
export class WorkloadLease {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar", nullable: true })
  employeeId!: string | null;

  @Column({ type: "varchar" })
  kind!: "chat" | "routine";

  /**
   * The thread this lease serializes — one conversation, one email thread, one
   * TLDR question. Two turns that replay the same transcript must not run at
   * once; two turns on *different* threads are exactly the concurrency a
   * Member expects from one AI Employee, so they take different leases. A
   * surface with no thread of its own uses `EMPLOYEE_WIDE_SCOPE`.
   *
   * Nullable only for rows a build from before threads were scoped left
   * behind. Nothing writes NULL any more; `acquireChatWorkloadLease` treats a
   * NULL row as blocking every thread so a rolling upgrade keeps the old
   * guarantee until those rows expire.
   */
  @Column({ type: "varchar", nullable: true })
  scopeKey!: string | null;

  /**
   * Stable durable-work key. A recovered chat turn replaces the reply lease
   * its interrupted process left behind before checking whether the employee
   * is busy; NULL for ordinary callers.
   */
  @Index()
  @Column({ type: "varchar", nullable: true })
  ownerKey!: string | null;

  @Column({ type: dateTimeColumnType })
  expiresAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;
}
