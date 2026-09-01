import dns from "node:dns/promises";
import net from "node:net";
import { config } from "../../config.js";
import { getNetworkSettings } from "../services/runtimeSettings.js";

const MAX_REDIRECTS = 5;

const delegatedGlobalIpv6 = new net.BlockList();
delegatedGlobalIpv6.addSubnet("2000::", 3, "ipv6");
const specialIpv6 = new net.BlockList();
// Non-global or transition/documentation space inside today's delegated
// 2000::/3 block. Everything outside 2000::/3 is rejected conservatively as
// well, which also closes IPv4-mapped, NAT64, local, and multicast encodings.
specialIpv6.addSubnet("2001::", 23, "ipv6");
specialIpv6.addSubnet("2001:db8::", 32, "ipv6");
specialIpv6.addSubnet("2002::", 16, "ipv6");
specialIpv6.addSubnet("3fff::", 20, "ipv6");

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
  try {
    return delegatedGlobalIpv6.check(address, "ipv6") && !specialIpv6.check(address, "ipv6");
  } catch {
    return false;
  }
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

/** Both lists are stored normalized; normalizing again costs nothing and keeps
 *  a hand-edited row or a test override matching the same way a saved one does. */
function listed(list: readonly string[], host: string): boolean {
  return list.some((entry) => normalizeHost(entry) === host);
}

/**
 * The exact-match exemption from the public-address rule: a self-hosted Forgejo
 * at `git.internal`, an Ollama on the LAN, a metadata service an operator
 * genuinely wants reachable.
 *
 * **Two lists, unioned.** `config.security.outboundPrivateHostAllowlist` is
 * boot configuration and stays authoritative:
 * `installOutboundNetworkPolicy()` is installed in `server/index.ts` before
 * `initDb()` and `bootRuntimeSettings()` have run, so in that window the runtime
 * cache is still on its defaults and the config list is the only thing holding
 * an install's current behaviour. The runtime list is the same exemption an
 * operator can edit at Admin → Runtime without editing a file and restarting a
 * container, which is what AGENTS.md §5 requires of an operational knob.
 *
 * **A multi-tenant install ignores the runtime half.** `runtimeSecurity.ts`
 * refuses to boot a shared install whose *config* list is non-empty, but a
 * runtime group can be edited at any moment, so a boot check could only ever
 * have checked a value that changes afterwards. The invariant therefore lives
 * where the answer is derived, exactly as it does for `memberBrowsersEnabled()`
 * in `services/memberBrowsers.ts` and for the same reason: on shared
 * infrastructure, one tenant pointing the fetcher at a private network is a
 * boundary that has to hold per call, not per boot.
 *
 * Called from inside the DNS callback in `services/outboundNetworkPolicy.ts`,
 * so it is synchronous, never throws, and touches neither the database nor the
 * network — {@link getNetworkSettings} reads the same 30s cache every other
 * runtime getter does.
 */
export function privateHostAllowed(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (listed(config.security.outboundPrivateHostAllowlist, host)) return true;
  if (config.security.multiTenant) return false;
  return listed(getNetworkSettings().privateHostAllowlist, host);
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

  // WHATWG `hostname` keeps the brackets on an IPv6 literal ("[::1]"), which
  // `net.isIP` does not recognise. Without stripping them every IPv6 literal
  // fell through to a DNS lookup of a bracketed string: it failed closed, so
  // nothing unsafe was ever reachable, but it failed with `ENOTFOUND` rather
  // than the real reason — and it refused *public* IPv6 literals just as
  // indiscriminately.
  const literalHost =
    url.hostname.startsWith("[") && url.hostname.endsWith("]")
      ? url.hostname.slice(1, -1)
      : url.hostname;
  const literalKind = net.isIP(literalHost);
  const addresses = literalKind
    ? [{ address: literalHost, family: literalKind }]
    : await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error("Outbound hostname did not resolve");
  const blocked = addresses.find((entry) => !isPublicIp(entry.address));
  if (blocked) {
    throw new Error(`Outbound URL resolves to a non-public address (${blocked.address})`);
  }
  return url;
}

/**
 * Resolve a bare hostname and refuse every non-public answer.
 *
 * For destinations that are not URLs at all — an SMTP or IMAP endpoint, which
 * is a host and a port reached over a raw TCP socket. Those never pass through
 * the patched HTTP agents, so this is the only thing standing between a
 * tenant-supplied hostname and the operator's private network.
 *
 * Accepts `host`, `host:port` and `[::1]:993`; the port is discarded, since
 * callers police their own port policy.
 */
export async function assertPublicOutboundHost(host: string): Promise<void> {
  const trimmed = host.trim();
  if (!trimmed) throw new Error("A hostname is required");
  const bare = trimmed.startsWith("[")
    ? trimmed.slice(0, trimmed.indexOf("]") + 1)
    : trimmed.replace(/:\d+$/, "");
  await assertSafeOutboundUrl(`http://${bare}`);
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
  options: {
    maxBytes?: number;
    timeoutMs?: number;
    /** Maximum redirects to follow after validating each hop. Defaults to five. */
    maxRedirects?: number;
    /** Restrict every hop, including redirects, to these URL protocols. */
    allowedProtocols?: readonly ("http:" | "https:")[];
    /** Refuse redirects to another origin for requests with sensitive semantics. */
    sameOriginRedirectsOnly?: boolean;
  } = {},
): Promise<SafeFetchResult> {
  const maxBytes = options.maxBytes ?? config.security.outboundMaxResponseBytes;
  const timeoutMs = options.timeoutMs ?? config.security.outboundRequestTimeoutMs;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > MAX_REDIRECTS) {
    throw new Error(`Outbound redirect limit must be between 0 and ${MAX_REDIRECTS}`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, controller.signal])
    : controller.signal;
  let current = input instanceof URL ? new URL(input) : new URL(input);
  const headers = new Headers(init.headers);

  try {
    for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
      current = await assertSafeOutboundUrl(current);
      if (
        options.allowedProtocols &&
        !options.allowedProtocols.includes(current.protocol as "http:" | "https:")
      ) {
        throw new Error(
          `Outbound URL protocol ${current.protocol} is not allowed for this request`,
        );
      }
      const response = await fetch(current, {
        ...init,
        headers,
        redirect: "manual",
        signal,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new Error("Redirect response did not include a location");
        if (redirect === maxRedirects) {
          throw new Error(
            maxRedirects === 0
              ? "Outbound redirects are not allowed for this request"
              : "Too many outbound redirects",
          );
        }
        const next = new URL(location, current);
        if (options.sameOriginRedirectsOnly && next.origin !== current.origin) {
          throw new Error("Cross-origin outbound redirects are not allowed for this request");
        }
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
