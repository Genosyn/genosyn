import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

export type IntegrationAuthMode =
  | "apikey"
  | "oauth2"
  | "service_account"
  | "github_app"
  | "browser";
export type IntegrationConnectionStatus = "connected" | "error" | "expired";

/**
 * One authenticated account inside a third-party Integration (Stripe, Gmail,
 * Metabase, …). Per-company — a company can hold multiple Connections for
 * the same provider (e.g. "Stripe US" and "Stripe EU").
 *
 * The integration *type* itself is a static catalog defined in code under
 * `server/integrations/providers/` — it is not a DB row. The only provider
 * state that lives here is per-connection: the account label, credentials,
 * and health-check status.
 *
 * `encryptedConfig` is an AES-256-GCM ciphertext (shared helper in
 * `server/lib/secret.ts`, keyed from `config.sessionSecret`) wrapping a
 * JSON blob whose shape is provider-specific:
 *   - apikey          : { apiKey, baseUrl?, ...providerMeta }
 *   - oauth2          : { clientId, clientSecret, accessToken, refreshToken,
 *                         expiresAt, scope, email, ... } — the OAuth client
 *                         credentials live on each Connection so different
 *                         Connections can use different Google projects.
 *   - service_account : { clientEmail, privateKey, privateKeyId, projectId,
 *                         scopes, impersonationEmail?, accessToken?,
 *                         expiresAt? } — JWT-bearer auth; access tokens are
 *                         re-minted on demand (no refresh token concept).
 *   - browser         : { username, password, ...providerExtras,
 *                         storageStateJson?, lastLoginAt? } — credentials
 *                         the headless-browser driver replays at runtime.
 *                         `storageStateJson` is the cached Playwright
 *                         storageState (cookies + localStorage) so we don't
 *                         re-login on every tool call.
 *
 * AI employees access a Connection via an `EmployeeConnectionGrant`; the
 * raw credential never leaves the server.
 */
@Entity("integration_connections")
@Index(["companyId"])
@Index(["companyId", "provider"])
export class IntegrationConnection {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  /** Matches a key from the static provider catalog ("stripe" | "google" | …). */
  @Column({ type: "varchar" })
  provider!: string;

  /** Human-chosen label, e.g. "Stripe US", "Support inbox". */
  @Column({ type: "varchar" })
  label!: string;

  @Column({ type: "varchar", default: "apikey" })
  authMode!: IntegrationAuthMode;

  /** AES-256-GCM ciphertext of the provider-specific config+credentials JSON. */
  @Column({ type: "text" })
  encryptedConfig!: string;

  /** For display in the UI — a short, non-sensitive identifier like the
   * masked API key suffix or the OAuth account email. */
  @Column({ type: "varchar", default: "" })
  accountHint!: string;

  @Column({ type: "varchar", default: "connected" })
  status!: IntegrationConnectionStatus;

  /** Last status-check error — empty when healthy. */
  @Column({ type: "varchar", default: "" })
  statusMessage!: string;

  @Column({ type: "datetime", nullable: true })
  lastCheckedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
