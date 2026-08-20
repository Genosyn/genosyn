import { dateTimeColumnType } from "./columnTypes.js";
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

export type TldrStatus = "generating" | "ready" | "failed";
export type TldrTriggerKind = "schedule" | "manual";

/** One generated company brief, including its durable generation state. */
@Entity("tldrs")
@Index(["companyId", "status", "createdAt"])
@Index(["companyId", "periodStart", "periodEnd"])
export class Tldr {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  /** Null after the selected employee is deleted; snapshot fields survive. */
  @Column({ type: "varchar", nullable: true })
  employeeId!: string | null;

  @Column({ type: "varchar" })
  employeeName!: string;

  @Column({ type: "varchar" })
  employeeSlug!: string;

  @Column({ type: "varchar" })
  employeeRole!: string;

  @Column({ type: "varchar", nullable: true })
  employeeAvatarKey!: string | null;

  @Column({ type: "varchar", default: "generating" })
  status!: TldrStatus;

  @Column({ type: "varchar", default: "schedule" })
  triggerKind!: TldrTriggerKind;

  @Column({ type: dateTimeColumnType })
  periodStart!: Date;

  @Column({ type: dateTimeColumnType })
  periodEnd!: Date;

  @Column({ type: "varchar", default: "" })
  title!: string;

  @Column({ type: "text", default: "" })
  summary!: string;

  @Column({ type: "text", default: "" })
  body!: string;

  /** JSON-encoded public-channel / journal / Routine Run source counts. */
  @Column({ type: "text", default: "{}" })
  sourceStatsJson!: string;

  @Column({ type: "text", default: "" })
  errorMessage!: string;

  @Column({ type: dateTimeColumnType, nullable: true })
  finishedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
