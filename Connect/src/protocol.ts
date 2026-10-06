/**
 * The protocol version Connect speaks, reported by every status route.
 *
 * Version 2 keeps no state: a sign-in's context travels sealed with it, and
 * the credential returns to the installation through the browser, encrypted
 * to a key only that installation holds. Installations released before it
 * spoke version 1, which parked the credential on the service until they
 * polled for it; they read `version: 2` as "not available here" and never
 * start a sign-in they could not finish. Renewal (`/refresh`) is the same in
 * both versions and must stay so: every Connection renews on the path that
 * issued it, for as long as it exists.
 */
export const PROTOCOL_VERSION = 2;

/** One provider's routes, cookies and window messages. */
export type Protocol = {
  providerId: string;
  basePath: string;
  cookiePrefix: string;
  /** Posted by the consent page to the window that opened it. */
  readyMessage: string;
  /** Posted back by that window with the browser proof. */
  launchMessage: string;
};

export function canonicalProtocol(providerId: string): Protocol {
  return {
    providerId,
    basePath: `/api/connect/${providerId}`,
    cookiePrefix: `genosyn_connect_${providerId}_`,
    readyMessage: "genosyn-sign-in-ready",
    launchMessage: "genosyn-sign-in-launch",
  };
}

export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * Installations released from 1.227 up to protocol 2 issued Gmail Connections
 * on this path, and renew them here. Only renewal is left on it.
 */
export const LEGACY_GOOGLE_RENEWAL_PATH = "/api/google-sign-in";
