import { dateTimeColumnType } from "./columnTypes.js";
import { Column, Entity, PrimaryColumn, UpdateDateColumn } from "typeorm";

/** Persistent authentication throttle shared by every API replica. */
@Entity("auth_rate_limits")
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
