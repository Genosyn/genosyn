import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from "typeorm";

@Entity("companies")
export class Company {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar", unique: true })
  slug!: string;

  @Column({ type: "varchar" })
  ownerId!: string;

  /** When enabled, browser members must keep at least one 2FA method enrolled. */
  @Column({ type: "boolean", default: false })
  requireTwoFactor!: boolean;

  @CreateDateColumn()
  createdAt!: Date;
}
