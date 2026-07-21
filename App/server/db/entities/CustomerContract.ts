import { dateTimeColumnType } from "./columnTypes.js";
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * A signed agreement (PDF, scan, DOCX, …) the company holds with a customer.
 *
 * NOTE: distinct from {@link CustomerContact} despite the near-identical name
 * — a *contact* is a person at the account; a *contract* is an uploaded
 * document. The bytes live on disk under
 * `data/companies/<slug>/customer-contracts/<uuid>.<ext>`; only metadata sits
 * in the DB, mirroring {@link Attachment} / {@link BaseRecordAttachment} so
 * large binaries never bloat sqlite.
 *
 * `customerId` is nullable so a contract can be uploaded before it's tied to
 * an account and so deleting a customer never cascade-fails on a contract
 * (the link is nulled instead). `companyId` is denormalized so the download
 * handler can resolve the on-disk path without joining through Customer.
 */
@Entity("customer_contracts")
@Index(["companyId", "customerId"])
@Index(["companyId", "createdAt"])
export class CustomerContract {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar", nullable: true })
  customerId!: string | null;

  /** Human-friendly label for the document. Defaults to the original
   *  filename at upload time but is editable independently. */
  @Column({ type: "varchar" })
  title!: string;

  @Column({ type: "varchar" })
  filename!: string;

  @Column({ type: "varchar", default: "application/octet-stream" })
  mimeType!: string;

  @Column({ type: "bigint", default: 0 })
  sizeBytes!: number;

  /** Relative to `data/companies/<slug>/customer-contracts/`. */
  @Column({ type: "varchar" })
  storageKey!: string;

  /** When the contract was signed, as entered by the user. Independent of
   *  `createdAt` (the upload time). Null when unknown. */
  @Column({ type: dateTimeColumnType, nullable: true })
  signedAt!: Date | null;

  @Column({ type: "text", default: "" })
  notes!: string;

  @Column({ type: "varchar", nullable: true })
  uploadedByUserId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
