import { UpstreamError } from "./errors.js";

export type Fetch = typeof fetch;

const MAX_RESPONSE_BYTES = 64 * 1024;

export type UpstreamResult = { ok: boolean; status: number; body: unknown };

/**
 * Call a fixed upstream endpoint and return its JSON.
 *
 * Redirects are refused, the body is capped, and every failure becomes an
 * {@link UpstreamError} with no upstream detail: the request carried a client
 * secret, an authorization code, or a refresh token, and an error message is
 * the easiest way for one of those to end up in a log.
 */
export async function upstreamJson(
  fetchImpl: Fetch,
  url: string,
  init: RequestInit,
  timeoutMs = 15_000,
): Promise<UpstreamResult> {
  try {
    const response = await fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const reader = response.body?.getReader();
    if (!reader) throw new UpstreamError();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new UpstreamError();
      }
      chunks.push(value);
    }
    return {
      ok: response.ok,
      status: response.status,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
    };
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    throw new UpstreamError();
  }
}
