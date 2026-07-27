import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";
import { dateTimeColumnType } from "./columnTypes.js";

export type DealHistoryEventKind =
  | "created"
  | "snapshot"
  | "stage_changed"
  | "amount_changed"
  | "owner_changed"
  | "expected_close_changed"
  | "won"
  | "lost";

export type DealHistorySourceKind = "live" | "import" | "activity_backfill";

/**
 * Immutable Deal history used by time-aware funnel reporting.
 *
 * Activity remains the human timeline. This table is the reporting ledger:
 * ordered, source-identifiable events with typed before/after values.
 */
@Entity("deal_history_events")
@Index(["companyId", "dealId", "occurredAt"])
@Index(["companyId", "kind", "occurredAt"])
@Index(["companyId", "sourceKey"], { unique: true })
@Index(["sourceActivityId"], { unique: true })
export class DealHistoryEvent {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  dealId!: string;

  @Column({ type: "varchar" })
  kind!: DealHistoryEventKind;

  @Column({ type: dateTimeColumnType })
  occurredAt!: Date;

  @Column({ type: "varchar", nullable: true })
  fromStageId!: string | null;

  @Column({ type: "varchar", nullable: true })
  toStageId!: string | null;

  @Column({ type: "int", nullable: true })
  fromAmountCents!: number | null;

  @Column({ type: "int", nullable: true })
  toAmountCents!: number | null;

  @Column({ type: "varchar", default: "" })
  currency!: string;

  @Column({ type: "varchar", nullable: true })
  fromOwnerId!: string | null;

  @Column({ type: "varchar", nullable: true })
  fromOwnerEmployeeId!: string | null;

  @Column({ type: "varchar", nullable: true })
  toOwnerId!: string | null;

  @Column({ type: "varchar", nullable: true })
  toOwnerEmployeeId!: string | null;

  @Column({ type: "varchar", default: "" })
  lostReason!: string;

  @Column({ type: "varchar" })
  sourceKind!: DealHistorySourceKind;

  /**
   * Stable idempotency key. Importers use
   * `<source-system>:<source-record>:<source-event>`; live writes use an
   * operation-scoped uuid.
   */
  @Column({ type: "varchar" })
  sourceKey!: string;

  @Column({ type: "varchar", nullable: true })
  sourceActivityId!: string | null;

  @Column({ type: "text", default: "" })
  metadataJson!: string;

  @Column({ type: "varchar", nullable: true })
  createdByUserId!: string | null;

  @Column({ type: "varchar", nullable: true })
  createdByEmployeeId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
