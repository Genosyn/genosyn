import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

export type Provider = "claude-code" | "codex" | "opencode" | "goose" | "openclaw";
export type AuthMode = "subscription" | "apikey";

/**
 * An AIModel is the brain of a single AI Employee. One-to-one with
 * AIEmployee: `employeeId` is unique. Credentials live on disk under the
 * employee's `.claude/` dir (subscription) or encrypted in `configJson`
 * (apikey). See ROADMAP.md §5 for rationale.
 */
@Entity("ai_models")
@Index(["employeeId"], { unique: true })
export class AIModel {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar" })
  provider!: Provider;

  @Column({ type: "varchar" })
  model!: string;

  @Column({ type: "varchar", default: "subscription" })
  authMode!: AuthMode;

  /** JSON blob. `apikey` mode stores { apiKeyEncrypted: "..." }. */
  @Column({ type: "text", default: "{}" })
  configJson!: string;

  @Column({ type: "datetime", nullable: true })
  connectedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
