import { STATUS_CODES } from "node:http";
import { safeFetchBuffer } from "../../lib/outboundUrl.js";

/**
 * The axios-style HTTP client handed to `logic.code` steps.
 *
 * It deliberately is not the axios package: every request goes through
 * `safeFetchBuffer`, so code steps get the same private-network protections,
 * redirect re-validation, and response-size cap as the HTTP request step. The
 * surface mirrors what axios callers reach for — `axios.get/post/…`, `params`,
 * JSON `data`, a `{ status, headers, data }` response, and non-2xx statuses
 * rejecting with `error.response` attached.
 */

/** Same cap as the `logic.http` node. */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_HTTP_REQUESTS_PER_STEP = 50;

export type CodeHttpRequestConfig = {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  /** Appended to the URL as query-string entries. */
  params?: Record<string, unknown>;
  /** Request body. Objects/arrays are sent as JSON. */
  data?: unknown;
  /** Per-request cap in ms; the step deadline still applies. */
  timeout?: number;
  /** Axios-compatible: decide which statuses resolve. Default 2xx. */
  validateStatus?: ((status: number) => boolean) | null;
};

export type CodeHttpResponse = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: unknown;
  config: { url: string; method: string };
};

export type CodeHttpClient = {
  (urlOrConfig: string | CodeHttpRequestConfig, config?: CodeHttpRequestConfig): Promise<CodeHttpResponse>;
  request: (config: CodeHttpRequestConfig) => Promise<CodeHttpResponse>;
  get: (url: string, config?: CodeHttpRequestConfig) => Promise<CodeHttpResponse>;
  delete: (url: string, config?: CodeHttpRequestConfig) => Promise<CodeHttpResponse>;
  head: (url: string, config?: CodeHttpRequestConfig) => Promise<CodeHttpResponse>;
  post: (url: string, data?: unknown, config?: CodeHttpRequestConfig) => Promise<CodeHttpResponse>;
  put: (url: string, data?: unknown, config?: CodeHttpRequestConfig) => Promise<CodeHttpResponse>;
  patch: (url: string, data?: unknown, config?: CodeHttpRequestConfig) => Promise<CodeHttpResponse>;
};

export type CodeHttpContext = {
  /** Epoch ms after which the step is over budget. */
  deadlineAt: number;
  log: (line: string) => void;
};

export function makeCodeHttpClient(ctx: CodeHttpContext): CodeHttpClient {
  let remainingRequests = MAX_HTTP_REQUESTS_PER_STEP;

  async function request(config: CodeHttpRequestConfig): Promise<CodeHttpResponse> {
    if (remainingRequests <= 0) {
      throw new Error(
        `HTTP request limit reached (${MAX_HTTP_REQUESTS_PER_STEP} requests per code step)`,
      );
    }
    remainingRequests -= 1;

    const rawUrl = String(config.url ?? "").trim();
    if (!rawUrl) throw new Error("axios: url is required");
    if (!/^https?:\/\//i.test(rawUrl)) {
      throw new Error("axios: url must start with http:// or https://");
    }
    const url = new URL(rawUrl);
    if (config.params && typeof config.params === "object") {
      for (const [key, value] of Object.entries(config.params)) {
        if (value === null || value === undefined) continue;
        url.searchParams.append(key, String(value));
      }
    }

    const method = String(config.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    if (config.headers && typeof config.headers === "object") {
      for (const [key, value] of Object.entries(config.headers)) {
        if (value === null || value === undefined) continue;
        headers[key] = String(value);
      }
    }

    const init: RequestInit = { method, headers };
    if (method !== "GET" && method !== "HEAD" && config.data !== undefined) {
      if (typeof config.data === "string") {
        init.body = config.data;
      } else {
        init.body = JSON.stringify(config.data);
        if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
          headers["content-type"] = "application/json";
        }
      }
    }

    const remainingMs = ctx.deadlineAt - Date.now();
    if (remainingMs <= 0) throw new Error("Code step timed out");
    const requestTimeout = Number(config.timeout);
    const timeoutMs = Math.min(
      remainingMs,
      Number.isFinite(requestTimeout) && requestTimeout > 0
        ? requestTimeout
        : DEFAULT_REQUEST_TIMEOUT_MS,
    );

    ctx.log(`${method} ${url.toString()}`);
    const res = await safeFetchBuffer(url, init, {
      maxBytes: MAX_RESPONSE_BYTES,
      timeoutMs,
    });
    const text = res.body.toString("utf8");
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* keep as text */
    }
    ctx.log(`→ ${res.status} (${text.length} bytes)`);

    const response: CodeHttpResponse = {
      status: res.status,
      statusText: STATUS_CODES[res.status] ?? "",
      headers: Object.fromEntries(res.headers.entries()),
      data,
      config: { url: url.toString(), method },
    };

    const validate =
      typeof config.validateStatus === "function"
        ? config.validateStatus
        : config.validateStatus === null
          ? () => true
          : (status: number) => status >= 200 && status < 300;
    if (!validate(res.status)) {
      const err = new Error(`Request failed with status code ${res.status}`) as Error & {
        response: CodeHttpResponse;
        isAxiosError: boolean;
      };
      err.response = response;
      err.isAxiosError = true;
      throw err;
    }
    return response;
  }

  const client = ((urlOrConfig: string | CodeHttpRequestConfig, config?: CodeHttpRequestConfig) => {
    if (typeof urlOrConfig === "string") {
      return request({ ...(config ?? {}), url: urlOrConfig });
    }
    return request(urlOrConfig ?? {});
  }) as CodeHttpClient;

  client.request = (config) => request(config ?? {});
  client.get = (url, config) => request({ ...(config ?? {}), url, method: "GET" });
  client.delete = (url, config) => request({ ...(config ?? {}), url, method: "DELETE" });
  client.head = (url, config) => request({ ...(config ?? {}), url, method: "HEAD" });
  client.post = (url, data, config) => request({ ...(config ?? {}), url, data, method: "POST" });
  client.put = (url, data, config) => request({ ...(config ?? {}), url, data, method: "PUT" });
  client.patch = (url, data, config) => request({ ...(config ?? {}), url, data, method: "PATCH" });
  return Object.freeze(client);
}
