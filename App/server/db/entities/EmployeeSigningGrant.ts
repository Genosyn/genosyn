import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

export type SigningAccessLevel = "read" | "draft" | "send";

export const SIGNING_ACCESS_LEVELS: SigningAccessLevel[] = ["read", "draft", "send"];

export const SIGNING_ACCESS_RANK: Record<SigningAccessLevel, number> = {
  read: 0,
  draft: 1,
  send: 2,
};

/**
 * Company-wide signing access for one AI Employee. Recipient identity and the
 * act of signing always remain external-human actions; this grant only lets an
 * employee inspect envelopes, prepare drafts, or send prepared envelopes.
 */
@Entity("employee_signing_grants")
@Index(["companyId"])
@Index(["employeeId"], { unique: true })
export class EmployeeSigningGrant {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar", default: "read" })
  accessLevel!: SigningAccessLevel;

  @CreateDateColumn()
  createdAt!: Date;
}
