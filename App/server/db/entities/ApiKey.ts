import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

/**
 * Programmatic-access token for the same REST surface humans use through the
 * UI. Authenticates as a specific User scoped to a single Company — even if
 * the User is a member of multiple companies, presenting an ApiKey only
 * unlocks the company the key was minted for.
 *
 * The plaintext token (`gen_<43 base64url chars>`) is shown to the user
 * exactly once at creation and never persisted — only its sha256 hash lives
 * in the DB. Lookup is O(1) on `tokenHash`. The first 8 chars of the random
 * suffix go in `prefix` so the UI can render an identifying chip without
 * storing the secret.
 *
 * Revocation is soft (`revokedAt`) so audit trails stay intact; expired or
 * revoked rows are filtered at the auth seam, not deleted.
 */
@Entity("api_keys")
export class ApiKey {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "varchar" })
  companyId!: string;

  /** The User this key authenticates as. Membership in `companyId` is
   * re-checked at request time, so demoting / removing the user revokes
   * their keys implicitly. */
  @Index()
  @Column({ type: "varchar" })
  userId!: string;

  /** Human-set label, shown in the UI. */
  @Column({ type: "varchar" })
  name!: string;

  /** First 8 chars of the random suffix (after the `gen_` prefix). Indexed
   * because the UI lists keys by prefix and we sometimes filter by it. */
  @Index()
  @Column({ type: "varchar", length: 16 })
  prefix!: string;

  /** sha256 hex of the random 32-byte suffix. Unique so two minted keys
   * can never collide; lookup is O(1) at the auth seam. */
  @Index({ unique: true })
  @Column({ type: "varchar", length: 64 })
  tokenHash!: string;

  /** NULL until the key has authenticated a request at least once. */
  @Column({ type: "datetime", nullable: true })
  lastUsedAt!: Date | null;

  /** Optional self-imposed expiry. NULL = never expires. */
  @Column({ type: "datetime", nullable: true })
  expiresAt!: Date | null;

  /** Set by `DELETE /api-keys/:id`. Soft so audit trails survive. */
  @Column({ type: "datetime", nullable: true })
  revokedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
