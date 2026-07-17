import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

export type BaseFieldType =
  | "text"
  | "longtext"
  | "number"
  | "checkbox"
  | "date"
  | "datetime"
  | "email"
  | "url"
  | "select"
  | "multiselect"
  | "link"
  | "customer"
  | "invoice"
  | "project"
  | "employee"
  | "member"
  | "note"
  | "pipeline";

/**
 * A column on a BaseTable. The field's `id` is also the key used in
 * BaseRecord.dataJson — so renaming a field is free, we never migrate data.
 *
 * configJson shape per type:
 *  - select / multiselect: `{ options: Array<{ id: string; label: string; color: string }> }`
 *  - link:                 `{ targetTableId: string }`
 *  - number:               `{ precision?: number }`
 *
 * The record-link types (`customer`, `invoice`, `project`, `employee`,
 * `member`, `note`, `pipeline`) need no config — they always point at the
 * company-scoped records of that product, and cells store an array of ids
 * (customer ids, invoice ids, … user ids for `member`). Labels are resolved
 * at read time via `buildResourceOptionsFor` in services/baseResources.ts.
 */
@Entity("base_fields")
@Index(["tableId", "sortOrder"])
export class BaseField {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  tableId!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar" })
  type!: BaseFieldType;

  @Column({ type: "text", default: "{}" })
  configJson!: string;

  /** First visible field — used as the "title" in cross-table references. */
  @Column({ type: "boolean", default: false })
  isPrimary!: boolean;

  @Column({ type: "float", default: 0 })
  sortOrder!: number;

  @CreateDateColumn()
  createdAt!: Date;
}
