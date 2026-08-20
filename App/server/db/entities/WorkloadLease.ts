import { dateTimeColumnType } from "./columnTypes.js";
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/** One active chat-reply lease, shared across every API/worker replica. */
@Entity("workload_leases")
@Index(["companyId", "expiresAt"])
@Index(["employeeId", "expiresAt"])
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
