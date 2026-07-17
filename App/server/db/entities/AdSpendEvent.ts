import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * Append-only ledger of **authorized** ad-spend deltas. One row per
 * spend-affecting mutation an AI employee performed through an ads
 * Integration — budget raised, budget lowered, campaign enabled or paused.
 *
 * Deliberately a SQL table rather than the encrypted-blob `spendLog`
 * Lightning uses: budget caps aren't secrets, the database is the source
 * of truth, and "how much did this employee authorize this month?" must be
 * answerable with a query. Rolling daily/monthly caps in
 * `integrations/providers/ads-shared.ts` are computed from the positive
 * deltas here (via `services/adSpend.ts`), and they run on every execution
 * path — including approved replays.
 *
 * `amountMinor` is signed and denominated in the ad account's own minor
 * currency units (cents for USD; Google's micros are converted by the
 * provider before recording). Increases are positive, decreases negative;
 * pure status flips that don't change a budget record the budget they
 * enable (campaign_enable) or free (campaign_pause).
 */
@Entity("ad_spend_events")
export class AdSpendEvent {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "varchar" })
  companyId!: string;

  @Index()
  @Column({ type: "varchar" })
  connectionId!: string;

  /** Empty string when a human/system path (not an employee) mutated. */
  @Index()
  @Column({ type: "varchar", default: "" })
  employeeId!: string;

  /** Provider id, e.g. "google-ads". */
  @Column({ type: "varchar" })
  platform!: string;

  /** Platform-side ad account reference (customer id, act_… id). */
  @Column({ type: "varchar", default: "" })
  adAccountRef!: string;

  /** Platform-side campaign / budget reference. */
  @Column({ type: "varchar", default: "" })
  campaignRef!: string;

  /** Provider tool that performed the mutation. */
  @Column({ type: "varchar" })
  toolName!: string;

  /** budget_increase | budget_decrease | campaign_enable | campaign_pause */
  @Column({ type: "varchar" })
  mutationKind!: string;

  /** Signed authorized delta in minor currency units. */
  @Column({ type: "integer", default: 0 })
  amountMinor!: number;

  /** ISO currency code of the ad account, best-effort. */
  @Column({ type: "varchar", default: "" })
  currency!: string;

  /** Approval row that authorized this, when one was required. */
  @Column({ type: "varchar", nullable: true })
  approvalId!: string | null;

  @Column({ type: "text", nullable: true })
  summary!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
