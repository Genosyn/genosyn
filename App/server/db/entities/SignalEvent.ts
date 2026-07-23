import { dateTimeColumnType } from "./columnTypes.js";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

export type SignalEventStatus = "new" | "actioned" | "ignored" | "failed";

export const SIGNAL_EVENT_STATUSES: SignalEventStatus[] = [
  "new",
  "actioned",
  "ignored",
  "failed",
];

/**
 * One firing of a {@link Signal}. See ROADMAP.md M32.
 *
 * The unique `(signalId, dedupeKey)` index is the entire dedupe mechanism, and
 * it is enforced by the database rather than by the tick that writes it. That
 * matters because two replicas can evaluate the same signal in the same second
 * — the loser gets a constraint violation and skips, which is exactly right.
 * A dedupe check done in application code would let both through.
 *
 * Append-only apart from `status`, which moves `new` → `actioned` / `ignored` /
 * `failed` once the action runs. Keeping failed events visible (rather than
 * retrying forever or dropping them) is the same choice the card-expense
 * postings made in M19: a failure a human can see gets fixed.
 */
@Entity("signal_events")
@Index(["signalId", "dedupeKey"], { unique: true })
@Index(["companyId", "occurredAt"])
@Index(["companyId", "status"])
@Index(["contactId"])
export class SignalEvent {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  signalId!: string;

  /**
   * Value of the signal's `dedupeKeyColumn` for this row. Falls back to a hash
   * of the whole row when the signal names no column, so a misconfigured signal
   * degrades to "fire once per distinct row" instead of firing forever.
   */
  @Column({ type: "varchar" })
  dedupeKey!: string;

  /** The whole result row as JSON, so the action has everything it needs. */
  @Column({ type: "text", nullable: true })
  payloadJson!: string | null;

  @Column({ type: "varchar", nullable: true })
  contactId!: string | null;

  @Column({ type: "varchar", nullable: true })
  customerId!: string | null;

  /** Set when the action opened one. */
  @Column({ type: "varchar", nullable: true })
  dealId!: string | null;

  @Column({ type: "varchar", default: "new" })
  status!: SignalEventStatus;

  /** Why it failed, or what the action did. */
  @Column({ type: "text", default: "" })
  detail!: string;

  @Column({ type: dateTimeColumnType })
  occurredAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;
}
