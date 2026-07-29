import { dateTimeColumnType } from "./columnTypes.js";
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

export type Provider = "anthropic" | "openai" | "custom";
export type AuthMode = "apikey" | "subscription" | "customEndpoint";
/** Where `AIModel.contextWindow` came from. Null alongside a null window. */
export type ContextWindowSource = "probed" | "manual";

/**
 * An AIModel is one of the brains an AI Employee can run on. An employee can
 * register several (`employeeId` is indexed, not unique) and flip exactly one
 * to active at a time via `isActive`. API-key and custom models run through the
 * in-process provider loop. OpenAI subscription models run through the pinned
 * official Codex app-server with the same Genosyn tool registry. Credentials
 * are always encrypted in `configJson`; a managed ChatGPT session is
 * materialized only into a private temporary `CODEX_HOME` for login/a turn.
 *
 * `provider` names the model backend:
 *   - `anthropic` → the Anthropic Messages API (Claude), authMode `apikey`
 *   - `openai`    → the OpenAI API (`apikey`) or official Codex app-server
 *                   (`subscription`, trusted self-hosted installs only)
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
 *   - subscription:   `{ codexAuthEncrypted, subscriptionCredentialKind }`
 *                     or `{ codexAccessTokenEncrypted,
 *                           subscriptionCredentialKind }`
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

  @Column({ type: dateTimeColumnType, nullable: true })
  connectedAt!: Date | null;

  /**
   * The model's context window in tokens — either as reported by the provider
   * when the credential was saved, or as set by hand by an operator (see
   * services/agent/contextWindow.ts and `contextWindowSource` below).
   *
   * Null means "we don't know" — the provider doesn't report one, or the probe
   * couldn't reach it. Callers must treat null as unknown rather than assuming
   * a default: guessing high fails the run, guessing low truncates work that
   * would have fit.
   *
   * The agent loop budgets against this to decide when to drop older tool
   * results (services/agent/contextBudget.ts). With it null there is no budget,
   * and an over-long prompt is only caught after the provider rejects a turn.
   */
  @Column({ type: "integer", nullable: true })
  contextWindow!: number | null;

  /**
   * Whether `contextWindow` was probed from the provider or typed in by a human.
   *
   * This exists so the two can't fight: plenty of servers report no window at
   * all (plain Ollama, OpenAI's own API), so an operator who has typed the right
   * number must not have it erased by the next best-effort probe that comes back
   * empty. `"manual"` wins until the operator clears it.
   *
   * Null exactly when `contextWindow` is null.
   */
  @Column({ type: "varchar", nullable: true })
  contextWindowSource!: ContextWindowSource | null;

  @CreateDateColumn()
  createdAt!: Date;
}
