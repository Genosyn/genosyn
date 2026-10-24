import { CONNECTED_APP_IDLE_DAYS } from "../../shared/connectedApps";
import { indefiniteArticle } from "../../shared/indefiniteArticle";

/**
 * The consent page an MCP client's sign-in lands on (`/oauth/consent`): what
 * the URL carries, where signing in returns to, what to tell the Member, and
 * where the browser may go once they answer. Kept apart from the page so the
 * parts worth testing — the words and the way out — are plain functions.
 */

/** The sealed request in a consent or sign-in URL: bounded, and only the characters one has. */
function sealedRequest(value: string | null): string | null {
  return value && value.length <= 8000 && /^[A-Za-z0-9._-]+$/.test(value) ? value : null;
}

/** The request on the consent page itself (`?request=`). */
export function consentRequestFromSearch(search: string): string | null {
  return sealedRequest(new URLSearchParams(search).get("request"));
}

/** A pending approval carried through sign-in (`/login?oauth=`) — a request, never a URL. */
export function consentRequestFromLoginSearch(search: string): string | null {
  return sealedRequest(new URLSearchParams(search).get("oauth"));
}

export function consentPath(request: string): string {
  return `/oauth/consent?request=${encodeURIComponent(request)}`;
}

/** Sign in, then come back to approve. */
export function consentLoginPath(request: string): string {
  return `/login?oauth=${encodeURIComponent(request)}`;
}

/** Why the authorization endpoint stopped before asking anyone, in words. */
export const AUTHORIZATION_PAGE_ERRORS: Record<string, { title: string; message: string }> = {
  missing_client: {
    title: "This link is incomplete",
    message:
      "The app didn't say which app it is, so there is nothing to approve. Go back to the app and connect again.",
  },
  unknown_client: {
    title: "Genosyn doesn't know this app",
    message:
      "The app isn't registered with this Genosyn, or its registration was removed after a month unused. Remove the connector in the app and add it again.",
  },
  missing_redirect_uri: {
    title: "This link is incomplete",
    message: "The app didn't say where to send you back to. Go back to the app and connect again.",
  },
  unregistered_redirect_uri: {
    title: "This link isn't safe to follow",
    message:
      "It asks to send you somewhere the app never registered, so Genosyn stopped here. Start connecting again from the app itself.",
  },
  invalid_request: {
    title: "This isn't a valid request",
    message: "Go back to the app and connect again.",
  },
};

export function authorizationPageError(code: string | null): { title: string; message: string } {
  return (code && AUTHORIZATION_PAGE_ERRORS[code]) || AUTHORIZATION_PAGE_ERRORS.invalid_request;
}

/**
 * Where the browser goes once the Member answers: the app's own address, and
 * only ever an http(s) one — never a script URL, whatever the server said.
 */
export function safeAppRedirect(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** `claude.ai` from `https://claude.ai`: the part of the address a person recognizes. */
export function appHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

const FINANCE_WORDS = { full: "full", read: "read-only", none: "no" } as const;

/** What approving gives the app, one sentence each. */
export function consentGrants(
  company: { name: string; role: string; financeAccess: "none" | "read" | "full" },
  appName: string,
): string[] {
  const role =
    company.role === "owner" ? "the owner" : `${indefiniteArticle(company.role)} ${company.role}`;
  return [
    `${appName} can use Genosyn as you in ${company.name} — as ${role}, with ${FINANCE_WORDS[company.financeAccess]} Finance access — through the Genosyn MCP server: find, read and change what you can, and nothing more.`,
    "It can't do what needs you at a signed-in browser: API keys, the Vault, Member roles or Approvals.",
    `It stays connected until you disconnect it at Settings → API keys, or after ${CONNECTED_APP_IDLE_DAYS} days without use.`,
  ];
}
