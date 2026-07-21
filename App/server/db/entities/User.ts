import { dateTimeColumnType } from "./columnTypes.js";
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

@Entity("users")
@Index(["ssoIssuer", "ssoSubject"], { unique: true, where: '"ssoSubject" IS NOT NULL' })
export class User {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", unique: true })
  email!: string;

  @Column({ type: "varchar" })
  passwordHash!: string;

  @Column({ type: "varchar" })
  name!: string;

  /**
   * Short URL-safe identifier used for `@handle` mentions in workspace
   * chat and (eventually) anywhere we need to link to this person.
   * Globally unique so a mention can resolve without needing a company
   * scope. Nullable until the user picks one in Account → Profile.
   */
  @Index({ unique: true, where: '"handle" IS NOT NULL' })
  @Column({ type: "varchar", nullable: true })
  handle!: string | null;

  @Column({ type: "varchar", nullable: true })
  resetToken!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  resetExpiresAt!: Date | null;

  /** Set after the member proves control of their email address. */
  @Column({ type: dateTimeColumnType, nullable: true })
  emailVerifiedAt!: Date | null;

  /** SHA-256 digest of the current single-use email verification token. */
  @Column({ type: "varchar", nullable: true })
  emailVerificationTokenHash!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  emailVerificationExpiresAt!: Date | null;

  /**
   * Basename of the profile image on disk (e.g. `<uuid>.jpg`), stored under
   * `data/avatars/`. Null when the user hasn't uploaded one — the UI falls
   * back to initials in that case.
   */
  @Column({ type: "varchar", nullable: true })
  avatarKey!: string | null;

  /**
   * Instance-level operator flag. Master admins are the only users who may
   * reach the install-wide Admin dashboard (instance health, backups, and the
   * users/companies directory). The very first user to sign up is bootstrapped
   * as a master admin; existing master admins can promote anyone else from
   * Admin → Users. There is no company scope here — this spans the whole
   * deployment, unlike the per-company `Membership.role`.
   */
  @Column({ type: "boolean", default: false })
  isMasterAdmin!: boolean;

  /**
   * OpenID Connect identity this account is linked to, written on first SSO
   * sign-in (Admin → SSO): the provider's issuer URL plus its stable `sub`
   * claim. Login matches on the pair, so a subject minted by a
   * previously-configured issuer can never resolve to someone else's account.
   * Null until the user signs in via SSO; password login keeps working
   * either way.
   */
  @Column({ type: "varchar", nullable: true })
  ssoIssuer!: string | null;

  @Column({ type: "varchar", nullable: true })
  ssoSubject!: string | null;

  /**
   * Authenticator-app seed, encrypted with the instance secret. A seed may be
   * present while enrollment is in progress; `totpEnabledAt` is the switch
   * that makes it a valid second factor.
   */
  @Column({ type: "text", nullable: true })
  totpSecret!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  totpEnabledAt!: Date | null;

  /**
   * JSON array of SHA-256 recovery-code hashes. Plaintext codes are shown only
   * when generated and are never persisted.
   */
  @Column({ type: "text", nullable: true })
  recoveryCodes!: string | null;

  /** Incrementing this invalidates every signed cookie for the account. */
  @Column({ type: "integer", default: 0 })
  sessionVersion!: number;

  @CreateDateColumn()
  createdAt!: Date;
}
