import crypto from "node:crypto";
import { RateLimitError } from "./errors.js";

export type ThrottleRule = {
  /** Attempts admitted per window. */
  limit: number;
  windowMs: number;
  /** How long a bucket stays shut once it exceeds the limit. */
  blockMs: number;
};

const MINUTES = 60_000;

/**
 * Budgets per client address unless noted. Starting, viewing, approving and
 * returning from a sign-in are a person's clicks; renewal is budgeted per
 * refresh token, so one installation can renew many Connections without
 * exhausting its address, and its rejections per address, to slow guessing.
 */
export const RULES = {
  start: { limit: 30, windowMs: 15 * MINUTES, blockMs: 15 * MINUTES },
  page: { limit: 60, windowMs: 15 * MINUTES, blockMs: 15 * MINUTES },
  authorize: { limit: 30, windowMs: 15 * MINUTES, blockMs: 15 * MINUTES },
  callback: { limit: 30, windowMs: 15 * MINUTES, blockMs: 15 * MINUTES },
  refreshToken: { limit: 20, windowMs: 15 * MINUTES, blockMs: 15 * MINUTES },
  refreshFailure: { limit: 30, windowMs: 15 * MINUTES, blockMs: 15 * MINUTES },
} satisfies Record<string, ThrottleRule>;

type Bucket = { attempts: number; windowStartedAt: number; blockedUntil: number };

/**
 * In-memory fixed-window limiter. Each replica keeps its own buckets, which
 * multiplies the budget by the replica count — acceptable for limits that
 * exist to slow guessing and abuse, not to meter use.
 *
 * Keys are hashed before they are stored, because some of them are refresh
 * tokens.
 */
export class Throttle {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxBuckets = 50_000,
  ) {}

  static key(...parts: string[]): string {
    return crypto.createHash("sha256").update(parts.join("\u0000")).digest("hex");
  }

  private bucket(key: string, rule: ThrottleRule): Bucket {
    const current = this.now();
    let bucket = this.buckets.get(key);
    const blockOver =
      bucket !== undefined && bucket.blockedUntil > 0 && bucket.blockedUntil <= current;
    const windowOver =
      bucket !== undefined &&
      bucket.blockedUntil === 0 &&
      current - bucket.windowStartedAt >= rule.windowMs;
    if (!bucket || blockOver || windowOver) {
      bucket = { attempts: 0, windowStartedAt: current, blockedUntil: 0 };
      this.buckets.set(key, bucket);
      if (this.buckets.size > this.maxBuckets) this.evict();
    }
    return bucket;
  }

  private refuse(bucket: Bucket): never {
    throw new RateLimitError(Math.max(1, Math.ceil((bucket.blockedUntil - this.now()) / 1000)));
  }

  /** Throw while the bucket is shut, without counting anything. */
  check(key: string): void {
    const bucket = this.buckets.get(key);
    if (bucket && bucket.blockedUntil > this.now()) this.refuse(bucket);
  }

  /** Count one attempt; throws once the window's budget is spent. */
  consume(key: string, rule: ThrottleRule): void {
    const bucket = this.bucket(key, rule);
    if (bucket.blockedUntil > this.now()) this.refuse(bucket);
    bucket.attempts += 1;
    if (bucket.attempts > rule.limit) {
      bucket.blockedUntil = this.now() + rule.blockMs;
      this.refuse(bucket);
    }
  }

  /** Count a failure after the fact; never throws, the next attempt is refused instead. */
  record(key: string, rule: ThrottleRule): void {
    try {
      this.consume(key, rule);
    } catch {
      // The bucket is now shut; the caller is already reporting its own error.
    }
  }

  /** Forget buckets whose window and block have both passed. */
  sweep(maxWindowMs = 15 * MINUTES): number {
    const current = this.now();
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      if (bucket.blockedUntil <= current && current - bucket.windowStartedAt >= maxWindowMs) {
        this.buckets.delete(key);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.buckets.size;
  }

  /** Under pressure from many addresses, drop the oldest open buckets first. */
  private evict(): void {
    this.sweep();
    for (const [key, bucket] of this.buckets) {
      if (this.buckets.size <= this.maxBuckets) break;
      if (bucket.blockedUntil <= this.now()) this.buckets.delete(key);
    }
  }
}
