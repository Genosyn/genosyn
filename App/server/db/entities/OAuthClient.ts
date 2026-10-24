import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";
import { dateTimeColumnType } from "./columnTypes.js";

/** How a client proves itself at the token endpoint (RFC 7591 §2). */
export type OAuthClientAuthMethod = "none" | "client_secret_post" | "client_secret_basic";

/**
 * An OAuth client that registered itself with this install's authorization
 * server — claude.ai, ChatGPT, or any MCP client that signs in with OAuth
 * (RFC 7591 dynamic client registration, which the MCP authorization spec asks
 * servers to offer).
 *
 * Registration is open, as it must be for those clients, so a row grants
 * nothing by itself: it names an app and the addresses its codes may be sent
 * back to. Access only exists once a Member approves the app for one company,
 * which creates a `ConnectedApp`. Install-wide rather than per company, because
 * the client registers before anyone has said which company it is for.
 *
 * A confidential client's secret is stored as its sha256 hash, like every
 * other bearer credential here. Rows never used for a connection are pruned
 * (`services/mcpOauth/clients.ts`).
 */
@Entity("oauth_clients")
export class OAuthClient {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  /** The public `client_id`: `gci_` and 22 base64url characters. */
  @Index({ unique: true })
  @Column({ type: "varchar", length: 64 })
  clientId!: string;

  /** sha256 hex of the client secret, for confidential clients only. */
  @Column({ type: "varchar", length: 64, nullable: true })
  clientSecretHash!: string | null;

  @Column({ type: "varchar", default: "none" })
  tokenEndpointAuthMethod!: OAuthClientAuthMethod;

  /** `client_name` as the client sent it — self-asserted, so shown beside where it redirects. */
  @Column({ type: "varchar" })
  name!: string;

  /** `client_uri`, when the client sent one. Self-asserted too. */
  @Column({ type: "varchar", nullable: true })
  clientUri!: string | null;

  /** JSON array of the exact redirect URIs a code may be sent to. */
  @Column({ type: "text" })
  redirectUrisJson!: string;

  /** When the client last started an authorization or used the token endpoint. */
  @Column({ type: dateTimeColumnType, nullable: true })
  lastUsedAt!: Date | null;

  @Index()
  @CreateDateColumn()
  createdAt!: Date;
}
