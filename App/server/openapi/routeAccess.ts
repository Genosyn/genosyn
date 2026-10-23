import type { Role } from "../db/entities/Membership.js";
import {
  matchesRoutePath,
  requireApiKeyAuth,
  requireAuth,
  requireBrowserSession,
  requireCompanyMember,
  requireMasterAdmin,
  roleAtLeast,
} from "../middleware/auth.js";
import { requireFinanceRead, requireFinanceWrite } from "../middleware/financeAccess.js";
import { routeMetadataOf } from "../middleware/routeMetadata.js";
import type { DiscoveredRoute } from "./routeDiscovery.js";

/**
 * Who may call a route, read off the guards that actually run in front of it.
 *
 * This is the authorization half of the generated API reference, and the part
 * where being wrong costs the most: a reference that promises an API key works
 * where it is refused wastes an afternoon, and one that hides a guard misleads.
 * So nothing here is declared per route. It recognizes the App's own guards —
 * `requireAuth`, `requireApiKeyAuth`, `requireBrowserSession`, `requireMasterAdmin`,
 * `requireCompanyMember`, the company-role and Finance gates, and
 * `onRoutePaths(...)` scoping evaluated against the route's own path — in the
 * chain `routeDiscovery.ts` replays, and `apiKeyAccess.test.ts` sends a real
 * API key to every documented route to prove the result.
 *
 * An API key is a company credential. `requireAuth` accepts one only below
 * `/api/companies/{cid}` for the company it was minted for (`tryBearerAuth`),
 * so every account-level and instance-level route is browser-only no matter
 * which guards it uses.
 */

export type SessionOnlyReason =
  /** `requireBrowserSession` runs: the action needs a person at a browser. */
  | "browserSession"
  /** `requireMasterAdmin` runs: instance administration. */
  | "masterAdmin"
  /** The route is outside `/api/companies/{cid}`, where no API key is accepted. */
  | "accountLevel";

export type RouteAccess = {
  /** `requireAuth` runs, so the route needs a session or an API key. */
  authenticated: boolean;
  /** A Bearer API key for the company in the path can call it. */
  apiKey: boolean;
  /**
   * `requireApiKeyAuth` runs: an API key is the only way in, and a browser
   * session is never read. Set only when true.
   */
  apiKeyOnly?: true;
  /** Why a browser session is the only way in, when it is. */
  sessionOnly?: SessionOnlyReason;
  /** `requireCompanyMember` runs: the caller must belong to the company in the path. */
  companyMember: boolean;
  /** The least company role that may call it, when a role gate applies. */
  minimumRole?: Role;
  /** The Finance access a Member needs, when a Finance gate applies. */
  financeAccess?: "read" | "full";
  /** Conditions under which an otherwise API-key-friendly route still needs a browser. */
  browserSessionRequiredTo: string[];
};

const COMPANY_PATH = /^\/api\/companies\/\{[^}]+\}(?:\/|$)/;

const MUTATING = new Set(["post", "put", "patch", "delete"]);

/** Resolve `onRoutePaths` wrappers to the guard they run on this path, or null when they skip it. */
function effectiveGuard(handle: unknown, path: string): unknown {
  let current = handle;
  for (let depth = 0; depth < 8; depth++) {
    const metadata = routeMetadataOf(current);
    if (metadata?.kind !== "pathScoped") return current;
    if (!matchesRoutePath(path, metadata.matchers)) return null;
    current = metadata.middleware;
  }
  return current;
}

function stricter(current: Role | undefined, candidate: Role): Role {
  return current && roleAtLeast(candidate, current) ? current : candidate;
}

/** Classify a discovered route's authorization from the guards in front of it. */
export function accessOf(
  route: Pick<DiscoveredRoute, "method" | "path" | "chain" | "handlers" | "routePath">,
): RouteAccess {
  const links = [
    ...route.chain,
    ...route.handlers.map((handle) => ({ handle, path: route.routePath })),
  ];
  let authenticated = false;
  let apiKeyOnly = false;
  let browserSession = false;
  let masterAdmin = false;
  let companyMember = false;
  let minimumRole: Role | undefined;
  let financeAccess: "read" | "full" | undefined;
  const browserSessionRequiredTo: string[] = [];

  for (const link of links) {
    const guard = effectiveGuard(link.handle, link.path);
    if (!guard) continue;
    if (guard === requireAuth) authenticated = true;
    else if (guard === requireApiKeyAuth) {
      authenticated = true;
      apiKeyOnly = true;
    } else if (guard === requireBrowserSession) browserSession = true;
    else if (guard === requireMasterAdmin) masterAdmin = true;
    else if (guard === requireCompanyMember) companyMember = true;
    else if (guard === requireFinanceWrite) financeAccess = "full";
    else if (guard === requireFinanceRead) financeAccess ??= "read";
    const metadata = routeMetadataOf(guard);
    if (metadata?.kind === "companyRole") {
      if (!metadata.mutationsOnly || MUTATING.has(route.method)) {
        minimumRole = stricter(minimumRole, metadata.minimum);
      }
    } else if (metadata?.kind === "conditionalBrowserSession") {
      if (!browserSessionRequiredTo.includes(metadata.when))
        browserSessionRequiredTo.push(metadata.when);
    } else if (metadata?.kind === "browserSessionOnly") {
      browserSession = true;
    }
  }

  let sessionOnly: SessionOnlyReason | undefined;
  if (authenticated) {
    if (masterAdmin) sessionOnly = "masterAdmin";
    else if (!COMPANY_PATH.test(route.path)) sessionOnly = "accountLevel";
    else if (browserSession) sessionOnly = "browserSession";
  }
  return {
    authenticated,
    apiKey: authenticated && !sessionOnly,
    ...(apiKeyOnly && !sessionOnly ? { apiKeyOnly: true as const } : {}),
    ...(sessionOnly ? { sessionOnly } : {}),
    companyMember,
    ...(minimumRole && minimumRole !== "member" ? { minimumRole } : {}),
    ...(financeAccess ? { financeAccess } : {}),
    browserSessionRequiredTo: sessionOnly ? [] : browserSessionRequiredTo,
  };
}

/** The OpenAPI `security` requirement for an access classification. */
export function securityFor(access: RouteAccess): Record<string, string[]>[] {
  if (!access.authenticated) return [];
  if (access.apiKeyOnly) return [{ bearerAuth: [] }];
  return access.apiKey ? [{ bearerAuth: [] }, { cookieAuth: [] }] : [{ cookieAuth: [] }];
}

/** One paragraph on who may call the operation, appended to its description. */
export function accessDescription(access: RouteAccess, path: string): string {
  const sentences: string[] = [];
  if (!access.authenticated) {
    sentences.push(
      /\{token\}/.test(path)
        ? "Public: the token in the path is the credential, so no session or API key is needed."
        : "Public: no session or API key is needed.",
    );
  } else if (access.sessionOnly === "masterAdmin") {
    sentences.push(
      "Instance administration: needs a master admin's signed-in browser session. API keys are refused.",
    );
  } else if (access.sessionOnly === "accountLevel") {
    sentences.push(
      "Account-level: needs a signed-in browser session. API keys only work below `/api/companies/{cid}`.",
    );
  } else if (access.sessionOnly === "browserSession") {
    sentences.push("Needs a signed-in browser session. API keys are refused with 403.");
  } else if (access.apiKeyOnly) {
    sentences.push(
      "Needs an API key for this company (`Authorization: Bearer gen_…`). A browser session is never read, so a cookie alone is refused with 401.",
    );
  } else {
    sentences.push(
      "Accepts an API key for this company (`Authorization: Bearer gen_…`) or a signed-in browser session.",
    );
  }
  if (access.authenticated && access.companyMember) {
    sentences.push("The caller must be a Member of the company.");
  }
  if (access.minimumRole) {
    sentences.push(`Needs the ${access.minimumRole} company role or higher.`);
  }
  if (access.financeAccess) {
    sentences.push(
      access.financeAccess === "full" ? "Needs full Finance access." : "Needs Finance read access.",
    );
  }
  for (const when of access.browserSessionRequiredTo) {
    sentences.push(
      `A signed-in browser session is required ${when}; API keys are refused for that.`,
    );
  }
  return `**Access.** ${sentences.join(" ")}`;
}

/** Machine-readable access, for generated clients deciding what to offer. */
export function accessExtension(access: RouteAccess): Record<string, unknown> {
  return {
    apiKey: access.apiKey,
    browserSession: access.authenticated && !access.apiKeyOnly,
    ...(access.sessionOnly ? { sessionOnly: access.sessionOnly } : {}),
    ...(access.minimumRole ? { minimumRole: access.minimumRole } : {}),
    ...(access.financeAccess ? { financeAccess: access.financeAccess } : {}),
    ...(access.browserSessionRequiredTo.length
      ? { browserSessionRequiredTo: access.browserSessionRequiredTo }
      : {}),
  };
}
