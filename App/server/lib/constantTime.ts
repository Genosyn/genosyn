import crypto from "node:crypto";

/** Compare secrets without exposing a useful prefix-matching timing signal. */
export function constantTimeEqual(actual: string, expected: string): boolean {
  const actualDigest = crypto.createHash("sha256").update(actual).digest();
  const expectedDigest = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(actualDigest, expectedDigest);
}
