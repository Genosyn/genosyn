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

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
