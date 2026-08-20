import crypto from "node:crypto";
import { IsNull, Not } from "typeorm";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { BrowserSession } from "../db/entities/BrowserSession.js";
import { Conversation } from "../db/entities/Conversation.js";
import { EmployeeMemberBrowserGrant } from "../db/entities/EmployeeMemberBrowserGrant.js";
import { MemberBrowser } from "../db/entities/MemberBrowser.js";
import { Routine } from "../db/entities/Routine.js";
import { constantTimeEqual } from "../lib/constantTime.js";
import { hashToken } from "../lib/token.js";

/**
 * Ownership, pairing, and policy for {@link MemberBrowser} rows — the Chrome a
 * Member connects from their own computer.
 *
 * Everything a caller needs to answer "may this employee drive this browser
 * right now?" lives here rather than in a route handler, because the answer is
 * re-derived on **every** browser RPC (see `browserAccess.ts`), not snapshotted
 * when the session was minted. Revoking a grant mid-Run has to stop the Run.
 */

/** Pairing codes are one-time and short-lived; 20 bytes is 160 bits. */
const PAIRING_CODE_BYTES = 20;
const PAIRING_CODE_TTL_MS = 10 * 60_000;
/** The bridge bearer. Long-lived, hashed at rest, revocable. */
const BRIDGE_TOKEN_BYTES = 32;

export type MemberBrowserTarget =
  | { kind: "server" }
  | { kind: "member"; browser: MemberBrowser };

export class MemberBrowserError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "MemberBrowserError";
    this.status = status;
  }
}

/** Global kill switch. Multi-tenant installs are refused at boot, not here. */
export function memberBrowsersEnabled(): boolean {
  if (config.security.multiTenant) return false;
  return Boolean(config.agent.memberBrowsersEnabled);
}

function repo() {
  return AppDataSource.getRepository(MemberBrowser);
}
function grantRepo() {
  return AppDataSource.getRepository(EmployeeMemberBrowserGrant);
}

/**
 * Format a code as `XXXX-XXXX-…` so a human can read it off one screen and
 * type it into another without losing their place. The grouping is cosmetic —
 * {@link normalizePairingCode} strips it before hashing, so a paste with or
 * without dashes both work.
 */
function formatPairingCode(raw: string): string {
  return (raw.match(/.{1,8}/g) ?? [raw]).join("-");
}

export function normalizePairingCode(value: string): string {
  return value.trim().replace(/[\s-]/g, "").toLowerCase();
}

/** Create a browser row in `pending` and return the one-time pairing code. */
export async function createMemberBrowser(params: {
  companyId: string;
  ownerUserId: string;
  name: string;
  allowedHosts?: string | null;
  approvalRequired?: boolean;
  allowUnattended?: boolean;
}): Promise<{ browser: MemberBrowser; pairingCode: string }> {
  const pairingCode = crypto.randomBytes(PAIRING_CODE_BYTES).toString("hex");
  const browser = await repo().save(
    repo().create({
      companyId: params.companyId,
      ownerUserId: params.ownerUserId,
      name: params.name,
      status: "pending",
      pairingCodeHash: hashToken(pairingCode),
      pairingCodeExpiresAt: new Date(Date.now() + PAIRING_CODE_TTL_MS),
      allowedHosts: params.allowedHosts ?? null,
      approvalRequired: params.approvalRequired ?? true,
      allowUnattended: params.allowUnattended ?? false,
      routineRecordingConsentAt: params.allowUnattended ? new Date() : null,
    }),
  );
  return { browser, pairingCode: formatPairingCode(pairingCode) };
}

/**
 * Mint a fresh pairing code for an existing browser. Also burns the current
 * bridge token: re-pairing is what a human does when a laptop is lost or a
 * token is suspect, so it must not leave the old one working.
 */
export async function regeneratePairingCode(browserId: string): Promise<string> {
  const pairingCode = crypto.randomBytes(PAIRING_CODE_BYTES).toString("hex");
  await repo().update(
    { id: browserId },
    {
      pairingCodeHash: hashToken(pairingCode),
      pairingCodeExpiresAt: new Date(Date.now() + PAIRING_CODE_TTL_MS),
      tokenHash: null,
      tokenPrefix: null,
      status: "pending",
    },
  );
  return formatPairingCode(pairingCode);
}

/**
 * Exchange a pairing code for the long-lived bridge token. Single use: the
 * code hash is cleared in the same conditional UPDATE that stores the token,
 * so two agents racing the same code cannot both win.
 */
export async function redeemPairingCode(
  rawCode: string,
): Promise<{ browser: MemberBrowser; token: string } | null> {
  const normalized = normalizePairingCode(rawCode);
  if (!normalized) return null;
  const candidate = await repo().findOneBy({ pairingCodeHash: hashToken(normalized) });
  if (!candidate) return null;
  // The lookup above is already an equality match on a hash, so this adds
  // nothing against a remote attacker — it matters if the column is ever
  // scanned instead of indexed, and it costs one comparison.
  if (
    !candidate.pairingCodeHash ||
    !constantTimeEqual(candidate.pairingCodeHash, hashToken(normalized))
  ) {
    return null;
  }
  if (candidate.revokedAt) return null;
  if (!candidate.pairingCodeExpiresAt || candidate.pairingCodeExpiresAt.getTime() < Date.now()) {
    return null;
  }

  const token = crypto.randomBytes(BRIDGE_TOKEN_BYTES).toString("base64url");
  const updated = await repo()
    .createQueryBuilder()
    .update(MemberBrowser)
    .set({
      tokenHash: hashToken(token),
      tokenPrefix: token.slice(0, 8),
      pairingCodeHash: null,
      pairingCodeExpiresAt: null,
      status: "offline",
    })
    .where("id = :id", { id: candidate.id })
    .andWhere('"pairingCodeHash" = :hash', { hash: candidate.pairingCodeHash })
    .execute();
  if (updated.affected !== 1) return null;

  const browser = await repo().findOneBy({ id: candidate.id });
  if (!browser) return null;
  return { browser, token };
}

/** Resolve a bridge bearer to its row. Revoked rows never resolve. */
export async function resolveBridgeToken(token: string): Promise<MemberBrowser | null> {
  const trimmed = token.trim();
  if (!trimmed) return null;
  const row = await repo().findOneBy({ tokenHash: hashToken(trimmed) });
  if (!row) return null;
  if (row.revokedAt) return null;
  return row;
}

export async function markMemberBrowserOnline(
  browserId: string,
  details: { browserVersion?: string | null; platform?: string | null },
): Promise<void> {
  await repo().update(
    { id: browserId },
    {
      status: "online",
      lastSeenAt: new Date(),
      browserVersion: details.browserVersion ?? null,
      platform: details.platform ?? null,
    },
  );
  await pushCurrentPolicyToAgent(browserId);
}

/** The browser's allow list as the agent wants it: trimmed, comments dropped. */
export function parseMemberBrowserAllowList(raw: string | null): string[] {
  return (raw ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * Send the agent its host policy.
 *
 * Must happen on **connect**, not only when a session spawns. The agent starts
 * with an empty allow list and an empty list means "open nothing", so an agent
 * that connects after the chat began — or reconnects after a network blip —
 * would refuse every navigation until the next spawn. Also re-pushed whenever
 * the owner edits the list, so a change takes effect without a restart.
 */
export async function pushCurrentPolicyToAgent(browserId: string): Promise<void> {
  const browser = await repo().findOneBy({ id: browserId });
  if (!browser || browser.revokedAt) return;
  const [{ pushMemberBrowserPolicy }, { getPublicUrl }] = await Promise.all([
    import("./memberBrowserHub.js"),
    import("./publicUrl.js"),
  ]);
  pushMemberBrowserPolicy(browser.id, {
    allowedHosts: parseMemberBrowserAllowList(browser.allowedHosts),
    appOrigin: getPublicUrl(),
  });
}

export async function markMemberBrowserOffline(browserId: string): Promise<void> {
  // Do not resurrect a revoked row into `offline` — revocation is terminal.
  await repo()
    .createQueryBuilder()
    .update(MemberBrowser)
    .set({ status: "offline", lastSeenAt: new Date() })
    .where("id = :id", { id: browserId })
    .andWhere('"revokedAt" IS NULL')
    .execute();
}

export async function listMemberBrowsersForOwner(
  companyId: string,
  ownerUserId: string,
): Promise<MemberBrowser[]> {
  return repo().find({
    where: { companyId, ownerUserId, revokedAt: IsNull() },
    order: { createdAt: "DESC" },
  });
}

export async function listMemberBrowsersForCompany(companyId: string): Promise<MemberBrowser[]> {
  return repo().find({
    where: { companyId, revokedAt: IsNull() },
    order: { createdAt: "DESC" },
  });
}

export async function getOwnedMemberBrowser(
  companyId: string,
  ownerUserId: string,
  browserId: string,
): Promise<MemberBrowser | null> {
  return repo().findOneBy({ id: browserId, companyId, ownerUserId, revokedAt: IsNull() });
}

export async function updateMemberBrowser(
  browserId: string,
  patch: Partial<
    Pick<MemberBrowser, "name" | "allowedHosts" | "approvalRequired" | "allowUnattended">
  >,
): Promise<void> {
  const withdrawsRoutineRecordingConsent = patch.allowUnattended === false;
  await repo().update(
    { id: browserId },
    {
      ...patch,
      ...(patch.allowUnattended === undefined
        ? {}
        : { routineRecordingConsentAt: patch.allowUnattended ? new Date() : null }),
    },
  );
  if (withdrawsRoutineRecordingConsent) {
    await closeRunSessionsForMemberBrowser(browserId);
  }
  // An edited allow list has to reach the machine that enforces it, or the
  // owner would tighten the list in the UI and the agent would keep using the
  // old one until it next reconnected.
  if (patch.allowedHosts !== undefined) await pushCurrentPolicyToAgent(browserId);
}

/**
 * Stop only unattended Run sessions when their owner withdraws recording
 * consent. Chat sessions and the bridge stay connected for interactive use.
 */
export async function closeRunSessionsForMemberBrowser(browserId: string): Promise<void> {
  const sessions = await AppDataSource.getRepository(BrowserSession).find({
    where: [
      {
        memberBrowserId: browserId,
        runId: Not(IsNull()),
        status: "pending",
      },
      {
        memberBrowserId: browserId,
        runId: Not(IsNull()),
        status: "live",
      },
    ],
  });
  const { closeBrowserSessionForPolicy } = await import("./browserAccess.js");
  await Promise.all(sessions.map((session) => closeBrowserSessionForPolicy(session.id)));
}

/**
 * Burn the token, drop every grant, and close anything live. Revocation that
 * only stops the *next* session would leave an already-connected employee
 * driving the browser until an idle timer fired.
 */
export async function revokeMemberBrowser(browserId: string): Promise<void> {
  await repo().update(
    { id: browserId },
    { revokedAt: new Date(), status: "revoked", tokenHash: null, tokenPrefix: null },
  );
  await grantRepo().delete({ memberBrowserId: browserId });
  await AppDataSource.getRepository(Conversation).update(
    { memberBrowserId: browserId },
    { memberBrowserId: null },
  );
  await AppDataSource.getRepository(Routine).update(
    { memberBrowserId: browserId },
    { memberBrowserId: null },
  );
  await closeSessionsForMemberBrowser(browserId);
}

/** Close every live browser session bound to this browser, and its socket. */
export async function closeSessionsForMemberBrowser(browserId: string): Promise<void> {
  const sessions = await AppDataSource.getRepository(BrowserSession).find({
    where: [
      { memberBrowserId: browserId, status: "pending" },
      { memberBrowserId: browserId, status: "live" },
    ],
  });
  const { closeBrowserSessionForPolicy } = await import("./browserAccess.js");
  for (const session of sessions) {
    await closeBrowserSessionForPolicy(session.id);
  }
  const { disconnectMemberBrowser } = await import("./memberBrowserHub.js");
  disconnectMemberBrowser(browserId, "revoked");
}

// ---------- grants ----------

export async function grantMemberBrowser(params: {
  companyId: string;
  employeeId: string;
  memberBrowserId: string;
}): Promise<EmployeeMemberBrowserGrant> {
  const existing = await grantRepo().findOneBy({
    employeeId: params.employeeId,
    memberBrowserId: params.memberBrowserId,
  });
  if (existing) return existing;
  return grantRepo().save(grantRepo().create(params));
}

export async function revokeMemberBrowserGrant(
  employeeId: string,
  memberBrowserId: string,
): Promise<void> {
  await grantRepo().delete({ employeeId, memberBrowserId });
  const sessions = await AppDataSource.getRepository(BrowserSession).find({
    where: [
      { memberBrowserId, employeeId, status: "pending" },
      { memberBrowserId, employeeId, status: "live" },
    ],
  });
  const { closeBrowserSessionForPolicy } = await import("./browserAccess.js");
  for (const session of sessions) {
    await closeBrowserSessionForPolicy(session.id);
  }
}

export async function listMemberBrowserGrantsForEmployee(
  employeeId: string,
): Promise<{ grant: EmployeeMemberBrowserGrant; browser: MemberBrowser }[]> {
  const grants = await grantRepo().findBy({ employeeId });
  if (grants.length === 0) return [];
  const browsers = await repo().findBy(grants.map((g) => ({ id: g.memberBrowserId })));
  const byId = new Map(browsers.map((b) => [b.id, b]));
  const out: { grant: EmployeeMemberBrowserGrant; browser: MemberBrowser }[] = [];
  for (const grant of grants) {
    const browser = byId.get(grant.memberBrowserId);
    if (browser && !browser.revokedAt) out.push({ grant, browser });
  }
  return out;
}

export async function listEmployeeIdsGrantedMemberBrowser(
  memberBrowserId: string,
): Promise<string[]> {
  const grants = await grantRepo().findBy({ memberBrowserId });
  return grants.map((g) => g.employeeId);
}

export async function employeeHasMemberBrowserGrant(
  employeeId: string,
  memberBrowserId: string,
): Promise<boolean> {
  const grant = await grantRepo().findOneBy({ employeeId, memberBrowserId });
  return Boolean(grant);
}

// ---------- selection ----------

/**
 * Which browser a spawn should use, given the human's choice on the Routine or
 * Conversation. Returns `null` for the App-owned Chromium.
 *
 * A choice that no longer authorizes — revoked, un-granted, someone else's, or
 * a Routine on a browser whose owner never allowed unattended use — resolves
 * to `null` here. The caller must distinguish a missing choice from a selected
 * Routine browser that became invalid; `loadBrowserConfig` fails the latter
 * rather than silently switching to the App browser/account.
 */
export async function resolveMemberBrowserForSpawn(params: {
  employeeId: string;
  companyId: string;
  conversationId?: string | null;
  routineId?: string | null;
}): Promise<MemberBrowser | null> {
  if (!memberBrowsersEnabled()) return null;

  let candidateId: string | null = null;
  let unattended = false;
  if (params.routineId) {
    const routine = await AppDataSource.getRepository(Routine).findOneBy({ id: params.routineId });
    candidateId = routine?.memberBrowserId ?? null;
    unattended = true;
  }
  if (!candidateId && params.conversationId) {
    const conversation = await AppDataSource.getRepository(Conversation).findOneBy({
      id: params.conversationId,
    });
    if (conversation?.memberBrowserId) {
      candidateId = conversation.memberBrowserId;
      // A thread whose owner is not the browser's owner must not reach it,
      // even if the row was set before ownership changed.
      const owned = await repo().findOneBy({ id: candidateId });
      if (!owned || !conversation.ownerUserId || owned.ownerUserId !== conversation.ownerUserId) {
        candidateId = null;
      }
    }
  }
  if (!candidateId) return null;

  const browser = await repo().findOneBy({ id: candidateId, companyId: params.companyId });
  if (!browser || browser.revokedAt) return null;
  if (unattended && (!browser.allowUnattended || !browser.routineRecordingConsentAt)) return null;
  if (!(await employeeHasMemberBrowserGrant(params.employeeId, browser.id))) return null;
  return browser;
}

/**
 * Live re-check for a session that is already bound. Unlike
 * {@link resolveMemberBrowserForSpawn} this is consulted on every RPC, so a
 * grant deleted seconds ago stops the very next tool call.
 */
export async function memberBrowserUsableForSession(
  session: BrowserSession,
  employee: AIEmployee,
): Promise<{ ok: true; browser: MemberBrowser } | { ok: false; reason: string }> {
  if (!session.memberBrowserId) return { ok: false, reason: "Session is not bound to a browser" };
  if (!memberBrowsersEnabled()) {
    return { ok: false, reason: "Member browsers are disabled on this instance" };
  }
  const browser = await repo().findOneBy({ id: session.memberBrowserId });
  if (!browser || browser.revokedAt) {
    return { ok: false, reason: "This browser has been disconnected by its owner" };
  }
  if (browser.companyId !== employee.companyId) {
    return { ok: false, reason: "This browser belongs to another company" };
  }
  if (!(await employeeHasMemberBrowserGrant(employee.id, browser.id))) {
    return { ok: false, reason: "This AI Employee is no longer granted access to that browser" };
  }
  if (session.runId && (!browser.allowUnattended || !browser.routineRecordingConsentAt)) {
    // The session carries a Run id, so this is scheduled work by definition —
    // whether or not the Run row can still be read. Looking the row up only to
    // decide would fail open on a deleted or not-yet-committed Run.
    return { ok: false, reason: "That browser is not available to scheduled Routines" };
  }
  return { ok: true, browser };
}

/**
 * Does this URL pass the browser's own allow list?
 *
 * Deliberately stricter than the employee list: an **empty list is refused**.
 * `AIEmployee.browserAllowedHosts` treats empty as unrestricted, which is a
 * defensible default for a throwaway container browser and an indefensible one
 * for a browser sitting on someone's laptop holding their signed-in sessions.
 * The two lists are checked independently and both must pass — glob lists
 * cannot be intersected into a third list.
 */
export function memberBrowserUrlAllowed(
  url: string,
  browser: Pick<MemberBrowser, "allowedHosts" | "name">,
  hostChecker: (url: string, allowList: string[]) => { ok: boolean; reason?: string },
): { ok: true } | { ok: false; reason: string } {
  const allowList = (browser.allowedHosts ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (allowList.length === 0) {
    return {
      ok: false,
      reason:
        `"${browser.name}" has no allowed hosts, so it will not open anything. ` +
        "Its owner sets the list of sites this browser may visit.",
    };
  }
  const verdict = hostChecker(url, allowList);
  if (verdict.ok) return { ok: true };
  return {
    ok: false,
    reason: verdict.reason ?? `That host is not on the allow list for "${browser.name}".`,
  };
}

/** Every non-revoked browser that has ever been paired, for the sweeper. */
export async function listPairedMemberBrowsers(): Promise<MemberBrowser[]> {
  return repo().findBy({ revokedAt: IsNull(), tokenHash: Not(IsNull()) });
}
