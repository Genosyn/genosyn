import { dateTimeColumnType } from "./columnTypes.js";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/** Where the rows come from. */
export type SignalSourceKind = "sql" | "stripe";

export const SIGNAL_SOURCE_KINDS: SignalSourceKind[] = ["sql", "stripe"];

/**
 * What happens when a row fires.
 *
 * - `activity`         — log it on the Contact timeline. The safe default.
 * - `notify`           — bell + push to owners/admins.
 * - `create_deal`      — open a Deal in the first stage.
 * - `enroll_sequence`  — add the Contact to a Sequence.
 * - `hand_to_employee` — wake an AI Employee with the payload and let it decide.
 */
export type SignalActionKind =
  | "activity"
  | "notify"
  | "create_deal"
  | "enroll_sequence"
  | "hand_to_employee";

export const SIGNAL_ACTION_KINDS: SignalActionKind[] = [
  "activity",
  "notify",
  "create_deal",
  "enroll_sequence",
  "hand_to_employee",
];

/**
 * A product-usage trigger. See ROADMAP.md M32.
 *
 * This is the piece that makes the revenue section specific to SaaS rather than
 * generic CRM: the company's own product database already knows who is about to
 * churn, who just hit a seat limit, and whose trial ends on Thursday. A Signal
 * is a saved query over a connected database (or Stripe) plus a rule for what
 * to do when it returns rows.
 *
 * It is deliberately thin. Query execution reuses the Explore executor
 * (`services/explore.ts`) with its existing 30s timeout and 5,000-row cap, and
 * scheduling reuses the cron machinery. The only genuinely new idea is
 * `dedupeKeyColumn`: without it every tick re-fires on the same rows, and a
 * trigger that cries wolf every minute gets muted within a day. The unique
 * index on `SignalEvent(signalId, dedupeKey)` is what makes "fire once per
 * account per condition" a database guarantee rather than a hope.
 *
 * Read-only SQL is **not** enforced, exactly as in Explore — connect with a
 * least-privileged role. That is stated in the docs and in the UI.
 */
@Entity("signals")
@Index(["companyId", "slug"], { unique: true })
@Index(["companyId", "enabled"])
export class Signal {
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

  @Column({ type: "varchar", default: "sql" })
  sourceKind!: SignalSourceKind;

  /** The `IntegrationConnection` to run against. Null for `stripe`-kind. */
  @Column({ type: "varchar", nullable: true })
  connectionId!: string | null;

  @Column({ type: "text", default: "" })
  sql!: string;

  /** Standard 5-field cron, validated against the scheduler that runs it. */
  @Column({ type: "varchar", default: "0 * * * *" })
  cron!: string;

  @Column({ type: "boolean", default: false })
  enabled!: boolean;

  /**
   * Column whose value identifies the subject, so the same account firing on
   * consecutive ticks produces one event. Without this a signal is a firehose.
   */
  @Column({ type: "varchar", default: "" })
  dedupeKeyColumn!: string;

  /** Column carrying an email address, used to resolve or create a Contact. */
  @Column({ type: "varchar", default: "" })
  emailColumn!: string;

  /** Column carrying a company domain, used to resolve a Customer. */
  @Column({ type: "varchar", default: "" })
  domainColumn!: string;

  /** Column carrying a money amount in minor units, for `create_deal`. */
  @Column({ type: "varchar", default: "" })
  amountColumn!: string;

  @Column({ type: "varchar", default: "activity" })
  actionKind!: SignalActionKind;

  /** Action-specific config — target sequence, stage, instruction text. */
  @Column({ type: "text", nullable: true })
  actionConfigJson!: string | null;

  /** For `hand_to_employee`. */
  @Column({ type: "varchar", nullable: true })
  employeeId!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  lastRunAt!: Date | null;

  /** Last failure, kept visible rather than parking the signal silently. */
  @Column({ type: "text", default: "" })
  lastError!: string;

  @Column({ type: "int", default: 0 })
  lastEventCount!: number;

  @Column({ type: dateTimeColumnType, nullable: true })
  archivedAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
