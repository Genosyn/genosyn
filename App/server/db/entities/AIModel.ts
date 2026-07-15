import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

export type Provider = "anthropic" | "openai" | "custom";
export type AuthMode = "apikey" | "customEndpoint";

/**
 * An AIModel is one of the brains an AI Employee can run on. An employee can
 * register several (`employeeId` is indexed, not unique) and flip exactly one
 * to active at a time via `isActive` — the runner + chat seams talk to the
 * active one's API directly. Credentials are always encrypted in `configJson`:
 * there are no on-disk provider credentials any more.
 *
 * `provider` names the model API Genosyn calls in-process:
 *   - `anthropic` → the Anthropic Messages API (Claude), authMode `apikey`
 *   - `openai`    → the OpenAI Chat Completions API (GPT), authMode `apikey`
 *   - `custom`    → any OpenAI-compatible endpoint (Ollama, vLLM, llama.cpp,
 *                   LM Studio, a gateway), authMode `customEndpoint`
 *
 * `isActive` invariant: at most one row per employee is `true`. The model
 * service maintains it on every create / switch / delete; reads fall back to
 * the most-recently-created row when no row is flagged (covers rows that
 * predate this column, which migrate in as `false`).
 *
 * configJson shape:
 *   - apikey:         `{ apiKeyEncrypted, apiKeyPreview }`
 *   - customEndpoint: `{ baseURLEncrypted, baseURLPreview, modelId,
 *                        apiKeyEncrypted?, apiKeyPreview? }`
 * All `*Encrypted` fields are AES-256-GCM via `lib/secret.ts`.
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

  @Column({ type: "varchar", default: "apikey" })
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

  /**
   * The model's context window in tokens, as reported by the provider when the
   * credential was saved (see services/agent/contextWindow.ts).
   *
   * Null means "we don't know" — the provider doesn't report one, or the probe
   * couldn't reach it. Callers must treat null as unknown rather than assuming
   * a default: guessing high fails the run, guessing low truncates work that
   * would have fit.
   */
  @Column({ type: "integer", nullable: true })
  contextWindow!: number | null;

  @CreateDateColumn()
  createdAt!: Date;
}
