import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

@Entity("routines")
@Index(["employeeId", "slug"], { unique: true })
export class Routine {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar" })
  slug!: string;

  @Column({ type: "varchar" })
  cronExpr!: string;

  @Column({ type: "boolean", default: true })
  enabled!: boolean;

  @Column({ type: "datetime", nullable: true })
  lastRunAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
