import { dateTimeColumnType } from "./columnTypes.js";
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/**
 * One authenticator app enrolled by a human Member. A Member may enroll
 * several — a phone plus a password manager plus a tablet — so every seed
 * lives on its own row instead of a single column on `users`.
 *
 * `secret` is the TOTP seed encrypted with the instance key, scoped to the
 * owning user. `verifiedAt` is the switch: a row exists from the moment setup
 * starts, but only a row that has proved a live six-digit code counts as a
 * second factor. Unverified rows are disposable and get cleared whenever the
 * Member starts setup again.
 */
@Entity("totp_credentials")
@Index(["userId"])
export class TotpCredential {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  userId!: string;

  /** Member-supplied label, unique per user so two phones stay tellable apart. */
  @Column({ type: "varchar", length: 100 })
  name!: string;

  /** Authenticator seed, encrypted with the instance secret. */
  @Column({ type: "text" })
  secret!: string;

  @Column({ type: dateTimeColumnType, nullable: true })
  verifiedAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  lastUsedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
