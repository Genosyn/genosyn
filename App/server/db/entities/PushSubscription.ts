import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * One Web Push subscription = one browser profile on one device that the
 * user granted notification permission to. A user can hold several (laptop
 * Chrome, phone PWA, …); every Notification row fans out a push to all of
 * them. Rows are deleted when the push service says the endpoint is gone
 * (404/410) or the user disables push from that browser.
 *
 * User-scoped, not company-scoped: the bell feed is per-company, but the
 * device belongs to the person.
 */
@Entity("push_subscriptions")
@Index(["userId"])
export class PushSubscription {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  userId!: string;

  /** Push-service URL minted by the browser. Unique — re-subscribing the
   * same browser upserts instead of duplicating. */
  @Index({ unique: true })
  @Column({ type: "varchar", length: 1024 })
  endpoint!: string;

  /** Client public key (ECDH) for payload encryption. */
  @Column({ type: "varchar" })
  p256dh!: string;

  /** Client auth secret for payload encryption. */
  @Column({ type: "varchar" })
  auth!: string;

  /** Best-effort browser label so Settings can show "Chrome on macOS". */
  @Column({ type: "varchar", default: "" })
  userAgent!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
