import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

@Entity("users")
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
   * scope. Nullable until the user picks one in Profile Settings.
   */
  @Index({ unique: true, where: "handle IS NOT NULL" })
  @Column({ type: "varchar", nullable: true })
  handle!: string | null;

  @Column({ type: "varchar", nullable: true })
  resetToken!: string | null;

  @Column({ type: "datetime", nullable: true })
  resetExpiresAt!: Date | null;

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

  @CreateDateColumn()
  createdAt!: Date;
}
