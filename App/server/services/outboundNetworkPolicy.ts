import dns, { type LookupAllOptions } from "node:dns";
import { type LookupFunction } from "node:net";
import http from "node:http";
import https from "node:https";
import { Agent, setGlobalDispatcher } from "undici";
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
 * Enforce the public-network policy at socket lookup time as well as URL
 * validation time. This closes the DNS-rebinding gap for fetch, provider SDKs,
 * and Node HTTP clients while preserving literal loopback calls used by the
 * in-process Genosyn tool bridge (untrusted literals are rejected earlier).
 */
export function installOutboundNetworkPolicy(): void {
  if (installed) return;
  installed = true;
  (http.globalAgent as unknown as { options: http.AgentOptions }).options.lookup = safeLookup;
  (https.globalAgent as unknown as { options: https.AgentOptions }).options.lookup = safeLookup;
  setGlobalDispatcher(new Agent({ connect: { lookup: safeLookup } }));
}
