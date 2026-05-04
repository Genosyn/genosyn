import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * A TaxRate is a named percentage applied to invoice line items. Phase A
 * of the Finance milestone (M19) — see ROADMAP.md.
 *
 * Inclusive vs exclusive matters:
 *   - **Exclusive** (US sales tax style): tax is added on top of the unit
 *     price. `total = subtotal + tax`.
 *   - **Inclusive** (EU/AU/NZ VAT/GST style): the unit price already
 *     contains the tax. `total = subtotal`; tax is derived as
 *     `subtotal × rate / (100 + rate)`.
 *
 * `lib/money.ts > computeLineTotals()` handles both shapes.
 *
 * Tax rates are snapshotted onto `InvoiceLineItem` (taxName, taxPercent,
 * taxInclusive) so historical invoices don't drift when the rate changes.
 * Phase E will replace this with a composable jurisdictional tax engine.
 */
@Entity("tax_rates")
@Index(["companyId", "archivedAt"])
export class TaxRate {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  /** Display name — appears on invoices, e.g. "VAT 20%" or "CA Sales Tax". */
  @Column({ type: "varchar" })
  name!: string;

  /** Percent as a real number (e.g. `7.25` for 7.25%). Stored as real not
   *  basis-points so accountants can enter what they read off official
   *  rate tables verbatim. */
  @Column({ type: "real", default: 0 })
  ratePercent!: number;

  @Column({ type: "boolean", default: false })
  inclusive!: boolean;

  @Column({ type: "datetime", nullable: true })
  archivedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
