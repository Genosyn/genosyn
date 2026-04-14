import { Entity, PrimaryGeneratedColumn, Column, Index } from "typeorm";

export type Role = "owner" | "admin" | "member";

@Entity("memberships")
@Index(["companyId", "userId"], { unique: true })
export class Membership {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  userId!: string;

  @Column({ type: "varchar" })
  role!: Role;
}
