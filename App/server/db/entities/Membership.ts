import { Entity, PrimaryGeneratedColumn, Column, Index } from "typeorm";

export type Role = "owner" | "admin" | "member";

@Entity("memberships")
@Index(["companyId", "userId"], { unique: true })
export class Membership {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column()
  companyId!: string;

  @Column()
  userId!: string;

  @Column()
  role!: Role;
}
