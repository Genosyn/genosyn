import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { dateTimeColumnType } from "./columnTypes.js";

export type RevenueResourceType = "contact" | "account" | "deal" | "partnership";
export const REVENUE_RESOURCE_TYPES: RevenueResourceType[] = [
  "contact",
  "account",
  "deal",
  "partnership",
];

export type RevenueCustomFieldType =
  | "text"
  | "number"
  | "date"
  | "boolean"
  | "select"
  | "multi_select"
  | "url";

export const REVENUE_CUSTOM_FIELD_TYPES: RevenueCustomFieldType[] = [
  "text",
  "number",
  "date",
  "boolean",
  "select",
  "multi_select",
  "url",
];

@Entity("revenue_custom_fields")
@Index(["companyId", "resourceType", "key"], { unique: true })
@Index(["companyId", "resourceType", "sortOrder"])
export class RevenueCustomField {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  resourceType!: RevenueResourceType;

  @Column({ type: "varchar" })
  key!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar" })
  fieldType!: RevenueCustomFieldType;

  @Column({ type: "text", default: "[]" })
  optionsJson!: string;

  @Column({ type: "boolean", default: false })
  required!: boolean;

  @Column({ type: "int", default: 0 })
  sortOrder!: number;

  @Column({ type: dateTimeColumnType, nullable: true })
  archivedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
