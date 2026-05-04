import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * A Product (or Service) is a reusable line-item template. Phase A of the
 * Finance milestone (M19) — see ROADMAP.md.
 *
 * Products are *templates*: when an `InvoiceLineItem` is created from a
 * product, the description / unit price / tax rate are snapshotted onto
 * the line item. Editing the product later does NOT change historical
 * invoices — accountants would lose their minds otherwise.
 */
@Entity("products")
@Index(["companyId", "slug"], { unique: true })
@Index(["companyId", "archivedAt"])
export class Product {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar" })
  slug!: string;

  @Column({ type: "text", default: "" })
  description!: string;

  /** Default unit price in minor units (cents). Quantity × this = line subtotal. */
  @Column({ type: "int", default: 0 })
  unitPriceCents!: number;

  /** ISO 4217. Surfaced as the default when this product is added to an
   *  invoice; the invoice's own currency wins on conversion (Phase E). */
  @Column({ type: "varchar", default: "USD" })
  currency!: string;

  /** Optional default `TaxRate.id` snapshotted onto new line items. */
  @Column({ type: "varchar", nullable: true })
  defaultTaxRateId!: string | null;

  @Column({ type: "datetime", nullable: true })
  archivedAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
