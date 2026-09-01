import { dateTimeColumnType } from "./columnTypes.js";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * One company's Genosyn Cloud Plan and its Stripe subscription state (M56).
 *
 * Only meaningful where the operator has enabled instance billing at
 * Admin → Billing — self-hosted installs never create these rows. Absence of
 * a row means the Free plan; a paid `plan` counts only while `status` is one
 * the entitlements resolver treats as active (see
 * `services/entitlements.ts`, the single source of truth).
 *
 * The Stripe ids are bare varchars like every sibling FK — Stripe owns their
 * lifecycle, and the webhook + `POST /billing/sync` keep this row honest.
 */
@Entity("company_billing")
@Index(["companyId"], { unique: true })
export class CompanyBilling {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  /** "free" | "growth" | "scale" — see `services/billing/plans.ts`. */
  @Column({ type: "varchar", default: "free" })
  plan!: string;

  /** "month" | "year" — which price the live subscription bills on (M56).
   * Null on Free and on rows written before annual existed; resolved from the
   * subscription's price id every time state is applied. */
  @Column({ type: "varchar", nullable: true })
  billingInterval!: string | null;

  @Column({ type: "varchar", nullable: true })
  stripeCustomerId!: string | null;

  @Column({ type: "varchar", nullable: true })
  stripeSubscriptionId!: string | null;

  /** The subscription item whose quantity is the billed seat count. */
  @Column({ type: "varchar", nullable: true })
  stripeSubscriptionItemId!: string | null;

  /** Raw Stripe subscription status ("active", "past_due", …); null when the
   * company has never subscribed. */
  @Column({ type: "varchar", nullable: true })
  status!: string | null;

  /** Billed quantity — mirrors the subscription item's quantity. */
  @Column({ type: "integer", nullable: true })
  seatCount!: number | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  currentPeriodEnd!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
