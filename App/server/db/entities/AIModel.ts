import { dateTimeColumnType } from "./columnTypes.js";
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";
import type { ModelEffort } from "../../../shared/modelEffort.js";

export type Provider = "anthropic" | "openai" | "custom";
export type AuthMode = "apikey" | "subscription" | "customEndpoint";
/** Where `AIModel.contextWindow` came from. Null alongside a null window. */
export type ContextWindowSource = "probed" | "manual";

/**
 * An AIModel is one of the company's AI Models: a brain any number of its AI
 * Employees can run on. It belongs to the company (`companyId`), and holds
 * one set of credentials — for an API-key model, one pool of keys its
 * sessions are spread across (their health is `AIModelKeyHealth`) — context
 * window and concurrent-Run setting for every employee using it.
 *
 * Employees use a model through `EmployeeModel` rows: one per employee the
 * model is attached to, exactly one of each employee's rows active — the
 * brain its Routines and non-interactive work use, while employee Chat may
 * pick another attached model per turn (`services/models.ts`). Detaching a
 * model from an employee never deletes it; removing it from the company is
 * refused while anyone still uses it.
 *
 * API-key and custom models run through the pinned OpenCode runtime. OpenAI
 * subscription models run through the pinned official Codex app-server with
 * the same Genosyn tool registry, one turn at a time across every employee
 * on the model (`withSubscriptionModelLock` is keyed by this row's id).
 * Credentials are always encrypted in `configJson`, with the company's scope;
 * a managed ChatGPT session is materialized only into a private temporary
 * `CODEX_HOME` for login or a turn.
 *
 * `provider` names the model backend:
 *   - `anthropic` → the Anthropic Messages API (Claude), authMode `apikey`
 *   - `openai`    → the OpenAI API (`apikey`) or official Codex app-server
 *                   (`subscription`, trusted self-hosted installs only)
 *   - `custom`    → any OpenAI-compatible endpoint (Ollama, vLLM, llama.cpp,
 *                   LM Studio, a gateway), authMode `customEndpoint`
 *
 * configJson shape:
 *   - apikey:         `{ apiKeyEncrypted, apiKeyPreview, apiKeyId?, apiKeyAddedAt?,
 *                        backupKeys?: [{ id, apiKeyEncrypted, apiKeyPreview,
 *                                        addedAt? }] }` — any number of equal
 *                     keys, the first at the top level and the rest in
 *                     `backupKeys` (a name kept from when they were backups);
 *                     each session opens on the next key in turn
 *                     (`services/modelApiKeys.ts`; their health is
 *                     `AIModelKeyHealth`)
 *   - subscription:   `{ codexAuthEncrypted, subscriptionCredentialKind }`
 *                     or `{ codexAccessTokenEncrypted,
 *                           subscriptionCredentialKind }`
 *   - customEndpoint: `{ baseURLEncrypted, baseURLPreview, modelId,
 *                        apiKeyEncrypted?, apiKeyPreview? }`
 * All `*Encrypted` fields are AES-256-GCM via `lib/secret.ts`.
 */
@Entity("ai_models")
@Index(["companyId"])
export class AIModel {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  /** The company that owns the model and every credential on it. */
  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  provider!: Provider;

  @Column({ type: "varchar" })
  model!: string;

  @Column({ type: "varchar", default: "apikey" })
  authMode!: AuthMode;

  /** JSON blob of encrypted credentials; see the shapes above. */
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
   * OpenCode receives a known window for its context compaction. When it is
   * unknown, the runtime uses its own fallback; the UI still reports unknown
   * rather than presenting that fallback as a provider-reported limit.
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

  /**
   * How many Routine Runs may use this model's endpoint at once, counted
   * across every AI Employee attached to it; Runs beyond it wait in the queue
   * without spending their time budget. Null takes the default — one at a
   * time for a custom endpoint on this machine or a private network and for a
   * ChatGPT sign-in, no limit otherwise — and 0 means no limit. See
   * `services/modelRunCapacity.ts`.
   */
  @Column({ type: "integer", nullable: true })
  maxConcurrentRuns!: number | null;

  /**
   * The thinking level chat on this model starts at when a conversation is
   * left on Default — one of the levels the model offers
   * (`services/modelEffort.ts`). Null leaves the model at its own default.
   * Set by owners and admins at Settings → AI Models; it applies to chat,
   * Help and Repository work sessions, never to Routines.
   */
  @Column({ type: "varchar", nullable: true })
  defaultEffort!: ModelEffort | null;

  /**
   * The highest thinking level a Member may choose on this model, for cost.
   * Null is no limit. A conversation set higher runs at this level, and says
   * so; Default on a model whose own default is higher is held to it too.
   */
  @Column({ type: "varchar", nullable: true })
  effortCeiling!: ModelEffort | null;

  /**
   * A custom endpoint whose owners turned on thinking levels: chat may then
   * send `reasoning_effort` (Off, Low, Medium, High), which servers such as
   * vLLM and Ollama honour for some models. Off by default, because a
   * compatible API says nothing about whether the server reads the field.
   * Ignored on every other kind of model.
   */
  @Column({ type: "boolean", default: false })
  customThinkingLevels!: boolean;

  @CreateDateColumn()
  createdAt!: Date;
}
