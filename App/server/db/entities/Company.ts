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

  /**
   * The durable company purpose used to ground AI Employee onboarding and
   * future company-wide recommendations. Empty keeps existing companies fully
   * valid until a Member adds the profile from onboarding or Settings.
   */
  @Column({ type: "text", default: "" })
  mission!: string;

  /** The future state the company is working toward. See {@link mission}. */
  @Column({ type: "text", default: "" })
  vision!: string;

  /** When enabled, browser members must keep at least one 2FA method enrolled. */
  @Column({ type: "boolean", default: false })
  requireTwoFactor!: boolean;

  @CreateDateColumn()
  createdAt!: Date;
}
