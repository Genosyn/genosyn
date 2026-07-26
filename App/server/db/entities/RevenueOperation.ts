import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { dateTimeColumnType } from "./columnTypes.js";

export type RevenueOperationKind = "merge" | "bulk";
export type RevenueOperationStatus = "completed" | "partial" | "failed" | "rolled_back";
export type RevenueOperationResourceType =
  | "account"
  | "contact"
  | "deal"
  | "partnership"
  | "follow_up";

/**
 * Durable header for a reversible Revenue mutation.
 *
 * Dry runs never write one of these. A committed merge or bulk operation gets
 * one header plus ordered RevenueOperationRow records containing the exact
 * before/after state needed for guarded rollback.
 */
@Entity("revenue_operations")
@Index(["companyId", "createdAt"])
@Index(["companyId", "kind", "status"])
@Index(["companyId", "resourceType", "sourceId"])
@Index(["companyId", "idempotencyKey"], { unique: true })
export class RevenueOperation {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  kind!: RevenueOperationKind;

  @Column({ type: "varchar" })
  resourceType!: RevenueOperationResourceType;

  @Column({ type: "varchar" })
  status!: RevenueOperationStatus;

  /** Stable caller key for a committed bulk operation. Null for merges. */
  @Column({ type: "varchar", nullable: true })
  idempotencyKey!: string | null;

  /** Duplicate/source id for merges. */
  @Column({ type: "varchar", nullable: true })
  sourceId!: string | null;

  /** Surviving/canonical id for merges. */
  @Column({ type: "varchar", nullable: true })
  targetId!: string | null;

  @Column({ type: "text" })
  requestJson!: string;

  @Column({ type: "text" })
  summaryJson!: string;

  @Column({ type: dateTimeColumnType })
  completedAt!: Date;

  @Column({ type: dateTimeColumnType, nullable: true })
  rolledBackAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  createdByUserId!: string | null;

  @Column({ type: "varchar", nullable: true })
  createdByEmployeeId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
