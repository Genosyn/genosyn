import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

export type MarketingAccessLevel = "read" | "write" | "operate";
export const MARKETING_ACCESS_LEVELS: MarketingAccessLevel[] = ["read", "write", "operate"];
export const MARKETING_ACCESS_RANK: Record<MarketingAccessLevel, number> = {
  read: 0,
  write: 1,
  operate: 2,
};

/**
 * Company-wide access to the Marketing workspace. External ad-account access
 * remains a separate Connection Grant, so this row can never mint platform
 * credentials or bypass Connection spend controls.
 */
@Entity("employee_marketing_grants")
@Index(["companyId"])
@Index(["employeeId"], { unique: true })
export class EmployeeMarketingGrant {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar", default: "read" })
  accessLevel!: MarketingAccessLevel;

  @CreateDateColumn()
  createdAt!: Date;
}
