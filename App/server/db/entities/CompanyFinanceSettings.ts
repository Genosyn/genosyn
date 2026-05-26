import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * Per-company finance settings. Phase E of the Finance milestone
 * (M19) — see ROADMAP.md.
 *
 * One row per company (enforced at the service layer via upsert);
 * stores the values that previously had to be hard-coded across the
 * finance services:
 *   - `homeCurrency`: the company's reporting currency. Every ledger
 *     entry posts in this currency. Defaults to USD.
 *   - `defaultFromBlock`: multi-line text shown in the "From" column on
 *     every rendered invoice / estimate. Empty means "fall back to the
 *     bare company name", which is the legacy behavior. Typical content
 *     is company name + address + tax ID + contact email.
 *   - `defaultFooter`: multi-line text used as the printable footer
 *     when a specific invoice / estimate has no `footer` of its own.
 *     Per-doc footers always win — this is just the default.
 *
 * Created lazily the first time `getFinanceSettings()` is called.
 */
@Entity("company_finance_settings")
@Index(["companyId"], { unique: true })
export class CompanyFinanceSettings {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar", default: "USD" })
  homeCurrency!: string;

  @Column({ type: "text", default: "" })
  defaultFromBlock!: string;

  @Column({ type: "text", default: "" })
  defaultFooter!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
