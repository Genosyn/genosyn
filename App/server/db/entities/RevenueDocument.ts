import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

export type RevenueDocumentKind =
  | "proposal"
  | "rfp"
  | "security_questionnaire"
  | "contract"
  | "email_attachment"
  | "other";

export const REVENUE_DOCUMENT_KINDS: RevenueDocumentKind[] = [
  "proposal",
  "rfp",
  "security_questionnaire",
  "contract",
  "email_attachment",
  "other",
];

@Entity("revenue_documents")
@Index(["companyId", "dealId"])
@Index(["companyId", "customerId"])
@Index(["companyId", "partnershipId"])
@Index(["companyId", "contactId"])
export class RevenueDocument {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  kind!: RevenueDocumentKind;

  @Column({ type: "varchar" })
  title!: string;

  @Column({ type: "text", default: "" })
  notes!: string;

  @Column({ type: "varchar", nullable: true })
  dealId!: string | null;

  @Column({ type: "varchar", nullable: true })
  customerId!: string | null;

  @Column({ type: "varchar", nullable: true })
  partnershipId!: string | null;

  @Column({ type: "varchar", nullable: true })
  contactId!: string | null;

  /** Generic Attachment row for an uploaded file. */
  @Column({ type: "varchar", nullable: true })
  attachmentId!: string | null;

  @Column({ type: "varchar", nullable: true })
  sourceMailMessageId!: string | null;

  @Column({ type: "varchar", default: "" })
  externalUrl!: string;

  @Column({ type: "varchar", nullable: true })
  createdByUserId!: string | null;

  @Column({ type: "varchar", nullable: true })
  createdByEmployeeId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
