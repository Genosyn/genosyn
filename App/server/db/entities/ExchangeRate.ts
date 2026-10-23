import { dateTimeColumnType } from "./columnTypes.js";
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

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
 * weekends and holidays use Friday's rate by default). A person sets a
 * rate by hand, or `services/exchangeRateFeed.ts` fills them from the
 * European Central Bank's daily reference rates.
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

  @Column({ type: dateTimeColumnType })
  date!: Date;

  @Column({ type: "real" })
  rate!: number;

  /** Free-form note — the source the rate came from ("manual",
   *  "ECB 2026-05-04", a URL, etc.). Helps audit later. */
  @Column({ type: "varchar", default: "manual" })
  source!: string;

  /** Fetched from the ECB rather than set by a person. A fetched rate never
   *  replaces a person's rate for the same day; setting one by hand replaces
   *  the fetched one. While a company has automatic rates off, conversions
   *  skip these rows. `source` is free text a person may also fill with
   *  "ECB", so this flag, not the source, says which is which. */
  @Column({ type: "boolean", default: false })
  automatic!: boolean;

  @CreateDateColumn()
  createdAt!: Date;
}
