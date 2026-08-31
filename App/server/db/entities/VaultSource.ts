import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

import { dateTimeColumnType } from "./columnTypes.js";

/** The external password managers a company can mirror into its Vault. */
export type VaultSourceKind = "bitwarden";

export type VaultSourceStatus = "connected" | "error";

/**
 * One external vault a company mirrors credentials from.
 *
 * A company that already runs Bitwarden or Vaultwarden should not have to keep
 * the same password in two places. A Vault source points at that server; the
 * items it holds appear in the Vault as ordinary {@link VaultItem} rows that
 * carry no secret of their own — the secret is fetched from the source at the
 * moment it is used and is never written to this database.
 *
 * This is deliberately not an Integration. An Integration Connection is granted
 * to an AI Employee wholesale and exposes tools; the whole point of the Vault
 * is that access is per item, with `use < manage` Grants and separate human
 * Access. Mirroring into `VaultItem` inherits all of that unchanged.
 *
 * `encryptedConfig` is an AES-256-GCM ciphertext (`lib/secret.ts`, scoped to the
 * company) wrapping `{ email, masterPassword, clientId?, clientSecret?,
 * deviceIdentifier, refreshToken?, twoFactorToken? }`. The master password is
 * unavoidable: Bitwarden derives the vault's decryption key from it, and a
 * server-side mirror cannot ask a human for it on every Run.
 */
@Entity("vault_sources")
@Index(["companyId"])
@Index(["companyId", "kind"])
export class VaultSource {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar", default: "bitwarden" })
  kind!: VaultSourceKind;

  /** Human-chosen label, e.g. "Vaultwarden (ops)". */
  @Column({ type: "varchar" })
  label!: string;

  /** The web vault URL. `identity` and `api` are derived from it. */
  @Column({ type: "varchar" })
  serverUrl!: string;

  /** Non-sensitive display identity — the account email. */
  @Column({ type: "varchar", default: "" })
  accountHint!: string;

  /** AES-256-GCM ciphertext of the sign-in material. */
  @Column({ type: "text" })
  encryptedConfig!: string;

  /**
   * When set, only items filed under a folder or collection with this exact
   * name (case-insensitive) are mirrored. Empty means the whole vault.
   */
  @Column({ type: "varchar", default: "" })
  scopeName!: string;

  /** Visibility new mirrored items are created with. */
  @Column({ type: "varchar", default: "restricted" })
  defaultVisibility!: "company" | "restricted";

  @Column({ type: "varchar", default: "connected" })
  status!: VaultSourceStatus;

  /** Last failure, empty when healthy. */
  @Column({ type: "varchar", default: "" })
  statusMessage!: string;

  @Column({ type: dateTimeColumnType, nullable: true })
  lastSyncedAt!: Date | null;

  /** How many items the last successful sync mirrored. */
  @Column({ type: "integer", default: 0 })
  lastSyncItemCount!: number;

  /** Null only after the connecting Member is deleted. */
  @Column({ type: "varchar", nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
