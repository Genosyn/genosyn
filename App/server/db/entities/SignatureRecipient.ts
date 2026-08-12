import { dateTimeColumnType } from "./columnTypes.js";
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

export type SignatureRecipientRole = "signer" | "copy";
export type SignatureRecipientStatus = "waiting" | "sent" | "viewed" | "completed" | "declined";
export type SignatureDeliveryStatus = "pending" | "sent" | "skipped" | "failed";

export const SIGNATURE_RECIPIENT_ROLES: SignatureRecipientRole[] = ["signer", "copy"];
export const SIGNATURE_RECIPIENT_STATUSES: SignatureRecipientStatus[] = [
  "waiting",
  "sent",
  "viewed",
  "completed",
  "declined",
];
export const SIGNATURE_DELIVERY_STATUSES: SignatureDeliveryStatus[] = [
  "pending",
  "sent",
  "skipped",
  "failed",
];

/** One external participant in a SignatureEnvelope. */
@Entity("signature_recipients")
@Index(["companyId", "envelopeId"])
@Index(["envelopeId", "routingOrder"])
@Index(["companyId", "email"])
@Index("UQ_signature_recipients_token_hash", ["tokenHash"], {
  unique: true,
  where: `"tokenHash" IS NOT NULL`,
})
export class SignatureRecipient {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  envelopeId!: string;

  @Column({ type: "varchar", default: "signer" })
  role!: SignatureRecipientRole;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar" })
  email!: string;

  /** Zero-based signing step. Equal values are released in parallel. */
  @Column({ type: "int", default: 0 })
  routingOrder!: number;

  @Column({ type: "varchar", default: "waiting" })
  status!: SignatureRecipientStatus;

  /** Only a hash is persisted; the bearer token exists in an invitation URL. */
  @Column({ type: "varchar", nullable: true })
  tokenHash!: string | null;

  @Column({ type: "varchar", default: "pending" })
  lastDeliveryStatus!: SignatureDeliveryStatus;

  @Column({ type: "text", default: "" })
  lastDeliveryError!: string;

  @Column({ type: dateTimeColumnType, nullable: true })
  lastDeliveredAt!: Date | null;

  @Column({ type: "int", default: 0 })
  reminderCount!: number;

  @Column({ type: dateTimeColumnType, nullable: true })
  viewedAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  consentedAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  completedAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  declinedAt!: Date | null;

  @Column({ type: "text", default: "" })
  declineReason!: string;

  /** Latest network evidence observed during this recipient's signing flow. */
  @Column({ type: "varchar", default: "" })
  ipAddress!: string;

  @Column({ type: "text", default: "" })
  userAgent!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
