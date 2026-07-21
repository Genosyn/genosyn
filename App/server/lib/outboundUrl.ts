import dns from "node:dns/promises";
import net from "node:net";
import { config } from "../../config.js";

const MAX_REDIRECTS = 5;

function ipv4Number(address: string): number | null {
  if (net.isIP(address) !== 4) return null;
  return address
    .split(".")
    .map(Number)
    .reduce((value, octet) => ((value << 8) | octet) >>> 0, 0);
}

function inV4Cidr(value: number, base: string, bits: number): boolean {
  const baseValue = ipv4Number(base);
  if (baseValue === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (baseValue & mask);
}

export function isPublicIp(address: string): boolean {
  const v4 = ipv4Number(address);
  if (v4 !== null) {
    const blocked: Array<[string, number]> = [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ];
    return !blocked.some(([base, bits]) => inV4Cidr(v4, base, bits));
  }

  if (net.isIP(address) !== 6) return false;
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return false;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicIp(mapped[1]);
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return false;
  if (/^fe[89ab]/.test(normalized)) return false;
  if (normalized.startsWith("ff")) return false;
  if (normalized.startsWith("2001:db8:")) return false;
  return true;
}

export function privateHostAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return config.security.outboundPrivateHostAllowlist.some(
    (allowed) => allowed.toLowerCase().replace(/\.$/, "") === host,
  );
}

/** Resolve and reject every non-public result, preventing mixed DNS answers. */
export async function assertSafeOutboundUrl(input: string | URL): Promise<URL> {
  const url = input instanceof URL ? new URL(input) : new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http(s) outbound URLs are allowed");
  }
  if (url.username || url.password) {
    throw new Error("Outbound URLs must not contain embedded credentials");
  }
  if (privateHostAllowed(url.hostname)) return url;

  const literalKind = net.isIP(url.hostname);
  const addresses = literalKind
    ? [{ address: url.hostname, family: literalKind }]
    : await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error("Outbound hostname did not resolve");
  const blocked = addresses.find((entry) => !isPublicIp(entry.address));
  if (blocked) {
    throw new Error(`Outbound URL resolves to a non-public address (${blocked.address})`);
  }
  return url;
}

/** Validate URL/host-shaped values in an Integration connection form. */
export async function assertSafeOutboundConfig(values: Record<string, unknown>): Promise<void> {
  for (const [key, raw] of Object.entries(values)) {
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    if (/^https?:\/\//i.test(value)) {
      await assertSafeOutboundUrl(value);
      continue;
    }
    if (/(^|[_-])(host|hostname)$/i.test(key) && value) {
      const host = value.startsWith("[") ? value : value.replace(/:\d+$/, "");
      await assertSafeOutboundUrl(`http://${host}`);
    }
  }
}

export type SafeFetchResult = {
  status: number;
  ok: boolean;
  headers: Headers;
  body: Buffer;
  url: string;
};

/**
 * Fetch an untrusted URL with validation on every redirect, a wall-clock
 * timeout, and a streaming response cap. This deliberately returns a bounded
 * buffer so callers cannot accidentally call response.text() without limits.
 */
export async function safeFetchBuffer(
  input: string | URL,
  init: RequestInit = {},
  options: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<SafeFetchResult> {
  const maxBytes = options.maxBytes ?? config.security.outboundMaxResponseBytes;
  const timeoutMs = options.timeoutMs ?? config.security.outboundRequestTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, controller.signal])
    : controller.signal;
  let current = input instanceof URL ? new URL(input) : new URL(input);
  const headers = new Headers(init.headers);

  try {
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      current = await assertSafeOutboundUrl(current);
      const response = await fetch(current, {
        ...init,
        headers,
        redirect: "manual",
        signal,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new Error("Redirect response did not include a location");
        if (redirect === MAX_REDIRECTS) throw new Error("Too many outbound redirects");
        const next = new URL(location, current);
        if (next.origin !== current.origin) {
          headers.delete("authorization");
          headers.delete("cookie");
          headers.delete("proxy-authorization");
        }
        current = next;
        continue;
      }

      const chunks: Buffer[] = [];
      let total = 0;
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          total += part.value.byteLength;
          if (total > maxBytes) {
            await reader.cancel();
            throw new Error(`Outbound response exceeds the ${maxBytes}-byte limit`);
          }
          chunks.push(Buffer.from(part.value));
        }
      }
      return {
        status: response.status,
        ok: response.ok,
        headers: response.headers,
        body: Buffer.concat(chunks, total),
        url: current.toString(),
      };
    }
    throw new Error("Too many outbound redirects");
  } finally {
    clearTimeout(timer);
  }
}
