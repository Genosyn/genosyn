import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";
import { dateTimeColumnType } from "./columnTypes.js";

export type SignatureEventType =
  | "envelope_created"
  | "envelope_updated"
  | "envelope_sent"
  | "recipient_sent"
  | "recipient_delivery_failed"
  | "recipient_viewed"
  | "recipient_consented"
  | "recipient_completed"
  | "recipient_declined"
  | "reminder_sent"
  | "envelope_completed"
  | "envelope_declined"
  | "envelope_voided"
  | "envelope_expired"
  | "document_downloaded";

export type SignatureEventActorKind = "user" | "ai" | "recipient" | "system";

/**
 * Append-only evidence in a SignatureEnvelope's tamper-evident hash chain.
 * `eventHash` covers the canonical event payload plus `previousHash`; the
 * service layer is responsible for serializing and hashing that payload.
 */
@Entity("signature_events")
@Index(["companyId", "envelopeId", "createdAt"])
@Index(["recipientId", "createdAt"])
export class SignatureEvent {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  envelopeId!: string;

  @Column({ type: "varchar", nullable: true })
  recipientId!: string | null;

  @Column({ type: "varchar" })
  type!: SignatureEventType;

  @Column({ type: "varchar" })
  actorKind!: SignatureEventActorKind;

  /** User, AI Employee, or recipient id; null for system events. */
  @Column({ type: "varchar", nullable: true })
  actorId!: string | null;

  @Column({ type: "varchar", default: "" })
  ipAddress!: string;

  @Column({ type: "text", default: "" })
  userAgent!: string;

  @Column({ type: "text", default: "{}" })
  metadataJson!: string;

  @Column({ type: "varchar", default: "" })
  previousHash!: string;

  @Column({ type: "varchar" })
  eventHash!: string;

  @CreateDateColumn({ type: dateTimeColumnType })
  createdAt!: Date;
}
