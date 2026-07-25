import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity("partnership_contacts")
@Index(["companyId", "partnershipId", "contactId"], { unique: true })
@Index(["companyId", "contactId"])
export class PartnershipContact {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  partnershipId!: string;

  @Column({ type: "varchar" })
  contactId!: string;

  @Column({ type: "varchar", default: "" })
  role!: string;

  @Column({ type: "boolean", default: false })
  isPrimary!: boolean;

  /** Include this person whenever the partnership thread is replied to. */
  @Column({ type: "boolean", default: false })
  replyAll!: boolean;

  @Column({ type: "int", default: 0 })
  sortOrder!: number;

  @CreateDateColumn()
  createdAt!: Date;
}
