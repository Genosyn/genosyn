import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

@Entity("routines")
@Index(["employeeId", "slug"], { unique: true })
export class Routine {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column()
  employeeId!: string;

  @Column()
  name!: string;

  @Column()
  slug!: string;

  @Column()
  cronExpr!: string;

  @Column({ default: true })
  enabled!: boolean;

  @Column({ type: "datetime", nullable: true })
  lastRunAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  modelId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
