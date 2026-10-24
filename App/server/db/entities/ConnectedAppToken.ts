import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";
import { dateTimeColumnType } from "./columnTypes.js";

export type ConnectedAppTokenKind = "access" | "refresh";

/**
 * One OAuth token of a `ConnectedApp`: an access token (`gat_…`, an hour) or a
 * refresh token (`grt_…`, 30 days). Only the sha256 of the token is stored,
 * as with API keys; the plaintext reaches the app once, in the token response.
 *
 * A refresh token is spent the first time it is used and replaced by a new
 * pair (rotation). The spent row is kept until it would have expired, so a
 * second use — the sign of a stolen copy — is recognized and revokes the whole
 * connected app. Expired rows are swept (`services/mcpOauth/tokens.ts`).
 */
@Entity("connected_app_tokens")
export class ConnectedAppToken {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "varchar" })
  connectedAppId!: string;

  @Column({ type: "varchar" })
  kind!: ConnectedAppTokenKind;

  /** sha256 hex of the whole token, prefix included. */
  @Index({ unique: true })
  @Column({ type: "varchar", length: 64 })
  tokenHash!: string;

  @Index()
  @Column({ type: dateTimeColumnType })
  expiresAt!: Date;

  /** A refresh token's rotation: set when it was exchanged for a new pair. */
  @Column({ type: dateTimeColumnType, nullable: true })
  usedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
