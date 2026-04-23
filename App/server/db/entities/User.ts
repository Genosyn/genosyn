import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

@Entity("users")
export class User {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", unique: true })
  email!: string;

  @Column({ type: "varchar" })
  passwordHash!: string;

  @Column({ type: "varchar" })
  name!: string;

  /**
   * Short URL-safe identifier used for `@handle` mentions in workspace
   * chat and (eventually) anywhere we need to link to this person.
   * Globally unique so a mention can resolve without needing a company
   * scope. Nullable until the user picks one in Profile Settings.
   */
  @Index({ unique: true, where: "handle IS NOT NULL" })
  @Column({ type: "varchar", nullable: true })
  handle!: string | null;

  @Column({ type: "varchar", nullable: true })
  resetToken!: string | null;

  @Column({ type: "datetime", nullable: true })
  resetExpiresAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
