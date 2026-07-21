import { dateTimeColumnType } from "./columnTypes.js";
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/** One active AI workload slot, shared across every API/worker replica. */
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

  @Column({ type: dateTimeColumnType })
  expiresAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;
}
