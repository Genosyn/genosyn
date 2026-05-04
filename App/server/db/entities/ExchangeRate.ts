import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * Exchange rate between two currencies on a given date. Phase E of
 * the Finance milestone (M19) — see ROADMAP.md.
 *
 * `rate` is the multiplier you apply to convert one unit of
 * `fromCurrency` into `toCurrency`. e.g. `from=EUR, to=USD, rate=1.08`
 * means €1 = $1.08.
 *
 * Lookups walk back from the requested date to the most recent rate
 * we have on file (so you don't have to enter a rate every day —
 * weekends and holidays use Friday's rate by default). Manual entry
 * for now; a follow-up could add an ECB daily fetch.
 */
@Entity("exchange_rates")
@Index(["companyId", "fromCurrency", "toCurrency", "date"], { unique: true })
@Index(["companyId", "fromCurrency", "toCurrency"])
export class ExchangeRate {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  fromCurrency!: string;

  @Column({ type: "varchar" })
  toCurrency!: string;

  @Column({ type: "datetime" })
  date!: Date;

  @Column({ type: "real" })
  rate!: number;

  /** Free-form note — the source the rate came from ("manual",
   *  "ECB 2026-05-04", a URL, etc.). Helps audit later. */
  @Column({ type: "varchar", default: "manual" })
  source!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
