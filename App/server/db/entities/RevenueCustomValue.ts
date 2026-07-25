import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import type { RevenueResourceType } from "./RevenueCustomField.js";

/**
 * One typed custom-field value. JSON retains booleans, numbers and arrays; the
 * normalized search text makes exact filtering portable across SQLite/Postgres.
 */
@Entity("revenue_custom_values")
@Index(["companyId", "fieldId", "resourceId"], { unique: true })
@Index(["companyId", "resourceType", "resourceId"])
@Index(["companyId", "fieldId", "searchValue"])
export class RevenueCustomValue {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  fieldId!: string;

  @Column({ type: "varchar" })
  resourceType!: RevenueResourceType;

  @Column({ type: "varchar" })
  resourceId!: string;

  @Column({ type: "text" })
  valueJson!: string;

  @Column({ type: "varchar", default: "" })
  searchValue!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
