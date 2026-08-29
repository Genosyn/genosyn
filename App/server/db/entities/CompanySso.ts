import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * Per-company single sign-on on a Genosyn Cloud install (M56 Phase B).
 *
 * A company on the Scale plan configures its own identity provider at
 * Settings → Single sign-on; members then sign in from
 * `/login/sso/<companySlug>`. Separate from the instance-wide `sso.settings`
 * AppSetting, which is the operator's own sign-in — this row exists per
 * company and only takes effect while the company's entitlements include the
 * `sso` feature (see `services/entitlements.ts`).
 *
 * The client secret is encrypted with the company-scoped key
 * (`encryptSecret(secret, "company:<companyId>")` — the IntegrationConnection
 * pattern) and never leaves the server.
 */
@Entity("company_sso")
@Index(["companyId"], { unique: true })
export class CompanySso {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "boolean", default: false })
  enabled!: boolean;

  /** "google" | "oidc". */
  @Column({ type: "varchar", default: "google" })
  provider!: string;

  /** Login-button label override; blank means the provider default. */
  @Column({ type: "varchar", default: "" })
  displayName!: string;

  /** OIDC issuer URL. Ignored (fixed) when provider is "google". */
  @Column({ type: "varchar", default: "" })
  issuer!: string;

  @Column({ type: "varchar", default: "" })
  clientId!: string;

  /** Encrypted with the company scope; empty until a secret is saved. */
  @Column({ type: "varchar", default: "" })
  encryptedClientSecret!: string;

  /**
   * When true, a successful IdP sign-in may create a Membership (role
   * "member") in this company for the signed-in user, and may auto-provision
   * a brand-new User for an unknown email.
   */
  @Column({ type: "boolean", default: true })
  autoJoin!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
