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
 */
@Entity("vault_items")
@Index(["companyId", "visibility"])
@Index(["createdByUserId"])
@Index(["createdByEmployeeId"])
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

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
