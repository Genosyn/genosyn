import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from "typeorm";

export type RunStatus = "running" | "completed" | "failed";

@Entity("runs")
export class Run {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column()
  routineId!: string;

  @Column("datetime")
  startedAt!: Date;

  @Column({ type: "datetime", nullable: true })
  finishedAt!: Date | null;

  @Column()
  status!: RunStatus;

  @Column({ type: "varchar", nullable: true })
  logsPath!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
