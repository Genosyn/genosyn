import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router, type Request } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { BrowserSession } from "../db/entities/BrowserSession.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { mintWsToken } from "../services/realtime.js";
import {
  closeBrowserSession,
  getSessionSnapshot,
} from "../services/browserSessions.js";

type ScopedParams = { cid: string; eid: string; id?: string };
type ScopedReq = Request<ScopedParams>;

/**
 * Public REST surface for the live-view browser-session feature. Mounted
 * under `/api/companies/:cid/employees/:eid/browser-sessions`. Every route
 * sits behind `requireAuth` + `requireCompanyMember`, so the iframe URL we
 * embed in the chat panel piggybacks on the same cookie session that the
 * SPA uses.
 */
export const browserSessionsRouter = Router({ mergeParams: true });
browserSessionsRouter.use(requireAuth);
browserSessionsRouter.use(requireCompanyMember);

function serializeSession(row: BrowserSession) {
  const snap = getSessionSnapshot(row.id);
  return {
    id: row.id,
    employeeId: row.employeeId,
    conversationId: row.conversationId,
    runId: row.runId,
    status: row.status,
    closeReason: row.closeReason,
    pageUrl: snap?.pageUrl ?? row.pageUrl,
    pageTitle: snap?.pageTitle ?? row.pageTitle,
    viewportWidth: row.viewportWidth,
    viewportHeight: row.viewportHeight,
    viewerCount: snap?.viewerCount ?? 0,
    hasMcp: snap?.hasMcp ?? false,
    startedAt: row.startedAt,
    closedAt: row.closedAt,
    createdAt: row.createdAt,
  };
}

// ---------- list / detail ----------

browserSessionsRouter.get("/", async (req: ScopedReq, res) => {
  const cid = req.params.cid;
  const eid = req.params.eid;
  const conversationId = typeof req.query.conversationId === "string" ? req.query.conversationId : null;
  const runId = typeof req.query.runId === "string" ? req.query.runId : null;
  const statusFilter = typeof req.query.status === "string" ? req.query.status.split(",") : null;

  const repo = AppDataSource.getRepository(BrowserSession);
  const qb = repo
    .createQueryBuilder("s")
    .where("s.companyId = :cid", { cid })
    .andWhere("s.employeeId = :eid", { eid })
    .orderBy("s.createdAt", "DESC")
    .limit(20);
  if (conversationId) qb.andWhere("s.conversationId = :conversationId", { conversationId });
  if (runId) qb.andWhere("s.runId = :runId", { runId });
  if (statusFilter && statusFilter.length > 0) {
    qb.andWhere("s.status IN (:...statuses)", { statuses: statusFilter });
  }
  const rows = await qb.getMany();
  res.json(rows.map(serializeSession));
});

browserSessionsRouter.get("/:id", async (req: ScopedReq, res) => {
  const repo = AppDataSource.getRepository(BrowserSession);
  const row = await repo.findOneBy({
    id: req.params.id!,
    companyId: req.params.cid,
    employeeId: req.params.eid,
  });
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(serializeSession(row));
});

// ---------- ws-token mint ----------

browserSessionsRouter.post("/:id/ws-token", async (req: ScopedReq, res) => {
  const repo = AppDataSource.getRepository(BrowserSession);
  const row = await repo.findOneBy({
    id: req.params.id!,
    companyId: req.params.cid,
    employeeId: req.params.eid,
  });
  if (!row) return res.status(404).json({ error: "Not found" });
  if (!req.userId) return res.status(401).json({ error: "Unauthorized" });
  const token = mintWsToken(req.userId, req.params.cid);
  res.json({ token });
});

// ---------- viewer page ----------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWER_DIR = path.resolve(__dirname, "..", "mcp-browser", "viewer");

let cachedViewerHtml: string | null = null;
let cachedViewerJs: string | null = null;

function loadViewerAsset(name: "index.html" | "viewer.js"): string {
  const target = path.join(VIEWER_DIR, name);
  return fs.readFileSync(target, "utf8");
}

function getViewerHtml(): string {
  if (cachedViewerHtml === null) cachedViewerHtml = loadViewerAsset("index.html");
  return cachedViewerHtml;
}

function getViewerJs(): string {
  if (cachedViewerJs === null) cachedViewerJs = loadViewerAsset("viewer.js");
  return cachedViewerJs;
}

browserSessionsRouter.get("/:id/view", (req, res) => {
  // The HTML is fully static — auth happens once on the iframe URL load
  // (cookie-session via `requireAuth`); the inline viewer JS then mints its
  // own short-lived ws-token. Lock the iframe to same-origin embeds.
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
  res.setHeader("Cache-Control", "no-store");
  res.send(getViewerHtml());
});

browserSessionsRouter.get("/:id/view.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(getViewerJs());
});

// ---------- manual close ----------

const closeSchema = z.object({});

browserSessionsRouter.post(
  "/:id/close",
  validateBody(closeSchema),
  async (req: ScopedReq, res) => {
    const repo = AppDataSource.getRepository(BrowserSession);
    const row = await repo.findOneBy({
      id: req.params.id!,
      companyId: req.params.cid,
      employeeId: req.params.eid,
    });
    if (!row) return res.status(404).json({ error: "Not found" });
    await closeBrowserSession(row.id, "manual");
    res.json({ ok: true });
  },
);

