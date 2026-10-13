import crypto from "node:crypto";

/**
 * Twilio's webhook signature — the only credential the public phone webhooks
 * have.
 *
 * Twilio signs each request with the account's Auth Token: HMAC-SHA1 over the
 * full URL it requested followed by every POST parameter, sorted by name, with
 * each name and value appended and no separators. The result rides in the
 * `X-Twilio-Signature` header, base64-encoded.
 *
 * The URL is the part that goes wrong in practice. Twilio signs the address it
 * was *configured* with, while this process sees whatever its reverse proxy
 * forwarded — a different scheme, an added or dropped default port, the public
 * URL changed since the number was set up. So callers pass every plausible
 * spelling of the URL and a match on any one of them is accepted. That widens
 * nothing: the HMAC key is the Auth Token, and every candidate carries the
 * path that was actually requested, so a signature for one number's webhook
 * cannot be replayed onto another's.
 */

export function twilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string | string[]>,
): string {
  const pairs: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) for (const entry of value) pairs.push([key, entry]);
    else pairs.push([key, value]);
  }
  pairs.sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
  );
  const data = pairs.reduce((acc, [key, value]) => acc + key + value, url);
  return crypto.createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
}

/**
 * The URL with and without its scheme's default port, since Twilio may have
 * signed either. Anything unparseable is returned as-is.
 */
export function urlPortVariants(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [url];
  }
  const defaultPort =
    parsed.protocol === "https:" ? "443" : parsed.protocol === "http:" ? "80" : "";
  const variants = new Set<string>([url]);
  if (!defaultPort) return [...variants];
  const rest = `${parsed.pathname}${parsed.search}`;
  const host = parsed.hostname.includes(":") ? `[${parsed.hostname}]` : parsed.hostname;
  if (!parsed.port || parsed.port === defaultPort) {
    variants.add(`${parsed.protocol}//${host}${rest}`);
    variants.add(`${parsed.protocol}//${host}:${defaultPort}${rest}`);
  }
  return [...variants];
}

/** True when `signature` is Twilio's for any of the candidate URLs. */
export function verifyTwilioSignature(args: {
  authToken: string;
  signature: string | undefined;
  urls: string[];
  params: Record<string, string | string[]>;
}): boolean {
  const provided = (args.signature ?? "").trim();
  if (!provided || !args.authToken) return false;
  const providedBuf = Buffer.from(provided);
  const seen = new Set<string>();
  for (const candidate of args.urls) {
    for (const url of urlPortVariants(candidate)) {
      if (seen.has(url)) continue;
      seen.add(url);
      const expected = Buffer.from(twilioSignature(args.authToken, url, args.params));
      if (expected.length === providedBuf.length && crypto.timingSafeEqual(expected, providedBuf)) {
        return true;
      }
    }
  }
  return false;
}
