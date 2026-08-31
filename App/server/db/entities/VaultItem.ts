import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from "typeorm";

export type VaultItemType = "login" | "api_key" | "secure_note";
export type VaultItemVisibility = "company" | "restricted";

/**
 * One encrypted credential or secure note in a company's Vault.
 *
 * The display title, username, secret, website URL and notes are stored as one
 * authenticated encrypted JSON payload. Keeping them together avoids leaking
 * useful credential metadata through a raw database read and makes updates a
 * single atomic ciphertext replacement.
 *
 * A row with a `vaultSourceId` is a **mirror** of an item in an external vault
 * (see `VaultSource`). It exists so human Access, AI Employee Grants, audit and
 * Browser autofill all work exactly as they do for a native item — but its
 * payload holds only the title, username and website. The secret stays in the
 * external vault and is fetched at the moment it is used, so connecting
 * Bitwarden does not copy a company's passwords into this database.
 */
@Entity("vault_items")
@Index(["companyId", "visibility"])
@Index(["createdByUserId"])
@Index(["createdByEmployeeId"])
@Index(["companyId", "vaultSourceId"])
@Index(["vaultSourceId", "externalItemId"], { unique: true })
export class VaultItem {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  type!: VaultItemType;

  @Column({ type: "varchar", default: "restricted" })
  visibility!: VaultItemVisibility;

  /** AES-256-GCM payload written through `services/vault.ts`. */
  @Column({ type: "text" })
  encryptedPayload!: string;

  /** Optimistic concurrency guard for whole-payload ciphertext replacement. */
  @VersionColumn({ default: 1 })
  version!: number;

  /** Null only after the creating Member is deleted. */
  @Column({ type: "varchar", nullable: true })
  createdByUserId!: string | null;

  /** AI Employee provenance for browser/MCP-created credentials. */
  @Column({ type: "varchar", nullable: true })
  createdByEmployeeId!: string | null;

  /** Set only on a mirror: the `VaultSource` this item is read from. */
  @Column({ type: "varchar", nullable: true })
  vaultSourceId!: string | null;

  /** Set only on a mirror: the item's identifier in the external vault. */
  @Column({ type: "varchar", nullable: true })
  externalItemId!: string | null;

  /** The external item's last-known revision, so a sync can skip unchanged rows. */
  @Column({ type: "varchar", default: "" })
  externalRevision!: string;

  /**
   * Whether the external item carries an authenticator. The seed itself is
   * never stored here, so `payload.totp` cannot answer this for a mirror.
   */
  @Column({ type: "boolean", default: false })
  externalHasTotp!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
