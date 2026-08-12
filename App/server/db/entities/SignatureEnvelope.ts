import { dateTimeColumnType } from "./columnTypes.js";
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

export type SignatureEnvelopeStatus =
  | "draft"
  | "sent"
  | "in_progress"
  | "completed"
  | "declined"
  | "voided"
  | "expired";

export const SIGNATURE_ENVELOPE_STATUSES: SignatureEnvelopeStatus[] = [
  "draft",
  "sent",
  "in_progress",
  "completed",
  "declined",
  "voided",
  "expired",
];

export type SignatureRoutingMode = "parallel" | "ordered";

export const SIGNATURE_ROUTING_MODES: SignatureRoutingMode[] = ["parallel", "ordered"];

/**
 * One document package moving through the customer-signing lifecycle.
 *
 * The original and completed documents are immutable files under the
 * company's data directory. Their hashes make the stored bytes independently
 * verifiable, while {@link SignatureEvent} provides the append-only evidence
 * trail. `customerContractId` is populated only after completion, when the
 * final artifact is also exposed through the existing Customers contract
 * library.
 */
@Entity("signature_envelopes")
@Index(["companyId", "status", "createdAt"])
@Index(["companyId", "customerId"])
@Index(["status", "expiresAt"])
@Index(["customerContractId"])
export class SignatureEnvelope {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar", nullable: true })
  customerId!: string | null;

  @Column({ type: "varchar" })
  title!: string;

  /** Plain-text note included with the signing invitation. */
  @Column({ type: "text", default: "" })
  message!: string;

  @Column({ type: "varchar", default: "draft" })
  status!: SignatureEnvelopeStatus;

  @Column({ type: "varchar", default: "parallel" })
  routingMode!: SignatureRoutingMode;

  @Column({ type: "varchar" })
  originalFilename!: string;

  @Column({ type: "varchar", default: "application/pdf" })
  originalMimeType!: string;

  @Column({ type: "bigint", default: 0 })
  originalSizeBytes!: number;

  /** Relative to the company's signing-document storage root. */
  @Column({ type: "varchar" })
  originalStorageKey!: string;

  @Column({ type: "int", default: 0 })
  originalPageCount!: number;

  /** Extracted source text used for AI-assisted field preparation. */
  @Column({ type: "text", default: "" })
  documentText!: string;

  /** Lowercase hexadecimal SHA-256 of the immutable original bytes. */
  @Column({ type: "varchar", default: "" })
  originalSha256!: string;

  /** Relative key for the final flattened PDF, set only on completion. */
  @Column({ type: "varchar", nullable: true })
  completedStorageKey!: string | null;

  @Column({ type: "bigint", default: 0 })
  completedSizeBytes!: number;

  @Column({ type: "varchar", default: "" })
  completedSha256!: string;

  /** Existing CustomerContract row created from the completed artifact. */
  @Column({ type: "varchar", nullable: true })
  customerContractId!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  expiresAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  sentAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  completedAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  declinedAt!: Date | null;

  @Column({ type: "text", default: "" })
  declineReason!: string;

  @Column({ type: dateTimeColumnType, nullable: true })
  voidedAt!: Date | null;

  @Column({ type: "text", default: "" })
  voidReason!: string;

  @Column({ type: dateTimeColumnType, nullable: true })
  expiredAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  createdByUserId!: string | null;

  @Column({ type: "varchar", nullable: true })
  createdByEmployeeId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
