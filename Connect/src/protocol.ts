/**
 * One wire protocol a provider is served under.
 *
 * Installations save the path they signed in through and renew tokens on
 * that exact path forever after, so a path, its cookie prefix and its
 * window-message names can never change once released. State kinds are per
 * protocol: a sign-in started on one path cannot be continued on another.
 */
export type Protocol = {
  providerId: string;
  basePath: string;
  flowKind: string;
  callbackKind: string;
  cookiePrefix: string;
  /** Posted by the consent page to the window that opened it. */
  readyMessage: string;
  /** Posted back by that window with the browser proof. */
  launchMessage: string;
  /**
   * The first Gmail-only release: the client never names scopes and expects
   * Gmail, and the start request may carry nothing else.
   */
  legacy: boolean;
};

export function canonicalProtocol(providerId: string): Protocol {
  return {
    providerId,
    basePath: `/api/connect/${providerId}`,
    flowKind: `flow:${providerId}`,
    callbackKind: `callback:${providerId}`,
    cookiePrefix: `genosyn_connect_${providerId}_`,
    readyMessage: "genosyn-sign-in-ready",
    launchMessage: "genosyn-sign-in-launch",
    legacy: false,
  };
}

/** The Gmail-only path released before provider-neutral routes existed. */
export const LEGACY_GOOGLE_PROTOCOL: Protocol = Object.freeze({
  providerId: "google",
  basePath: "/api/google-sign-in",
  flowKind: "flow:google-legacy",
  callbackKind: "callback:google-legacy",
  cookiePrefix: "genosyn_gmail_",
  readyMessage: "genosyn-google-sign-in-ready",
  launchMessage: "genosyn-google-sign-in-launch",
  legacy: true,
});

export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
