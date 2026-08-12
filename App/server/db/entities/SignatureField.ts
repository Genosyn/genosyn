import { dateTimeColumnType } from "./columnTypes.js";
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

export type SignatureFieldType =
  | "signature"
  | "initials"
  | "name"
  | "email"
  | "date"
  | "text"
  | "checkbox";

export const SIGNATURE_FIELD_TYPES: SignatureFieldType[] = [
  "signature",
  "initials",
  "name",
  "email",
  "date",
  "text",
  "checkbox",
];

/** One recipient-owned field positioned on a page of the source PDF. */
@Entity("signature_fields")
@Index(["companyId", "envelopeId"])
@Index(["envelopeId", "pageNumber", "sortOrder"])
@Index(["recipientId", "sortOrder"])
export class SignatureField {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  envelopeId!: string;

  @Column({ type: "varchar" })
  recipientId!: string;

  @Column({ type: "varchar" })
  type!: SignatureFieldType;

  @Column({ type: "varchar", default: "" })
  label!: string;

  @Column({ type: "varchar", default: "" })
  placeholder!: string;

  @Column({ type: "boolean", default: true })
  required!: boolean;

  /** One-based page number in the original PDF. */
  @Column({ type: "int" })
  pageNumber!: number;

  @Column({ type: "float" })
  x!: number;

  @Column({ type: "float" })
  y!: number;

  @Column({ type: "float" })
  width!: number;

  @Column({ type: "float" })
  height!: number;

  /** JSON scalar/object captured from the signer; `null` means unfilled. */
  @Column({ type: "text", default: "null" })
  valueJson!: string;

  @Column({ type: dateTimeColumnType, nullable: true })
  completedAt!: Date | null;

  @Column({ type: "float", default: 0 })
  sortOrder!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
