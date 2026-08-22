import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { dateTimeColumnType } from "./columnTypes.js";

export type RevenueFirmographicLookupStatus = "matched" | "not_found" | "failed";

/**
 * RETIRED IN 1.132.0 — Revenue firmographics went away with the People Data
 * Labs connector, which was the only provider implementing the lookup hook.
 *
 * Nothing looks these rows up, refreshes them, or creates new ones any more.
 * The entity and its `revenue_firmographic_lookups` table stay registered so
 * historical rows survive and the generated schema does not change; the only
 * code left touching them is generic record lifecycle work (company delete,
 * Account merge/undo, and dependency counting).
 *
 * `normalizedSnapshotJson` is the small provider-neutral profile, never the
 * provider's raw response. Field-level history belongs to
 * `RevenueFieldEvidence`.
 */
@Entity("revenue_firmographic_lookups")
@Index(["companyId", "customerId", "connectionId"], { unique: true })
@Index(["companyId", "status", "lastAttemptedAt"])
export class RevenueFirmographicLookup {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  customerId!: string;

  @Column({ type: "varchar" })
  connectionId!: string;

  @Column({ type: "varchar" })
  provider!: string;

  @Column({ type: "varchar", default: "" })
  providerRecordId!: string;

  @Column({ type: "varchar" })
  status!: RevenueFirmographicLookupStatus;

  /** Allowlisted `CompanyFirmographicProfile`, or `{}` before a match. */
  @Column({ type: "text", default: "{}" })
  normalizedSnapshotJson!: string;

  @Column({ type: "int", default: 0 })
  confidence!: number;

  @Column({ type: dateTimeColumnType })
  lastAttemptedAt!: Date;

  @Column({ type: dateTimeColumnType, nullable: true })
  lastMatchedAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  observedAt!: Date | null;

  @Column({ type: "text", default: "" })
  lastError!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
