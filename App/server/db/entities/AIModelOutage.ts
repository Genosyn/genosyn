import { dateTimeColumnType } from "./columnTypes.js";
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";
import type { ModelUnavailableCause } from "../../services/agent/modelOutage.js";

/** How an outage ended: a check answered, real work succeeded, or its model went away. */
export type AIModelOutageRecovery = "check" | "traffic" | "removed";

/**
 * One stretch of time an AI Model was **unavailable** — its service could not
 * be reached, failed with a server error, said it was overloaded, or kept
 * every key rate-limited (`services/agent/modelOutage.ts`). While a row is
 * open (`endedAt` null) the company's work on that model waits instead of
 * failing: the queue starts none of its Runs, a Run that hits the outage
 * pauses as itself, a chat message waits to be answered, and a cheap check
 * asks the model again on a backoff (`services/modelAvailability.ts`). The row
 * closes when a check or real work succeeds.
 *
 * Persisted so an outage survives a restart — the queue does not start every
 * waiting Run against a model that is still down just because the process
 * forgot — so every replica on Postgres sees the same state, so "unavailable
 * since" is true, and so owners and admins are told once per outage and once
 * when it ends, never once per Run.
 *
 * `key` is the model's availability key: its company plus the endpoint
 * identity `modelRunCapacity` uses (`model:<id>` for a hosted model or a
 * ChatGPT sign-in, `endpoint:<hash>` for a custom endpoint), so every AI
 * Employee on one model — and every model row pointed at one server — shares
 * one outage. At most one row per key is open at a time (the partial unique
 * index). No secret is ever stored: `lastError` is built from a status, an
 * error type token and a network error code, never from a response body.
 */
@Entity("ai_model_outages")
@Index(["key"], { unique: true, where: '"endedAt" IS NULL' })
@Index(["companyId", "startedAt"])
export class AIModelOutage {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  /** `<companyId>:<model:… | endpoint:…>`; see the class comment. */
  @Column({ type: "varchar" })
  key!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  /** The AI Model whose credentials the checks use — the one that failed first. */
  @Column({ type: "varchar" })
  modelId!: string;

  /** When the failures that made it unavailable began. */
  @Column({ type: dateTimeColumnType })
  startedAt!: Date;

  /** When it answered again; null while the outage lasts. */
  @Column({ type: dateTimeColumnType, nullable: true })
  endedAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  recoveredBy!: AIModelOutageRecovery | null;

  @Column({ type: "varchar" })
  cause!: ModelUnavailableCause;

  /** The latest failure, one line, with no secret in it. */
  @Column({ type: "varchar", length: 300 })
  lastError!: string;

  /** The latest failure's HTTP status, when it had one. */
  @Column({ type: "integer", nullable: true })
  lastStatus!: number | null;

  /** Checks that found it still unavailable; each one doubles the wait for the next. */
  @Column({ type: "integer", default: 0 })
  checks!: number;

  @Column({ type: dateTimeColumnType, nullable: true })
  lastCheckedAt!: Date | null;

  /** When the next check is due. */
  @Column({ type: dateTimeColumnType })
  nextCheckAt!: Date;

  /** When owners and admins were told, once a check confirmed it; null until then. */
  @Column({ type: dateTimeColumnType, nullable: true })
  notifiedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
