import { CONNECTED_APP_SCOPE } from "../../../shared/connectedApps.js";
import { getPublicUrl } from "../publicUrl.js";

/**
 * Where this install's OAuth authorization server lives, and the two
 * discovery documents an MCP client reads before it signs in.
 *
 * The MCP authorization spec has a client start from the MCP endpoint it was
 * given: a 401 there points at the endpoint's protected-resource metadata
 * (RFC 9728), which names the authorization server, whose own metadata
 * (RFC 8414) lists the authorize, token and registration endpoints. Everything
 * is built from the install's public URL — the same origin the MCP endpoint
 * checks a browser `Origin` against — so it must be the address clients
 * connect to.
 */

export const MCP_SERVER_DOCUMENTATION = "https://genosyn.com/docs/mcp-server";

/** The authorization server's issuer identifier: the install's public origin. */
export function oauthIssuer(): string {
  return getPublicUrl();
}

export function oauthEndpoints(issuer: string = oauthIssuer()) {
  return {
    authorization: `${issuer}/oauth/authorize`,
    token: `${issuer}/api/oauth/token`,
    registration: `${issuer}/api/oauth/register`,
    revocation: `${issuer}/api/oauth/revoke`,
  };
}

/** The path of a company's MCP endpoint. */
export function companyMcpPath(companyId: string): string {
  return `/api/companies/${encodeURIComponent(companyId)}/mcp`;
}

/** A company's MCP endpoint as an OAuth resource (RFC 8707): what its tokens are for. */
export function companyMcpResource(companyId: string, issuer: string = oauthIssuer()): string {
  return `${issuer}${companyMcpPath(companyId)}`;
}

/** Where a client reads the MCP endpoint's protected-resource metadata (RFC 9728 §3.1). */
export function protectedResourceMetadataUrl(
  companyId: string,
  issuer: string = oauthIssuer(),
): string {
  return `${issuer}/.well-known/oauth-protected-resource${companyMcpPath(companyId)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCompanyId(value: string): boolean {
  return UUID.test(value);
}

/**
 * The company whose MCP endpoint `resource` is, or null when it is not one of
 * this install's: another origin, another path, a query or a fragment.
 */
export function companyIdFromResource(
  resource: string,
  issuer: string = oauthIssuer(),
): string | null {
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    return null;
  }
  if (url.origin !== new URL(issuer).origin) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const match = /^\/api\/companies\/([^/]+)\/mcp\/?$/.exec(url.pathname);
  if (!match) return null;
  let companyId: string;
  try {
    companyId = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  return isCompanyId(companyId) ? companyId.toLowerCase() : null;
}

/** RFC 9728 metadata for one company's MCP endpoint. */
export function protectedResourceMetadata(companyId: string, issuer: string = oauthIssuer()) {
  return {
    resource: companyMcpResource(companyId, issuer),
    authorization_servers: [issuer],
    scopes_supported: [CONNECTED_APP_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Genosyn",
    resource_documentation: MCP_SERVER_DOCUMENTATION,
  };
}

const CLIENT_AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"];

/** RFC 8414 metadata for the authorization server. */
export function authorizationServerMetadata(issuer: string = oauthIssuer()) {
  const endpoints = oauthEndpoints(issuer);
  return {
    issuer,
    authorization_endpoint: endpoints.authorization,
    token_endpoint: endpoints.token,
    registration_endpoint: endpoints.registration,
    revocation_endpoint: endpoints.revocation,
    scopes_supported: [CONNECTED_APP_SCOPE],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: CLIENT_AUTH_METHODS,
    revocation_endpoint_auth_methods_supported: CLIENT_AUTH_METHODS,
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
    service_documentation: MCP_SERVER_DOCUMENTATION,
  };
}
