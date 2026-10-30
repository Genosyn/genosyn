import { dateTimeColumnType } from "./columnTypes.js";
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

/**
 * Why a provider refused one of an AI Model's API keys — the failures that
 * move a request on to the next key (see `services/agent/apiKeyRing.ts`):
 *
 *   - `auth`       → the key is invalid, revoked or disabled (401)
 *   - `permission` → the key's organization may not do this (403)
 *   - `billing`    → the account is out of credit or has a billing problem
 *   - `quota`      → the account's usage quota is spent (OpenAI's 429)
 *   - `rate_limit` → the key is being rate-limited for now (429)
 */
export type ApiKeyFailureKind = "auth" | "permission" | "billing" | "quota" | "rate_limit";

/**
 * How one of an AI Model's API keys has been doing: when it last answered,
 * when and why a provider last refused it, until when it rests after that
 * refusal, and how many sessions it carried in the last day. One row per key,
 * written by the per-turn model proxy as sessions open and requests go out,
 * read by the model's settings so an owner can see the sessions spread across
 * the keys and which key is dead.
 *
 * Deliberately not in `AIModel.configJson`, where the keys themselves are:
 * credential edits save `configJson` only if nobody changed it meanwhile, and
 * a busy Run touching it on every request would break every key edit — or, by
 * writing back a stale copy, undo one. These rows hold no secret: the key is
 * named by the stable `keyId` stored beside its ciphertext, and the error is
 * the provider's own words with every key redacted.
 *
 * Rows go with their AI Model and with their key; there are no foreign keys
 * in this codebase, so the services delete them explicitly.
 */
@Entity("ai_model_key_health")
@Index(["modelId", "keyId"], { unique: true })
export class AIModelKeyHealth {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  modelId!: string;

  /** The key's id in `configJson` — `primary` for a key saved before keys had ids. */
  @Column({ type: "varchar" })
  keyId!: string;

  /** When a request on this key last succeeded. */
  @Column({ type: dateTimeColumnType, nullable: true })
  lastUsedAt!: Date | null;

  /** When a provider last refused this key; null if it never has. */
  @Column({ type: dateTimeColumnType, nullable: true })
  lastErrorAt!: Date | null;

  /** The HTTP status of that refusal. */
  @Column({ type: "integer", nullable: true })
  lastErrorStatus!: number | null;

  @Column({ type: "varchar", nullable: true })
  lastErrorKind!: ApiKeyFailureKind | null;

  /** What the provider said, one line, with every key redacted. */
  @Column({ type: "varchar", length: 300, nullable: true })
  lastErrorMessage!: string | null;

  /**
   * Until when requests try the AI Model's other keys first, after this one
   * was refused. Cleared by the next request that succeeds on it.
   */
  @Column({ type: dateTimeColumnType, nullable: true })
  coolDownUntil!: Date | null;

  /**
   * The sessions this key carried — opened on it in turn, or moved to it when
   * another key was refused — counted by the hour for the last 24 hours, as
   * JSON `[[epochHour, sessions], …]` (`services/modelKeyHealth.ts`). Null
   * until the key's first session.
   */
  @Column({ type: "text", nullable: true })
  sessionsByHour!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
