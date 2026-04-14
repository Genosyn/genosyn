import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from "typeorm";

@Entity("invitations")
export class Invitation {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column()
  companyId!: string;

  @Column()
  email!: string;

  @Column({ unique: true })
  token!: string;

  @Column("datetime")
  expiresAt!: Date;

  @Column({ type: "datetime", nullable: true })
  acceptedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
