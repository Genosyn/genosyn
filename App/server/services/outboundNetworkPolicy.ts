import dns, { type LookupAllOptions } from "node:dns";
import { type LookupFunction } from "node:net";
import http from "node:http";
import https from "node:https";
import { Agent, type Dispatcher, EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { config } from "../../config.js";
import { isPublicIp, privateHostAllowed } from "../lib/outboundUrl.js";

const safeLookup: LookupFunction = (hostname, options, callback) => {
  const normalized = options;
  const lookupOptions: LookupAllOptions = {
    ...normalized,
    all: true,
    verbatim: true,
  };
  dns.lookup(hostname, lookupOptions, (error, addresses) => {
    if (error) {
      callback(error, "", 0);
      return;
    }
    if (!privateHostAllowed(hostname) && addresses.some((entry) => !isPublicIp(entry.address))) {
      const denied = new Error(
        `Outbound connection to ${hostname} resolved to a non-public address`,
      ) as NodeJS.ErrnoException;
      denied.code = "EACCES";
      callback(denied, "", 0);
      return;
    }
    if (normalized.all) {
      callback(null, addresses);
      return;
    }
    const selected = addresses[0];
    if (!selected) {
      callback(new Error(`Outbound hostname ${hostname} did not resolve`), "", 0);
      return;
    }
    callback(null, selected.address, selected.family);
  });
};

let installed = false;

/**
 * Never proxied, whatever NO_PROXY says. The in-process Genosyn tool bridge
 * dials 127.0.0.1 with a live MCP token; sent to a proxy, that call would
 * leave the host and land on the proxy's own loopback instead of this one.
 */
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

function noProxyHosts(): string {
  const listed = (process.env.no_proxy ?? process.env.NO_PROXY ?? "").trim();
  // undici reads a NO_PROXY of exactly "*" as "proxy nothing"; appending to it
  // would turn that into a host literally named "*".
  if (listed === "*") return listed;
  return [listed, ...LOOPBACK_HOSTS].filter(Boolean).join(",");
}

function proxyConfigured(): boolean {
  const { http_proxy, HTTP_PROXY, https_proxy, HTTPS_PROXY } = process.env;
  return Boolean(http_proxy || HTTP_PROXY || https_proxy || HTTPS_PROXY);
}

/**
 * Requests leave directly under the lookup-time policy unless the operator set
 * HTTP_PROXY or HTTPS_PROXY; then everything but NO_PROXY hosts and loopback
 * goes through that proxy. A proxy resolves the names it carries, so
 * `safeLookup` never sees a proxied request: the policy holds for it only where
 * its URL is checked (`assertSafeOutboundUrl`), and the proxy's own rules do
 * the rest. A shared install stays direct, because there the connect-time check
 * keeps one tenant out of the operator's network and no proxy can promise that.
 */
function policyDispatcher(options: Omit<Agent.Options, "connect"> = {}): Dispatcher {
  const connect = { lookup: safeLookup };
  if (config.security.multiTenant) return new Agent({ ...options, connect });
  return new EnvHttpProxyAgent({
    ...options,
    connect,
    noProxy: noProxyHosts(),
    // Plain-http requests go to the proxy in absolute form, as curl sends them,
    // rather than through CONNECT, which Squid's default config refuses for any
    // port but 443.
    proxyTunnel: false,
  });
}

/**
 * A dispatcher under the same policy, for requests that need their own
 * timeouts or pooling rather than the global dispatcher's.
 */
export function outboundAgent(options: Omit<Agent.Options, "connect"> = {}): Dispatcher {
  return policyDispatcher(options);
}

/**
 * Enforce the public-network policy at socket lookup time as well as URL
 * validation time. This closes the DNS-rebinding gap for fetch, provider SDKs,
 * and Node HTTP clients while preserving literal loopback calls used by the
 * in-process Genosyn tool bridge (untrusted literals are rejected earlier).
 * fetch also follows the operator's HTTP proxy; see {@link policyDispatcher}.
 */
export function installOutboundNetworkPolicy(): void {
  if (installed) return;
  installed = true;
  (http.globalAgent as unknown as { options: http.AgentOptions }).options.lookup = safeLookup;
  (https.globalAgent as unknown as { options: https.AgentOptions }).options.lookup = safeLookup;
  if (config.security.multiTenant && proxyConfigured()) {
    // eslint-disable-next-line no-console
    console.warn(
      "[security] multi-tenant install: Genosyn's own requests ignore HTTP_PROXY / HTTPS_PROXY and leave directly, so the connect-time outbound policy still checks every one.",
    );
  }
  setGlobalDispatcher(policyDispatcher());
}
