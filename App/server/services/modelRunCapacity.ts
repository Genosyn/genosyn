import { createHash } from "node:crypto";
import net from "node:net";
import { Like, MoreThan } from "typeorm";
import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import type { AIModel } from "../db/entities/AIModel.js";
import { SchedulerLease } from "../db/entities/SchedulerLease.js";
import { isPublicIp } from "../lib/outboundUrl.js";
import { readCustomEndpoint } from "./customEndpoint.js";
import { withSchedulerLease } from "./schedulerLeases.js";

/**
 * How many Routine Runs may use one AI Model at once.
 *
 * Routines run concurrently, which is right for a hosted API that serves
 * thousands of requests in parallel. A local model server is one GPU: every
 * extra Run slows all the others, evicts their cached prompts, and the clock of
 * each Run keeps ticking while it waits for the model. Saturating it turned an
 * afternoon of Routines into a row of timeout Errors.
 *
 * So a model may declare how many Runs it serves at once. A Run beyond that
 * stays `queued`: its time budget starts only when it is claimed (see
 * `routineQueue.ts`), and it starts as soon as a slot frees. The limit counts
 * Runs per **endpoint**, not per `AIModel` row — every AI Employee holds its
 * own row, and three employees pointed at the same Ollama share one GPU.
 *
 * `AIModel.maxConcurrentRuns`:
 *   - `null` — the default: one Run at a time for a custom endpoint on this
 *     machine or a private network, no limit for anything else;
 *   - `0`    — no limit;
 *   - `n`    — at most `n` Runs at once.
 */

export const MAX_MODEL_CONCURRENT_RUNS = 64;
/** A local model server serves one agent loop at a time well. */
export const LOCAL_MODEL_DEFAULT_CONCURRENT_RUNS = 1;
const SLOT_LEASE_MS = 120_000;

export type ModelRunCapacity = {
  /** Identifies the serving endpoint; equal for rows that share one server. */
  key: string;
  /** Null when this model admits any number of Runs. */
  limit: number | null;
  /** Where the limit came from, for the UI's explanation. */
  source: "configured" | "local-default" | "unlimited";
};

/**
 * Hosts that reach this machine or a private network — where a local model
 * server lives. Decided from the URL alone (no DNS), so it is cheap and
 * deterministic: loopback and private literals, `localhost`, Docker's host
 * alias, single-label service names, and the private-use suffixes.
 */
export function isLocalModelHost(hostname: string): boolean {
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (!host) return false;
  if (net.isIP(host)) return !isPublicIp(host);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (!host.includes(".")) return true;
  return [".internal", ".local", ".lan", ".home.arpa", ".localdomain"].some((suffix) =>
    host.endsWith(suffix),
  );
}

function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/** The endpoint identity and effective concurrent-Run limit for one model row. */
export function modelRunCapacity(
  model: Pick<AIModel, "id" | "provider" | "authMode" | "configJson" | "maxConcurrentRuns">,
): ModelRunCapacity {
  const endpoint = model.provider === "custom" ? readCustomEndpoint(model as AIModel) : null;
  let key = `model:${model.id}`;
  let local = false;
  if (endpoint) {
    let origin = endpoint.baseURL.trim().replace(/\/+$/, "");
    try {
      const url = new URL(origin);
      local = isLocalModelHost(url.hostname);
      origin = `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
    } catch {
      // A malformed URL cannot start a Run anyway; keep the raw text as identity.
    }
    key = `endpoint:${hashKey(`${origin}\n${endpoint.modelId}`)}`;
  }
  const configured = model.maxConcurrentRuns;
  if (configured !== null && configured !== undefined) {
    return configured > 0
      ? { key, limit: Math.min(configured, MAX_MODEL_CONCURRENT_RUNS), source: "configured" }
      : { key, limit: null, source: "configured" };
  }
  return local
    ? { key, limit: LOCAL_MODEL_DEFAULT_CONCURRENT_RUNS, source: "local-default" }
    : { key, limit: null, source: "unlimited" };
}

/** In-process holders per endpoint; the whole truth on single-process SQLite. */
const localSlots = new Map<string, number>();

function slotLeasePrefix(key: string): string {
  return `model-runs:${key}:`;
}

/**
 * Run `fn` while holding one of the model's Run slots, or report that every
 * slot is taken. Never waits: a Run that finds no slot stays queued and the
 * dispatcher offers it again when a slot frees.
 *
 * SQLite installs are a single process, so an in-process count is exact.
 * Postgres installs may run several App processes; each slot is then a
 * renewable scheduler lease, the same primitive company AI capacity uses.
 * A lost renewal does not abort the Run — the limit protects throughput, not
 * a security boundary, so the worst case is one Run of overlap.
 */
export async function withModelRunSlot<T>(
  capacity: ModelRunCapacity | null,
  fn: () => Promise<T>,
): Promise<{ admitted: true; value: T } | { admitted: false }> {
  if (!capacity || capacity.limit === null) return { admitted: true, value: await fn() };
  const held = localSlots.get(capacity.key) ?? 0;
  if (held >= capacity.limit) return { admitted: false };
  if (config.db.driver !== "postgres") {
    localSlots.set(capacity.key, held + 1);
    try {
      return { admitted: true, value: await fn() };
    } finally {
      releaseLocalSlot(capacity.key);
    }
  }
  for (let slot = 0; slot < capacity.limit; slot += 1) {
    const result = await withSchedulerLease(
      `${slotLeasePrefix(capacity.key)}${slot}`,
      SLOT_LEASE_MS,
      async () => {
        localSlots.set(capacity.key, (localSlots.get(capacity.key) ?? 0) + 1);
        try {
          return { value: await fn() };
        } finally {
          releaseLocalSlot(capacity.key);
        }
      },
    );
    if (result !== null) return { admitted: true, value: result.value };
  }
  return { admitted: false };
}

function releaseLocalSlot(key: string): void {
  const next = (localSlots.get(key) ?? 1) - 1;
  if (next > 0) localSlots.set(key, next);
  else localSlots.delete(key);
}

/** How many Runs hold a slot on this endpoint right now, across processes. */
export async function modelRunSlotsInUse(capacity: ModelRunCapacity): Promise<number> {
  if (config.db.driver !== "postgres") return localSlots.get(capacity.key) ?? 0;
  return AppDataSource.getRepository(SchedulerLease).count({
    where: { name: Like(`${slotLeasePrefix(capacity.key)}%`), expiresAt: MoreThan(new Date()) },
  });
}

/** Test seam: forget in-process holders between isolated tests. */
export function resetModelRunSlotsForTests(): void {
  localSlots.clear();
}
