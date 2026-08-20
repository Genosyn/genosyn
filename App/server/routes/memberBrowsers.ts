import { Router, type Request } from "express";
import { z } from "zod";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Conversation } from "../db/entities/Conversation.js";
import type { MemberBrowser } from "../db/entities/MemberBrowser.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { recordAudit } from "../services/audit.js";
import { memberBrowserPresence } from "../services/memberBrowserHub.js";
import {
  createMemberBrowser,
  getOwnedMemberBrowser,
  grantMemberBrowser,
  listEmployeeIdsGrantedMemberBrowser,
  listMemberBrowserGrantsForEmployee,
  listMemberBrowsersForOwner,
  memberBrowsersEnabled,
  regeneratePairingCode,
  revokeMemberBrowser,
  revokeMemberBrowserGrant,
  updateMemberBrowser,
} from "../services/memberBrowsers.js";

type ScopedReq = Request<{
  cid: string;
  id?: string;
  employeeId?: string;
  conversationId?: string;
}>;

/**
 * The Member-facing surface for browsers people connect from their own
 * computers. Mounted at `/api/companies/:cid/member-browsers`.
 *
 * Everything here is scoped to `ownerUserId = req.userId`, not to a company
 * role. An admin managing a colleague's laptop is not a feature — the row
 * represents a machine somebody owns, and the only person who can meaningfully
 * consent to an AI driving it is that person. API keys are refused for the
 * same reason the browser-session routes refuse them: this is where a human
 * hands over authority, so it needs a human session.
 */
export const memberBrowsersRouter = Router({ mergeParams: true });
memberBrowsersRouter.use(requireAuth);
memberBrowsersRouter.use(requireCompanyMember);
memberBrowsersRouter.use((req, res, next) => {
  if (req.apiKey) {
    return res.status(403).json({ error: "A logged-in Member is required" });
  }
  if (!memberBrowsersEnabled()) {
    return res.status(404).json({ error: "Member browsers are disabled on this instance" });
  }
  next();
});

function serialize(row: MemberBrowser) {
  const presence = memberBrowserPresence(row.id);
  return {
    id: row.id,
    name: row.name,
    // The stored status is a durable hint; the live socket is the truth, and
    // a stale `online` row after a crash would send people hunting for a
    // browser that is not there.
    status: presence.online ? "online" : row.status === "pending" ? "pending" : "offline",
    paired: Boolean(row.tokenPrefix),
    busy: presence.busy,
    tokenPrefix: row.tokenPrefix,
    allowedHosts: row.allowedHosts,
    approvalRequired: row.approvalRequired,
    // A pre-recording unattended opt-in is not recording consent. Present it
    // as off so the owner has to re-enable it under the current disclosure.
    allowUnattended: row.allowUnattended && Boolean(row.routineRecordingConsentAt),
    routineRecordingConsentAt: row.routineRecordingConsentAt,
    routineRecordingConsentRequired:
      row.allowUnattended && row.routineRecordingConsentAt === null,
    browserVersion: row.browserVersion,
    platform: row.platform,
    agentVersion: presence.agentVersion,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
  };
}

memberBrowsersRouter.get("/", async (req: ScopedReq, res) => {
  const rows = await listMemberBrowsersForOwner(req.params.cid, req.userId!);
  res.json(rows.map(serialize));
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  allowedHosts: z.string().max(10_000).nullable().optional(),
  approvalRequired: z.boolean().optional(),
  allowUnattended: z.boolean().optional(),
});
memberBrowsersRouter.post("/", validateBody(createSchema), async (req: ScopedReq, res) => {
  const body = req.body as z.infer<typeof createSchema>;
  const { browser, pairingCode } = await createMemberBrowser({
    companyId: req.params.cid,
    ownerUserId: req.userId!,
    name: body.name,
    allowedHosts: body.allowedHosts ?? null,
    approvalRequired: body.approvalRequired,
    allowUnattended: body.allowUnattended,
  });
  await recordAudit({
    companyId: req.params.cid,
    actorUserId: req.userId,
    action: "member_browser.create",
    targetType: "member_browser",
    targetId: browser.id,
    targetLabel: browser.name,
  });
  // The code is returned exactly once, here. Nothing stores it in plaintext.
  res.status(201).json({ ...serialize(browser), pairingCode });
});

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    allowedHosts: z.string().max(10_000).nullable().optional(),
    approvalRequired: z.boolean().optional(),
    allowUnattended: z.boolean().optional(),
  })
  .strict();
memberBrowsersRouter.patch("/:id", validateBody(updateSchema), async (req: ScopedReq, res) => {
  const browser = await getOwnedMemberBrowser(req.params.cid, req.userId!, req.params.id!);
  if (!browser) return res.status(404).json({ error: "Browser not found" });
  const body = req.body as z.infer<typeof updateSchema>;
  await updateMemberBrowser(browser.id, body);
  const updated = await getOwnedMemberBrowser(req.params.cid, req.userId!, browser.id);
  res.json(updated ? serialize(updated) : serialize(browser));
});

memberBrowsersRouter.post("/:id/pairing-code", async (req: ScopedReq, res) => {
  const browser = await getOwnedMemberBrowser(req.params.cid, req.userId!, req.params.id!);
  if (!browser) return res.status(404).json({ error: "Browser not found" });
  const pairingCode = await regeneratePairingCode(browser.id);
  await recordAudit({
    companyId: req.params.cid,
    actorUserId: req.userId,
    action: "member_browser.repair",
    targetType: "member_browser",
    targetId: browser.id,
    targetLabel: browser.name,
  });
  res.json({ pairingCode });
});

memberBrowsersRouter.delete("/:id", async (req: ScopedReq, res) => {
  const browser = await getOwnedMemberBrowser(req.params.cid, req.userId!, req.params.id!);
  if (!browser) return res.status(404).json({ error: "Browser not found" });
  await revokeMemberBrowser(browser.id);
  await recordAudit({
    companyId: req.params.cid,
    actorUserId: req.userId,
    action: "member_browser.revoke",
    targetType: "member_browser",
    targetId: browser.id,
    targetLabel: browser.name,
  });
  res.json({ ok: true });
});

// ---------- grants ----------

memberBrowsersRouter.get("/:id/grants", async (req: ScopedReq, res) => {
  const browser = await getOwnedMemberBrowser(req.params.cid, req.userId!, req.params.id!);
  if (!browser) return res.status(404).json({ error: "Browser not found" });
  const employeeIds = await listEmployeeIdsGrantedMemberBrowser(browser.id);
  if (employeeIds.length === 0) return res.json([]);
  const employees = await AppDataSource.getRepository(AIEmployee).findBy(
    employeeIds.map((id) => ({ id })),
  );
  res.json(
    employees.map((employee) => ({
      employeeId: employee.id,
      name: employee.name,
      slug: employee.slug,
      role: employee.role,
    })),
  );
});

const grantSchema = z.object({ employeeId: z.string().uuid() }).strict();
memberBrowsersRouter.post("/:id/grants", validateBody(grantSchema), async (req: ScopedReq, res) => {
  const browser = await getOwnedMemberBrowser(req.params.cid, req.userId!, req.params.id!);
  if (!browser) return res.status(404).json({ error: "Browser not found" });
  const body = req.body as z.infer<typeof grantSchema>;
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: body.employeeId,
    companyId: req.params.cid,
  });
  if (!employee) return res.status(404).json({ error: "AI Employee not found" });
  await grantMemberBrowser({
    companyId: req.params.cid,
    employeeId: employee.id,
    memberBrowserId: browser.id,
  });
  await recordAudit({
    companyId: req.params.cid,
    actorUserId: req.userId,
    action: "member_browser.grant",
    targetType: "member_browser",
    targetId: browser.id,
    targetLabel: browser.name,
    metadata: { employeeId: employee.id },
  });
  res.status(201).json({ ok: true });
});

memberBrowsersRouter.delete("/:id/grants/:employeeId", async (req: ScopedReq, res) => {
  const browser = await getOwnedMemberBrowser(req.params.cid, req.userId!, req.params.id!);
  if (!browser) return res.status(404).json({ error: "Browser not found" });
  const employeeId = req.params.employeeId!;
  await revokeMemberBrowserGrant(employeeId, browser.id);
  await recordAudit({
    companyId: req.params.cid,
    actorUserId: req.userId,
    action: "member_browser.revoke_grant",
    targetType: "member_browser",
    targetId: browser.id,
    targetLabel: browser.name,
    metadata: { employeeId },
  });
  res.json({ ok: true });
});

// ---------- what one employee can reach ----------

/**
 * The browsers this Member could point a chat with this employee at. Used by
 * the chat header picker, so it deliberately answers for the *caller*, not for
 * the company: you can only ever choose your own machine.
 */
memberBrowsersRouter.get("/for-employee/:employeeId", async (req: ScopedReq, res) => {
  const employeeId = req.params.employeeId!;
  const grants = await listMemberBrowserGrantsForEmployee(employeeId);
  const mine = grants.filter(
    ({ browser }) => browser.ownerUserId === req.userId && browser.companyId === req.params.cid,
  );
  res.json(mine.map(({ browser }) => serialize(browser)));
});

// ---------- per-conversation selection ----------

const selectSchema = z.object({ memberBrowserId: z.string().uuid().nullable() }).strict();
memberBrowsersRouter.post(
  "/select/:conversationId",
  validateBody(selectSchema),
  async (req: ScopedReq, res) => {
    const conversationId = req.params.conversationId!;
    const body = req.body as z.infer<typeof selectSchema>;
    const repo = AppDataSource.getRepository(Conversation);
    const conversation = await repo.findOneBy({ id: conversationId });
    if (!conversation) return res.status(404).json({ error: "Conversation not found" });
    // Only the thread's owner chooses its browser, and only among their own.
    if (conversation.ownerUserId !== req.userId) {
      return res.status(403).json({ error: "This conversation belongs to another Member" });
    }
    if (body.memberBrowserId) {
      const browser = await getOwnedMemberBrowser(
        req.params.cid,
        req.userId!,
        body.memberBrowserId,
      );
      if (!browser) return res.status(404).json({ error: "Browser not found" });
    }
    await repo.update({ id: conversationId }, { memberBrowserId: body.memberBrowserId });
    res.json({ ok: true, memberBrowserId: body.memberBrowserId });
  },
);
