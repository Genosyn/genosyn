import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * Per-company vault for secrets that flow into employee spawns as env vars.
 * The plaintext value is never returned by the API — only the masked preview.
 * Encrypted at rest with the same sessionSecret-derived key as model API keys.
 */
@Entity("secrets")
@Index(["companyId", "name"], { unique: true })
export class Secret {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar" })
  encryptedValue!: string;

  @Column({ type: "varchar", default: "" })
  description!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
