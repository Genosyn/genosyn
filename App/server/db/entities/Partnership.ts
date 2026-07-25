import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { dateTimeColumnType } from "./columnTypes.js";

@Entity("partnerships")
@Index(["companyId", "status"])
@Index(["companyId", "nextFollowUpAt"])
@Index(["companyId", "archivedAt"])
export class Partnership {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar", default: "" })
  type!: string;

  @Column({ type: "varchar", default: "" })
  status!: string;

  @Column({ type: "varchar", nullable: true })
  customerId!: string | null;

  @Column({ type: "varchar", default: "" })
  websiteUrl!: string;

  @Column({ type: "text", default: "" })
  integrationContext!: string;

  @Column({ type: "text", default: "" })
  channelContext!: string;

  @Column({ type: "text", default: "" })
  notes!: string;

  @Column({ type: "varchar", nullable: true })
  ownerId!: string | null;

  @Column({ type: "varchar", nullable: true })
  ownerEmployeeId!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  nextFollowUpAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  reminderAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  lastActivityAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  archivedAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  @Column({ type: "varchar", nullable: true })
  createdByEmployeeId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
