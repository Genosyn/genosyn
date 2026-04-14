import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from "typeorm";

@Entity("invitations")
export class Invitation {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  email!: string;

  @Column({ type: "varchar", unique: true })
  token!: string;

  @Column({ type: "datetime" })
  expiresAt!: Date;

  @Column({ type: "datetime", nullable: true })
  acceptedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
