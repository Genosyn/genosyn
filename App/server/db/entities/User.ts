import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from "typeorm";

@Entity("users")
export class User {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ unique: true })
  email!: string;

  @Column()
  passwordHash!: string;

  @Column()
  name!: string;

  @Column({ type: "varchar", nullable: true })
  resetToken!: string | null;

  @Column({ type: "datetime", nullable: true })
  resetExpiresAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
