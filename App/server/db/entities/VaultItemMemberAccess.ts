import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

export type VaultMemberAccessLevel = "view" | "edit";

/**
 * Explicit human Member access to a restricted Vault item.
 *
 * This is deliberately named Access, not Grant: in Genosyn, Grant is the
 * product term for an AI Employee's access to a resource. Company-visible
 * items need no rows here; an access row remains useful if the item is later
 * switched back to restricted visibility.
 */
@Entity("vault_item_member_access")
@Index(["companyId"])
@Index(["userId"])
@Index(["vaultItemId", "userId"], { unique: true })
export class VaultItemMemberAccess {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  vaultItemId!: string;

  @Column({ type: "varchar" })
  userId!: string;

  @Column({ type: "varchar", default: "view" })
  accessLevel!: VaultMemberAccessLevel;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
