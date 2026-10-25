import type { Request } from "express";
import { config } from "../../../config.js";
import type { FinanceAccess, Role } from "../../db/entities/Membership.js";
import { usesBearerCredential } from "../../middleware/auth.js";
import { financeAccessFor } from "../../middleware/financeAccess.js";
import { memberBrowsersEnabled } from "../memberBrowsers.js";
import { ACCESS_KIND_META, type AccessKind } from "../../../shared/employeeAccess.js";

/**
 * Who may change which kind of Grant — as the kind's own route decides it.
 *
 * Nothing here is enforced. Every change the Access page makes is replayed
 * through the kind's own route (`bulk.ts`), so the guards that answer are the
 * ones that always have: the router's role gate, the browser-session gate, the
 * Vault's manager check, a Member browser's owner check. These are those rules
 * written out once more, so the listing can say *before* a click why a row
 * cannot change, and a refused replay can be explained in the same words.
 * `routes/employeeAccess.test.ts` holds the two together: for every kind and
 * viewer, a row the listing offers is a row the replay accepts, and a row it
 * locks is one the replay refuses.
 */

/** The person looking at, or changing, one AI Employee's access. */
export type AccessViewer = {
  userId: string;
  role: Role;
  /**
   * Authenticated with a bearer credential — an API key, or a connected app's
   * token on a Genosyn MCP server call — rather than a browser session.
   */
  viaBearer: boolean;
  /** Finance access by the server's own rule: owners and admins always `full`. */
  financeAccess: FinanceAccess;
};

export function accessViewerFrom(req: Request): AccessViewer {
  const role = req.companyRole ?? "member";
  return {
    userId: req.userId!,
    role,
    viaBearer: usesBearerCredential(req),
    financeAccess: financeAccessFor(role, req.membership?.financeAccess),
  };
}

function isAdmin(viewer: AccessViewer): boolean {
  return viewer.role === "owner" || viewer.role === "admin";
}

/**
 * The kinds whose routes refuse a bearer credential outright: the Integrations
 * router (Connections carry credentials), Repositories, the Vault and Member
 * browsers — each guarded by `requireBrowserSession` or its own equivalent.
 */
const BROWSER_SESSION_KINDS: ReadonlySet<AccessKind> = new Set([
  "connection",
  "repository",
  "vault_item",
  "member_browser",
]);

/** The kinds whose Grants only owners and admins change, by their router's role gate. */
const ADMIN_KINDS: ReadonlySet<AccessKind> = new Set([
  "connection",
  "mail_account",
  "calendar",
  "repository",
  "resource_library",
  "routines",
  "finance",
  "revenue",
  "marketing",
  "recruiting",
  "signing",
  "data_room",
]);

export const BROWSER_SESSION_REASON =
  "This needs a signed-in browser session; API keys and connected apps cannot list or change it.";
export const MEMBER_BROWSERS_OFF_REASON = "Member browsers are turned off on this install.";
export const REPOSITORIES_SHARED_REASON =
  "Repositories are read-only in shared SaaS mode, so their Grants cannot change here.";
export const FINANCE_HIDDEN_REASON =
  "You need Finance access to see or change what an AI Employee may do in Finance.";
export const VAULT_MANAGER_REASON =
  "Only the person who added this item, or an owner or admin, can see and change who uses it.";

/** "Only owners and admins can grant Mailboxes." */
export function adminReason(kind: AccessKind): string {
  const meta = ACCESS_KIND_META[kind];
  return meta.scope === "section"
    ? `Only owners and admins can change ${meta.singular} access.`
    : `Only owners and admins can grant ${meta.plural}.`;
}

/** Why only a Member browser's owner can grant it. */
export function memberBrowserOwnerReason(ownerName: string | null): string {
  const who = ownerName?.trim() || "the Member who connected it";
  return `Only ${who} can grant this browser — it runs on their computer.`;
}

/**
 * Why this viewer cannot list the kind at all, or null when it can. Listing
 * follows the same gates as the kind's own reads: an API key reads no
 * Connection, Repository, Vault item or Member browser anywhere else either.
 */
export function kindUnavailableReason(kind: AccessKind, viewer: AccessViewer): string | null {
  if (kind === "member_browser" && !memberBrowsersEnabled()) return MEMBER_BROWSERS_OFF_REASON;
  if (viewer.viaBearer && BROWSER_SESSION_KINDS.has(kind)) return BROWSER_SESSION_REASON;
  return null;
}

/**
 * Why this viewer can change no row of the kind, or null when the answer is
 * per row (a Vault item, a Member browser) or yes.
 */
export function kindChangeReason(kind: AccessKind, viewer: AccessViewer): string | null {
  const unavailable = kindUnavailableReason(kind, viewer);
  if (unavailable) return unavailable;
  if (kind === "finance" && viewer.financeAccess === "none") return FINANCE_HIDDEN_REASON;
  if (ADMIN_KINDS.has(kind) && !isAdmin(viewer)) return adminReason(kind);
  if (kind === "repository" && config.security.multiTenant) return REPOSITORIES_SHARED_REASON;
  return null;
}

/**
 * Whether the viewer may see who holds this kind at all: Finance reads need
 * Finance access, and data rooms are owners' and admins' alone, reads included.
 */
export function kindGrantHidden(kind: AccessKind, viewer: AccessViewer): boolean {
  if (kind === "data_room") return !isAdmin(viewer);
  return kind === "finance" && viewer.financeAccess === "none";
}

/** The Vault's own rule (`isHumanManager`): an owner, an admin, or whoever added the item. */
export function vaultChangeReason(viewer: AccessViewer, canShare: boolean): string | null {
  return kindChangeReason("vault_item", viewer) ?? (canShare ? null : VAULT_MANAGER_REASON);
}

/** A Member browser's own rule: its owner, and nobody else, whatever their role. */
export function memberBrowserChangeReason(
  viewer: AccessViewer,
  ownerUserId: string,
  ownerName: string | null,
): string | null {
  return (
    kindChangeReason("member_browser", viewer) ??
    (ownerUserId === viewer.userId ? null : memberBrowserOwnerReason(ownerName))
  );
}
