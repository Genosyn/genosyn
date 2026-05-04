import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * A Customer is a billable counterparty for `Invoice`s. Phase A of the
 * Finance milestone (M19) — see ROADMAP.md.
 *
 * Per-company by id; slug is unique per company so URLs read like
 * `/c/<co>/finance/customers/<slug>`. Renames change the display name
 * but not the slug, matching how AI Employees and Projects are handled
 * elsewhere in the codebase.
 *
 * Addresses are stored as plain text blobs (one address per field, with
 * embedded newlines) rather than structured columns. Phase A doesn't do
 * anything jurisdiction-aware with the address — the printable invoice
 * just dumps it verbatim — so structure would be premature.
 */
@Entity("customers")
@Index(["companyId", "slug"], { unique: true })
@Index(["companyId", "archivedAt"])
export class Customer {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar" })
  slug!: string;

  /** Primary contact email — used as the default `to` for invoice "Send". */
  @Column({ type: "varchar", default: "" })
  email!: string;

  @Column({ type: "varchar", default: "" })
  phone!: string;

  @Column({ type: "text", default: "" })
  billingAddress!: string;

  @Column({ type: "text", default: "" })
  shippingAddress!: string;

  /** VAT / GST / EIN — printed on invoices in jurisdictions that require it. */
  @Column({ type: "varchar", default: "" })
  taxNumber!: string;

  /** ISO 4217 default currency for new invoices to this customer. Per-invoice
   *  override still wins. Phase E (multi-currency) introduces FX rates. */
  @Column({ type: "varchar", default: "USD" })
  currency!: string;

  @Column({ type: "text", default: "" })
  notes!: string;

  /** Soft-delete: archived customers stay queryable for historical invoices
   *  but are hidden from the default customer list and the new-invoice picker. */
  @Column({ type: "datetime", nullable: true })
  archivedAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
