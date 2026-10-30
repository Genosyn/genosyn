import type { AIModel } from "../../db/entities/AIModel.js";
import type { ApiKeyFailureKind } from "../../db/entities/AIModelKeyHealth.js";
import { decryptApiKeys, type ApiKeySecret } from "../modelApiKeys.js";
import {
  keyRestingUntil,
  loadKeyRests,
  recordKeyRefusal,
  recordKeySession,
  recordKeySuccess,
  restKey,
  wakeKey,
} from "../modelKeyHealth.js";
import { handOutKey, turnOrder } from "../modelKeyPool.js";

/**
 * An AI Model's API keys at run time: a pool that sessions are spread across.
 *
 * An Anthropic or OpenAI AI Model holds any number of API keys, all equals.
 * Each **session** — one OpenCode session against the per-turn model proxy
 * (`opencodeProxy.ts`): a chat reply, a Routine Run's work or a Check fix, a
 * Repository work-session turn, a delegated copy, a restricted turn — opens on
 * the key whose turn it is (`modelKeyPool.ts`: round-robin over the keys that
 * aren't resting, from a random starting place) and sends every request on
 * that key until it ends. Staying on one key keeps a provider's prompt cache
 * and rate-limit accounting coherent for the session; the next session takes
 * the next key. A ring built for anything else — a connection test, a
 * context-window probe — takes no turn: it starts on the first key that isn't
 * resting, in the order they are stored.
 *
 * When the provider refuses the key a request went out on, for a reason that
 * belongs to the key, the proxy sends the very same request on the next key
 * in turn — before a single byte of the reply has reached OpenCode, so the AI
 * Employee never sees it — and the rest of the session stays on the key that
 * answered. What moves a request to another key ({@link classifyKeyRefusal}):
 *   - 401: the key is invalid, revoked or disabled;
 *   - 403: the key's organization or workspace may not do this;
 *   - 402, or a 400 that says so: out of credit, or a billing problem;
 *   - 429: rate-limited, or (OpenAI) out of quota.
 * Every other answer is about the request or the service, and another key
 * would get the same one: a bad request or an over-long prompt (400, 413), an
 * unknown model (404), the provider failing or overloaded (5xx, 529), or no
 * answer at all. Those go back to OpenCode at once, which retries the
 * transient ones itself. Keep the two apart: a refused key is this module's
 * business, a failing service is not.
 *
 * A refused key **rests** — 5 minutes, or for a rate limit as long as the
 * provider asked (a minute when it didn't say). While it rests, new sessions
 * skip it and a session that was on it moves on, so a dead key costs one
 * refused request per rest rather than one per request. A resting key is still
 * tried last, so a request never fails without trying every key; when every
 * key rests, a session opens on the one whose rest ends soonest. When every
 * key is refused, the proxy answers with a real error from the provider: the
 * last one, unless an earlier key was only rate-limited — then that rate
 * limit, because the request can still succeed once the limit resets and
 * OpenCode waits and retries a 429 where it gives up on a 401.
 */

/** How long a key the provider refused outright rests: invalid, forbidden, out of credit. */
export const REFUSED_KEY_REST_MS = 5 * 60_000;
/** How long a rate-limited key rests when the provider did not say. */
export const RATE_LIMIT_REST_MS = 60_000;
/** The bounds on a rate limit's rest, however long the provider asked for. */
export const MIN_REST_MS = 1_000;
export const MAX_RATE_LIMIT_REST_MS = 10 * 60_000;

/** A provider refusing the key a request was sent with. */
export type KeyRefusal = {
  kind: ApiKeyFailureKind;
  status: number;
  /** The provider's own words, when it gave any. Not yet redacted. */
  message: string | null;
  /** How long the provider asked the caller to wait, for a rate limit. */
  retryAfterMs: number | null;
};

type ErrorDetail = { type: string | null; code: string | null; message: string | null };

function field(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** The error object both providers wrap a refusal in. */
function errorDetail(body: string): ErrorDetail {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown> | null;
    const error = parsed?.error;
    if (error && typeof error === "object") {
      const record = error as Record<string, unknown>;
      return { type: field(record.type), code: field(record.code), message: field(record.message) };
    }
    return { type: null, code: null, message: field(error) ?? field(parsed?.message) };
  } catch {
    return { type: null, code: null, message: field(body) };
  }
}

/** `retry-after-ms`, or `retry-after` in seconds or as an HTTP date. */
export function retryAfterMs(headers: Headers | null | undefined, now = Date.now()): number | null {
  if (!headers) return null;
  const ms = headers.get("retry-after-ms");
  if (ms !== null && ms.trim() !== "" && Number.isFinite(Number(ms)) && Number(ms) >= 0) {
    return Number(ms);
  }
  const value = headers.get("retry-after")?.trim();
  if (!value) return null;
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/**
 * Whether the provider refused the key itself — and so another key may
 * succeed — or answered about the request or the service, which every key
 * would get alike. Null means "not about the key": send the answer on.
 */
export function classifyKeyRefusal(args: {
  status: number;
  body: string;
  headers?: Headers | null;
  now?: number;
}): KeyRefusal | null {
  const { status } = args;
  const detail = errorDetail(args.body);
  const code = `${detail.type ?? ""} ${detail.code ?? ""}`.toLowerCase();
  const message = (detail.message ?? "").toLowerCase();
  let kind: ApiKeyFailureKind | null = null;
  if (status === 401) kind = "auth";
  else if (status === 402 || detail.type === "billing_error") kind = "billing";
  else if (status === 403) kind = "permission";
  else if (status === 429) {
    // A 429 is usually a rate limit, but OpenAI also uses it for an account
    // with no quota or billing left — not something a short rest fixes.
    if (code.includes("insufficient_quota") || message.includes("exceeded your current quota"))
      kind = "quota";
    else if (code.includes("billing")) kind = "billing";
    else kind = "rate_limit";
  } else if (
    status === 400 &&
    // Anthropic has answered an empty balance as a 400: "Your credit balance
    // is too low to access the Anthropic API."
    (message.includes("credit balance") || code.includes("billing"))
  )
    kind = "billing";
  if (!kind) return null;
  return {
    kind,
    status,
    message: detail.message,
    retryAfterMs: kind === "rate_limit" ? retryAfterMs(args.headers, args.now) : null,
  };
}

/** How long a refused key rests before requests start on it again. */
export function keyRestMs(refusal: Pick<KeyRefusal, "kind" | "retryAfterMs">): number {
  if (refusal.kind !== "rate_limit") return REFUSED_KEY_REST_MS;
  const asked = refusal.retryAfterMs ?? RATE_LIMIT_REST_MS;
  return Math.min(MAX_RATE_LIMIT_REST_MS, Math.max(MIN_REST_MS, asked));
}

/**
 * The order to try keys in: every key that isn't resting, in the order given,
 * then the resting ones — the soonest awake first — as a last resort.
 */
export function attemptOrder<K extends { id: string }>(
  keys: readonly K[],
  restingUntil: (keyId: string) => number,
  now = Date.now(),
): K[] {
  const until = new Map(keys.map((key) => [key.id, restingUntil(key.id)]));
  const awake = keys.filter((key) => (until.get(key.id) ?? 0) <= now);
  const resting = keys
    .map((key, index) => ({ key, index }))
    .filter(({ key }) => (until.get(key.id) ?? 0) > now)
    .sort((a, b) => (until.get(a.key.id) ?? 0) - (until.get(b.key.id) ?? 0) || a.index - b.index)
    .map(({ key }) => key);
  return [...awake, ...resting];
}

/**
 * The refusal to answer with when every key was refused: the last, unless an
 * earlier key was only rate-limited — that request can still succeed.
 */
export function surfacedRefusal<T extends { refusal: Pick<KeyRefusal, "kind"> }>(
  attempts: readonly T[],
): T {
  if (attempts.length === 0) throw new Error("No refusal to report.");
  for (let index = attempts.length - 1; index >= 0; index--) {
    if (attempts[index].refusal.kind === "rate_limit") return attempts[index];
  }
  return attempts[attempts.length - 1];
}

/** What a refusal kind reads as, in a Run log or the settings page. */
export function refusalWords(kind: ApiKeyFailureKind): string {
  switch (kind) {
    case "auth":
      return "invalid or revoked";
    case "permission":
      return "not allowed to do this";
    case "billing":
      return "out of credit or a billing problem";
    case "quota":
      return "out of quota";
    case "rate_limit":
      return "rate-limited";
  }
}

function oneLine(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** A request moving from a refused key to the next one, by preview only. */
export type ApiKeyFailover = {
  from: string;
  to: string;
  status: number;
  kind: ApiKeyFailureKind;
};

/** The key a session is on, by preview only. */
export type ApiKeySessionKey = { id: string; preview: string };

/**
 * One AI Model's API keys for one session: the key the session is on, the
 * order to try the keys in, and what happened when they were tried. The
 * plaintext keys live in private fields, so the ring serializes and inspects
 * as nothing secret.
 *
 * With `session: true` the ring is a session in the model's pool: it opens on
 * the key whose turn it is, handing that key out (`modelKeyPool.ts`) and
 * counting a session on it, and when it moves to another key that key is
 * handed out and counted too. Without it — a connection test, a probe — the
 * ring takes no turn and counts nothing: it opens on the first key that isn't
 * resting, in the stored order. Either way the ring stays on its key while the
 * key works, and moves to the key that answers when the provider refuses it.
 */
export class ApiKeyRing {
  readonly modelId: string;
  readonly #keys: readonly ApiKeySecret[];
  readonly #secrets: readonly string[];
  readonly #now: () => number;
  readonly #session: boolean;
  #current: ApiKeySecret;

  constructor(
    modelId: string,
    keys: readonly ApiKeySecret[],
    options: { now?: () => number; session?: boolean } = {},
  ) {
    if (keys.length === 0) throw new Error("No API key is set for this AI Model.");
    this.modelId = modelId;
    this.#keys = [...keys];
    // Longest first, so a key that contains another is redacted whole.
    this.#secrets = [...new Set(keys.map((key) => key.apiKey))]
      .filter((secret) => secret.length > 0)
      .sort((a, b) => b.length - a.length);
    this.#now = options.now ?? Date.now;
    this.#session = options.session === true;
    // Chosen and handed out in one synchronous step, so sessions that start
    // at the same moment never take the same turn.
    this.#current = this.#order(this.#now())[0];
    if (this.#session) this.#handOut(this.#current);
  }

  /** How many keys the ring holds. */
  get size(): number {
    return this.#keys.length;
  }

  /** Whether this ring is a session in the AI Model's pool, taking turns. */
  get isSession(): boolean {
    return this.#session;
  }

  /** The key the session is on now, by preview only. */
  get key(): ApiKeySessionKey {
    return { id: this.#current.id, preview: this.#current.preview };
  }

  /**
   * Every key that isn't resting — in turn order for a session, the stored
   * order otherwise — then the resting ones, the soonest awake first.
   */
  #order(now: number): ApiKeySecret[] {
    const preference = this.#session ? turnOrder(this.modelId, this.#keys) : this.#keys;
    return attemptOrder(preference, (keyId) => keyRestingUntil(this.modelId, keyId, now), now);
  }

  #handOut(key: ApiKeySecret): void {
    handOutKey(this.modelId, key.id);
    // Counted in the background; a session never waits for it.
    void recordKeySession(this.modelId, key.id, new Date(this.#now()));
  }

  /**
   * The keys for the next request, in the order to try them: the session's
   * own key while it isn't resting, then the others — the next in turn first.
   * Once the session's key rests (refused here, or on another session) the
   * request starts on the next key in turn instead.
   */
  attemptOrder(): ApiKeySecret[] {
    const now = this.#now();
    const order = this.#order(now);
    const current = this.#current;
    if (keyRestingUntil(this.modelId, current.id, now) > now) return order;
    return [current, ...order.filter((key) => key.id !== current.id)];
  }

  /** The session goes on with this key, if it isn't on it already. */
  #settle(key: Pick<ApiKeySecret, "id">): void {
    if (key.id === this.#current.id) return;
    const next = this.#keys.find((candidate) => candidate.id === key.id);
    if (!next) return;
    this.#current = next;
    if (this.#session) this.#handOut(next);
  }

  /**
   * A request on this key just succeeded: it rests no longer, and the session
   * stays on it. Resolves once the health is saved; a request never waits for
   * that.
   */
  succeeded(key: Pick<ApiKeySecret, "id">): Promise<void> {
    wakeKey(this.modelId, key.id);
    this.#settle(key);
    return recordKeySuccess(this.modelId, key.id, new Date(this.#now()));
  }

  /**
   * The provider answered a request on this key with an error about the
   * request or the service, not the key: the key is fine, so the session
   * stays on it.
   */
  answered(key: Pick<ApiKeySecret, "id">): void {
    this.#settle(key);
  }

  /**
   * The provider just refused this key: rest it, and remember why. The rest
   * applies at once; the returned promise only covers saving the health.
   */
  refused(key: Pick<ApiKeySecret, "id">, refusal: KeyRefusal): Promise<void> {
    const now = this.#now();
    const restUntil = now + keyRestMs(refusal);
    restKey(this.modelId, key.id, restUntil, now);
    const message = refusal.message
      ? oneLine(this.redact(refusal.message), 300)
      : `The provider answered HTTP ${refusal.status}: ${refusalWords(refusal.kind)}.`;
    return recordKeyRefusal(
      this.modelId,
      key.id,
      { kind: refusal.kind, status: refusal.status, message, restUntil },
      new Date(now),
    );
  }

  /** `text` with every one of this AI Model's keys replaced. */
  redact(text: string): string {
    let safe = text;
    for (const secret of this.#secrets) safe = safe.split(secret).join("[redacted]");
    return safe;
  }
}

/**
 * The ring for an API-key AI Model, knowing which keys rest — with `session`,
 * a new session that takes its turn in the model's pool. Null when no stored
 * key decrypts; the caller says what that means.
 */
export async function apiKeyRingFor(
  model: Pick<AIModel, "id" | "configJson">,
  options: { session?: boolean } = {},
): Promise<ApiKeyRing | null> {
  const keys = decryptApiKeys(model.configJson);
  if (keys.length === 0) return null;
  await loadKeyRests(model.id);
  // Nothing is awaited from here on: the session takes its turn at once.
  return new ApiKeyRing(model.id, keys, { session: options.session });
}

/**
 * The AI Model's keys with none resting first, in the order they are stored,
 * taking no turn — for checks that make one plain request with a key rather
 * than a session's work, such as asking for the model's context window.
 */
export async function orderedApiKeys(
  model: Pick<AIModel, "id" | "configJson">,
): Promise<ApiKeySecret[]> {
  return (await apiKeyRingFor(model))?.attemptOrder() ?? [];
}

/**
 * The key a new session opens on, taking its turn in the AI Model's pool — for
 * work that makes one plain request with a key rather than a turn, such as
 * transcribing a meeting. Null when no stored key decrypts.
 */
export async function sessionApiKey(
  model: Pick<AIModel, "id" | "configJson">,
): Promise<ApiKeySecret | null> {
  return (await apiKeyRingFor(model, { session: true }))?.attemptOrder()[0] ?? null;
}
