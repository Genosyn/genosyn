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
 * An AIModel is one of the brains an AI Employee can run on. An employee can
 * register several (`employeeId` is indexed, not unique) and flip exactly one
 * to active at a time via `isActive` — the runner + chat seams always spawn
 * the active one. Credentials live on disk under the employee's per-provider
 * dir (subscription) or encrypted in `configJson` (apikey / customEndpoint).
 * See ROADMAP.md §5 for rationale.
 *
 * `isActive` invariant: at most one row per employee is `true`. The model
 * service maintains it on every create / switch / delete; reads fall back to
 * the most-recently-created row when no row is flagged (covers rows that
 * predate this column, which migrate in as `false`).
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
@Index(["employeeId"])
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

  /**
   * The active brain for this employee. At most one row per employee is true.
   * The newest-added model is made active by default; the operator can switch
   * any time.
   */
  @Column({ type: "boolean", default: false })
  isActive!: boolean;

  /** JSON blob. `apikey` mode stores { apiKeyEncrypted: "..." }. */
  @Column({ type: "text", default: "{}" })
  configJson!: string;

  @Column({ type: "datetime", nullable: true })
  connectedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
