/**
 * The routes the API reference deliberately leaves out — and why.
 *
 * Everything else the App answers is documented automatically, and the
 * coverage test (`coverage.test.ts`) fails on a route that is neither in the
 * reference nor matched here, so a new endpoint cannot ship undocumented by
 * accident. Keep this list short: an entry belongs here only when no API
 * client could, or should, call the route — machine-to-machine traffic between
 * the App's own processes, callbacks a third party makes, and browser
 * navigations that redirect rather than answer. Each entry must still match a
 * real route; the coverage test fails on one that matches nothing.
 */

export type Exclusion = {
  /** Uppercase method, or "*" for every method. */
  method: string;
  /** An OpenAPI path template, or a prefix ending in "/" that covers everything below it. */
  path: string;
  reason: string;
};

export const NOT_PUBLIC_API: readonly Exclusion[] = [
  {
    method: "*",
    path: "/api/internal/mcp/",
    reason:
      "The loopback-only tool API behind AI Employees' built-in genosyn tools, authenticated by " +
      "short-lived MCP tokens the App issues to itself. External agents use the MCP endpoint instead.",
  },
  {
    method: "*",
    path: "/api/internal/browser/sessions/",
    reason: "Loopback-only RPC between the browser MCP child process and the App's Chromium.",
  },
  {
    method: "*",
    path: "/api/internal/member-browsers/",
    reason:
      "The Member browser bridge agent's own surface: redeeming a pairing code and downloading the agent.",
  },
  {
    method: "*",
    path: "/api/chat-surfaces/webhook/",
    reason: "Microsoft Teams and WhatsApp deliveries, authenticated by the provider's signature.",
  },
  {
    method: "*",
    path: "/api/phone/webhooks/",
    reason: "Twilio's text, call and status callbacks, authenticated by Twilio's signature.",
  },
  {
    method: "*",
    path: "/api/integrations/oauth/",
    reason: "OAuth providers and Genosyn Connect redirecting the browser back after consent.",
  },
  {
    method: "GET",
    path: "/api/auth/sso/start",
    reason: "A browser navigation that redirects to the identity provider.",
  },
  {
    method: "GET",
    path: "/api/auth/sso/callback",
    reason: "The identity provider redirecting the browser back after sign-in.",
  },
  {
    method: "GET",
    path: "/api/auth/sso/company/{companySlug}/start",
    reason: "A browser navigation that redirects to the company's identity provider.",
  },
  {
    method: "GET",
    path: "/api/auth/sso/company/callback",
    reason: "The company's identity provider redirecting the browser back after sign-in.",
  },
  {
    method: "*",
    path: "/api/app/",
    reason:
      "The custom JavaScript an operator adds at Admin → General, loaded by the App's own pages.",
  },
  {
    method: "*",
    path: "/api/docs/",
    reason: "The API reference viewer's own page and scripts.",
  },
  {
    method: "GET",
    path: "/api/companies/{cid}/employees/{eid}/browser-sessions/{id}/view",
    reason: "The live browser viewer page the App embeds in an iframe.",
  },
  {
    method: "GET",
    path: "/api/companies/{cid}/employees/{eid}/browser-sessions/{id}/view.js",
    reason: "The live browser viewer's script.",
  },
  {
    method: "*",
    path: "/u/",
    reason: "RFC 8058 one-click unsubscribe links in sent email, outside the API by design.",
  },
];

/**
 * Everything outside `/api` — the careers site's pages, the App shell, the
 * client's assets — is a page or a link, not the API. The server's real app
 * mounts those after `createApp()`, so they reach the reference at runtime
 * and are left out by this rule rather than one entry each.
 */
export const OUTSIDE_THE_API: Exclusion = {
  method: "*",
  path: "/",
  reason: "Pages, links and assets served outside /api are not part of the API.",
};

/** The exclusion covering `method path`, if any. */
export function exclusionFor(method: string, path: string): Exclusion | undefined {
  const upper = method.toUpperCase();
  const listed = NOT_PUBLIC_API.find(
    (entry) =>
      (entry.method === "*" || entry.method === upper) &&
      (entry.path.endsWith("/") ? path.startsWith(entry.path) : path === entry.path),
  );
  if (listed) return listed;
  return path === "/api" || path.startsWith("/api/") ? undefined : OUTSIDE_THE_API;
}
