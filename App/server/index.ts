import "reflect-metadata";
import express from "express";
import cookieSession from "cookie-session";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { initDb } from "./db/datasource.js";
import { bootCron } from "./services/cron.js";
import { bootBackups } from "./services/backups.js";
import { errorHandler } from "./middleware/error.js";
import { authRouter } from "./routes/auth.js";
import { companiesRouter } from "./routes/companies.js";
import { invitationsRouter } from "./routes/invitations.js";
import { employeesRouter } from "./routes/employees.js";
import { skillsRouter } from "./routes/skills.js";
import { routinesRouter } from "./routes/routines.js";
import { modelsRouter } from "./routes/models.js";
import { employeeSurfaceRouter } from "./routes/employeeSurface.js";
import { projectsRouter } from "./routes/projects.js";
import { approvalsRouter } from "./routes/approvals.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { mcpRouter } from "./routes/mcp.js";
import { secretsRouter } from "./routes/secrets.js";
import { auditRouter } from "./routes/audit.js";
import { usageRouter } from "./routes/usage.js";
import { templatesRouter } from "./routes/templates.js";
import { basesRouter } from "./routes/bases.js";
import { backupsRouter } from "./routes/backups.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  await initDb();
  await bootCron();
  await bootBackups();

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(
    cookieSession({
      name: "genosyn.sid",
      secret: config.sessionSecret,
      maxAge: 1000 * 60 * 60 * 24 * 30,
      httpOnly: true,
      sameSite: "lax",
    }),
  );

  // Public webhooks (token in URL is the credential). Mounted before auth
  // so session-less POSTs from external systems aren't gated.
  app.use("/api/webhooks", webhooksRouter);

  app.use("/api/auth", authRouter);
  app.use("/api/companies", companiesRouter);
  app.use("/api/invitations", invitationsRouter);
  app.use("/api/backups", backupsRouter);
  app.use("/api", templatesRouter);
  // Nested under /api/companies/:cid/...
  app.use("/api/companies/:cid/employees", employeesRouter);
  // Chat + workspace file editor, scoped per employee. Split from the
  // employees CRUD router because these talk to the runner seam + fs, not
  // just the DB.
  app.use("/api/companies/:cid/employees", employeeSurfaceRouter);
  app.use("/api/companies/:cid", skillsRouter);
  app.use("/api/companies/:cid", routinesRouter);
  // Projects + Todos (task manager). See ROADMAP.md V1 backlog.
  app.use("/api/companies/:cid", projectsRouter);
  // Bases (Airtable-style workspaces) — companion to Tasks.
  app.use("/api/companies/:cid", basesRouter);
  app.use("/api/companies/:cid", approvalsRouter);
  app.use("/api/companies/:cid", secretsRouter);
  app.use("/api/companies/:cid", auditRouter);
  app.use("/api/companies/:cid", usageRouter);
  // Per-employee model (one-to-one with AIEmployee). See ROADMAP §5.
  app.use("/api/companies/:cid/employees/:eid/model", modelsRouter);
  app.use("/api/companies/:cid/employees/:eid/mcp", mcpRouter);

  // Client. Dev: mount Vite as middleware so API + UI share one port and
  // HMR still works. Prod: serve the built SPA from dist/client.
  // Layout-wise, dev __dirname=App/server → clientDir=App/client;
  // prod __dirname=App/dist/server → clientDir=App/dist/client.
  const clientDir = path.resolve(__dirname, "..", "client");
  const isDev = process.env.NODE_ENV !== "production";

  if (isDev) {
    const { createServer: createViteServer } = await import("vite");
    // configFile must be explicit: Vite's auto-discovery looks in `root`
    // (client/), but our vite.config.ts lives one level up. Without it,
    // @vitejs/plugin-react is never applied and JSX crashes at runtime.
    const vite = await createViteServer({
      configFile: path.resolve(__dirname, "..", "vite.config.ts"),
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else if (fs.existsSync(clientDir)) {
    app.use(express.static(clientDir));
    app.get(/^\/(?!api).*/, (_req, res) => {
      res.sendFile(path.join(clientDir, "index.html"));
    });
  }

  app.use(errorHandler);

  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[genosyn] listening on :${config.port}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[genosyn] fatal", err);
  process.exit(1);
});
