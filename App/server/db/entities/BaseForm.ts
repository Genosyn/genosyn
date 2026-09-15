import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { dateTimeColumnType } from "./columnTypes.js";

/**
 * A public Form backed by one Base table. Question definitions deliberately
 * live as JSON: they are a small, ordered projection of existing Base fields,
 * not an independent schema of their own.
 */
@Entity("base_forms")
@Index(["tableId", "slug"], { unique: true })
@Index(["companyId", "createdAt"])
@Index(["tokenHash"], { unique: true })
export class BaseForm {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  /** Duplicated from Base for fail-closed authorization and scoped encryption. */
  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  tableId!: string;

  @Column({ type: "varchar" })
  slug!: string;

  @Column({ type: "varchar" })
  title!: string;

  @Column({ type: "text", default: "" })
  description!: string;

  @Column({ type: "varchar", default: "Submit" })
  submitLabel!: string;

  @Column({ type: "varchar", default: "Response submitted" })
  successTitle!: string;

  @Column({ type: "text", default: "Thanks for your response." })
  successMessage!: string;

  @Column({ type: "boolean", default: false })
  allowAnotherResponse!: boolean;

  /** Ordered array of BaseFormQuestion objects; parsed strictly at every seam. */
  @Column({ type: "text", default: "[]" })
  questionsJson!: string;

  /** Null is a draft. A timestamp preserves when a link first became public. */
  @Column({ type: dateTimeColumnType, nullable: true })
  publishedAt!: Date | null;

  /** A published but closed Form remains viewable, while writes return 409. */
  @Column({ type: "boolean", default: true })
  acceptingResponses!: boolean;

  /** SHA-256 hex lookup key. The plaintext bearer credential is never stored here. */
  @Column({ type: "varchar" })
  tokenHash!: string;

  /** Recoverable only for an authorized Member copying the public URL. */
  @Column({ type: "text" })
  tokenEncrypted!: string;

  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
