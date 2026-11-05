import { dateTimeColumnType } from "./columnTypes.js";
import { Column, Entity, Index, PrimaryColumn, UpdateDateColumn } from "typeorm";

/**
 * Persistent authentication throttle shared by every API replica. A row whose
 * window ended does nothing, so old ones are pruned (`pruneAuthRateLimits`): the
 * Chat widget writes here from an endpoint anyone can reach.
 */
@Entity("auth_rate_limits")
@Index(["updatedAt"])
export class AuthRateLimit {
  /** SHA-256 of the rate-limit scope + IP/email; no raw identifier is stored. */
  @PrimaryColumn({ type: "varchar" })
  id!: string;

  @Column({ type: "integer", default: 0 })
  attempts!: number;

  @Column({ type: dateTimeColumnType })
  windowStartedAt!: Date;

  @Column({ type: dateTimeColumnType, nullable: true })
  blockedUntil!: Date | null;

  @UpdateDateColumn()
  updatedAt!: Date;
}
