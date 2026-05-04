import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * A currency a company invoices in. Phase E of the Finance milestone
 * (M19) — see ROADMAP.md.
 *
 * Per-company so a small business can keep their list short rather
 * than scrolling the full ISO 4217 catalog. The standard currencies
 * are seeded on first finance-settings visit.
 *
 * `decimalPlaces` covers the JPY (0) / USD (2) / KWD (3) split. Money
 * cents math throughout the app assumes 2 decimals; Phase E ships with
 * the column populated for forward-compatibility but the math still
 * treats every currency as 2-decimal. A follow-up will plumb the value
 * through `formatMoney` so JPY stops showing fake decimals.
 */
@Entity("currencies")
@Index(["companyId", "code"], { unique: true })
export class Currency {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  /** ISO 4217 code in upper case — `USD`, `EUR`, `JPY`. */
  @Column({ type: "varchar" })
  code!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar", default: "" })
  symbol!: string;

  @Column({ type: "int", default: 2 })
  decimalPlaces!: number;

  @CreateDateColumn()
  createdAt!: Date;
}
