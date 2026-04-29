/**
 * Shared helpers for the Google umbrella provider and its per-product tool
 * modules. Lives here (rather than on `google.ts`) so the tool modules can
 * import it without creating an `gmail-tools → google → gmail-tools` cycle.
 */

export function safeJson(s: string): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  const i = Math.floor(v);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

export function requireString(v: unknown, field: string): string {
  if (typeof v !== "string" || !v) {
    throw new Error(`${field} is required`);
  }
  return v;
}

export function optionalString(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/**
 * Generic JSON fetch against a Google API endpoint, with consistent error
 * shaping. Tool modules pass their own base URL so they can target gmail.,
 * www.googleapis.com/drive, googleapis/calendar, etc.
 */
export async function googleJsonFetch(args: {
  accessToken: string;
  baseUrl: string;
  path: string;
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | string[] | undefined>;
  /** Friendly label used in error messages, e.g. "Calendar". */
  productLabel: string;
}): Promise<unknown> {
  const url = new URL(`${args.baseUrl}${args.path}`);
  if (args.query) {
    for (const [k, v] of Object.entries(args.query)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) {
        for (const item of v) url.searchParams.append(k, String(item));
      } else {
        url.searchParams.set(k, String(v));
      }
    }
  }
  const init: RequestInit = {
    method: args.method ?? "GET",
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      accept: "application/json",
    },
  };
  if (args.body !== undefined) {
    (init.headers as Record<string, string>)["content-type"] = "application/json";
    init.body = typeof args.body === "string" ? args.body : JSON.stringify(args.body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  const parsed = safeJson(text);
  if (!res.ok) {
    const msg =
      (parsed && typeof parsed === "object" && "error" in parsed
        ? extractGoogleErrorMessage(parsed as Record<string, unknown>)
        : null) ?? `${args.productLabel} ${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  return parsed;
}

function extractGoogleErrorMessage(parsed: Record<string, unknown>): string | null {
  const err = parsed.error;
  if (typeof err === "string" && err) return err;
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === "string" && obj.message) return obj.message;
    if (Array.isArray(obj.errors) && obj.errors.length > 0) {
      const first = obj.errors[0];
      if (first && typeof first === "object") {
        const m = (first as { message?: unknown }).message;
        if (typeof m === "string" && m) return m;
      }
    }
  }
  return null;
}
