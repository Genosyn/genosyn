import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * Bill statuses for Phase G of the Finance milestone (M19). Mirror of
 * `InvoiceStatus`:
 *   - draft  — fully editable, deletable, no number minted.
 *   - sent   — recorded with a vendor reference, AP posted to ledger.
 *              Payments may be recorded; voiding allowed.
 *   - paid   — paidCents >= totalCents.
 *   - void   — terminal.
 */
export type BillStatus = "draft" | "sent" | "paid" | "void";

/**
 * A Bill is an inbound invoice from a `Vendor` that the company owes
 * money for. Mirrors `Invoice` end-to-end: gapless per-company
 * sequence on `numberSeq`, draft → sent → paid → void lifecycle,
 * recomputed cent columns from line items + payments.
 *
 * `vendorRef` is the *vendor's own* invoice number — what's printed
 * on the bill they sent us. Helps reconcile when the vendor follows
 * up about a specific invoice number from their side.
 */
@Entity("bills")
@Index(["companyId", "slug"], { unique: true })
@Index(["companyId", "status"])
@Index(["companyId", "vendorId"])
@Index(["companyId", "numberSeq"])
export class Bill {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  vendorId!: string;

  @Column({ type: "varchar" })
  slug!: string;

  @Column({ type: "int", default: 0 })
  numberSeq!: number;

  @Column({ type: "varchar", default: "" })
  number!: string;

  @Column({ type: "varchar", default: "" })
  vendorRef!: string;

  @Column({ type: "varchar", default: "draft" })
  status!: BillStatus;

  @Column({ type: "datetime" })
  issueDate!: Date;

  @Column({ type: "datetime" })
  dueDate!: Date;

  @Column({ type: "varchar", default: "USD" })
  currency!: string;

  @Column({ type: "int", default: 0 })
  subtotalCents!: number;

  @Column({ type: "int", default: 0 })
  taxCents!: number;

  @Column({ type: "int", default: 0 })
  totalCents!: number;

  @Column({ type: "int", default: 0 })
  paidCents!: number;

  @Column({ type: "int", default: 0 })
  balanceCents!: number;

  @Column({ type: "text", default: "" })
  notes!: string;

  @Column({ type: "datetime", nullable: true })
  receivedAt!: Date | null;

  @Column({ type: "datetime", nullable: true })
  paidAt!: Date | null;

  @Column({ type: "datetime", nullable: true })
  voidedAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
