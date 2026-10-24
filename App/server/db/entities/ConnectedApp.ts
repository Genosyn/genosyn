import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";
import { dateTimeColumnType } from "./columnTypes.js";

/** Why a connected app stopped working before its tokens ran out. */
export type ConnectedAppRevocation =
  /** The Member disconnected it at Settings → API keys. */
  | "member"
  /** The app itself revoked its token (RFC 7009). */
  | "app"
  /** A refresh token or authorization code was used twice: one of the copies was stolen. */
  | "reuse";

/**
 * One Member's approval of one OAuth client — claude.ai, ChatGPT — to use the
 * Genosyn MCP server as them, in one company.
 *
 * It is the OAuth equivalent of a personal API key: it authenticates as
 * `userId`, only in `companyId`, and every operation it reaches is checked
 * against that Member's current role and Finance access, exactly as a key is.
 * Unlike a key, its tokens are short-lived and only work at the MCP endpoint
 * named by `resource` (and on that server's own calls back into the App), and
 * it can be revoked from Settings → API keys or by the app itself.
 *
 * Its tokens are `ConnectedAppToken` rows. Revocation is soft, so the audit
 * trail keeps a name to point at; a revoked app's tokens stop working at once.
 */
@Entity("connected_apps")
@Index(["companyId", "userId"])
export class ConnectedApp {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  /** The Member it acts as. Membership is re-checked on every request. */
  @Index()
  @Column({ type: "varchar" })
  userId!: string;

  /** `OAuthClient.id` of the app that was approved. */
  @Index()
  @Column({ type: "varchar" })
  oauthClientId!: string;

  /** The app's name when it was approved, for Settings and the audit log. */
  @Column({ type: "varchar" })
  name!: string;

  /** Where its authorization code was sent: the app's own address, shown beside its name. */
  @Column({ type: "text" })
  redirectUri!: string;

  /** The scope granted. One today: `mcp`, using the MCP server as the Member. */
  @Column({ type: "varchar" })
  scope!: string;

  /** The MCP endpoint its tokens are for (RFC 8707): this company's `/mcp` URL. */
  @Column({ type: "text" })
  resource!: string;

  /** Updated at most once a minute, when one of its access tokens is used. */
  @Column({ type: dateTimeColumnType, nullable: true })
  lastUsedAt!: Date | null;

  /** When its current refresh token runs out: 30 days after it was last refreshed. */
  @Column({ type: dateTimeColumnType })
  expiresAt!: Date;

  @Column({ type: dateTimeColumnType, nullable: true })
  revokedAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  revokedReason!: ConnectedAppRevocation | null;

  @CreateDateColumn()
  createdAt!: Date;
}
