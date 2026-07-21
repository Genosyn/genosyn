import { dateTimeColumnType } from "./columnTypes.js";
import { Column, Entity, PrimaryColumn, UpdateDateColumn } from "typeorm";

/** Database-backed leader lease for recurring background services. */
@Entity("scheduler_leases")
export class SchedulerLease {
  @PrimaryColumn({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar", default: "" })
  holderId!: string;

  @Column({ type: dateTimeColumnType, nullable: true })
  expiresAt!: Date | null;

  @UpdateDateColumn()
  updatedAt!: Date;
}
