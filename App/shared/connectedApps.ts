/**
 * Connected apps: an OAuth client (claude.ai, ChatGPT, any MCP client that
 * signs in rather than sending a key) that a Member approved to use the
 * Genosyn MCP server as them, in one company. Shared so the consent screen,
 * Settings and the server agree on who may connect one and for how long.
 */

/**
 * Who may connect an app: owners and admins. An app acts with its Member's
 * full authority through the MCP server, with no key for anyone to look after,
 * so connecting one is kept to the people trusted with the company. Ordinary
 * Members can still mint an API key for an MCP client. Checked when the app is
 * approved and again on every request it makes, so demoting a Member stops
 * their apps.
 */
export function mayConnectApps(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

/** Why `role` may not connect apps, in words for the Member. */
export const CONNECT_APPS_ROLE_REQUIRED =
  "Only owners and admins can connect apps to this company. Ask an owner, or use an API key from Settings → API keys.";

/** An access token lasts an hour; the app refreshes it without asking anyone. */
export const CONNECTED_APP_ACCESS_TOKEN_SECONDS = 60 * 60;

/** An app that goes this long without refreshing has to be approved again. */
export const CONNECTED_APP_IDLE_DAYS = 30;

/** The one scope there is: using the Genosyn MCP server as the Member who approved the app. */
export const CONNECTED_APP_SCOPE = "mcp";
