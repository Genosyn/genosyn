import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

export type EmployeeVaultAccessLevel = "use" | "manage";

export const EMPLOYEE_VAULT_ACCESS_LEVELS: EmployeeVaultAccessLevel[] = ["use", "manage"];

export const EMPLOYEE_VAULT_ACCESS_RANK: Record<EmployeeVaultAccessLevel, number> = {
  use: 0,
  manage: 1,
};

/**
 * Item-level Vault Grant for one AI Employee. Company visibility never grants
 * AI access implicitly: without one of these rows the item is invisible to
 * that employee. `use` permits governed use without management; `manage` is
 * reserved for AI-native item maintenance tools.
 */
@Entity("employee_vault_grants")
@Index(["companyId"])
@Index(["employeeId"])
@Index(["vaultItemId", "employeeId"], { unique: true })
export class EmployeeVaultGrant {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  vaultItemId!: string;

  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar", default: "use" })
  accessLevel!: EmployeeVaultAccessLevel;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
