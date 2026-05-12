import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

export type Provider = "claude-code" | "codex" | "opencode" | "goose" | "openclaw";
export type AuthMode = "subscription" | "apikey" | "customEndpoint";

/**
 * An AIModel is the brain of a single AI Employee. One-to-one with
 * AIEmployee: `employeeId` is unique. Credentials live on disk under the
 * employee's `.claude/` dir (subscription) or encrypted in `configJson`
 * (apikey / customEndpoint). See ROADMAP.md §5 for rationale.
 *
 * `customEndpoint` is the "point this employee at a local OpenAI-compatible
 * server" path. Valid on the two router providers — opencode and goose —
 * which can both talk arbitrary HTTP. The harness picker in the UI just
 * sets `provider` to whichever the user prefers. configJson carries
 * `{ baseURLEncrypted, baseURLPreview, apiKeyEncrypted?, apiKeyPreview?,
 *    modelId }`. Before each spawn the runner materializes the right
 * provider config file (opencode.json + auth.json, or goose's
 * config.yaml) and injects matching env vars — the user never drops into
 * a terminal.
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
