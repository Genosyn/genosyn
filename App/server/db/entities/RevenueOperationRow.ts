import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

export type RevenueOperationRowStatus = "applied" | "skipped" | "failed" | "rolled_back";

/**
 * One validated row inside a committed Revenue merge or bulk operation.
 * `beforeJson` and `afterJson` are intentionally self-contained so rollback
 * never has to infer what the operation changed from the current database.
 */
@Entity("revenue_operation_rows")
@Index(["operationId", "sortOrder"])
@Index(["companyId", "resourceType", "resourceId"])
export class RevenueOperationRow {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  operationId!: string;

  @Column({ type: "varchar" })
  resourceType!: string;

  @Column({ type: "varchar" })
  resourceId!: string;

  /** Concrete table/entity affected, e.g. `activity` or `deal_contact`. */
  @Column({ type: "varchar" })
  entityType!: string;

  @Column({ type: "varchar" })
  action!: string;

  @Column({ type: "varchar" })
  status!: RevenueOperationRowStatus;

  @Column({ type: "text" })
  beforeJson!: string;

  @Column({ type: "text" })
  afterJson!: string;

  @Column({ type: "text", default: "" })
  detail!: string;

  @Column({ type: "int", default: 0 })
  sortOrder!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
