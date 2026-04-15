import "reflect-metadata";
import express from "express";
import cookieSession from "cookie-session";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { initDb } from "./db/datasource.js";
import { bootCron } from "./services/cron.js";
import { errorHandler } from "./middleware/error.js";
import { authRouter } from "./routes/auth.js";
import { companiesRouter } from "./routes/companies.js";
import { invitationsRouter } from "./routes/invitations.js";
import { employeesRouter } from "./routes/employees.js";
import { skillsRouter } from "./routes/skills.js";
import { routinesRouter } from "./routes/routines.js";
import { modelsRouter, modelsOverviewRouter } from "./routes/models.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  await initDb();
  await bootCron();

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

  app.use("/api/auth", authRouter);
  app.use("/api/companies", companiesRouter);
  app.use("/api/invitations", invitationsRouter);
  // Nested under /api/companies/:cid/...
  app.use("/api/companies/:cid/employees", employeesRouter);
  app.use("/api/companies/:cid", skillsRouter);
  app.use("/api/companies/:cid", routinesRouter);
  // Per-employee model (one-to-one with AIEmployee). See ROADMAP §5.
  app.use("/api/companies/:cid/employees/:eid/model", modelsRouter);
  // Read-only company-wide overview.
  app.use("/api/companies/:cid/models", modelsOverviewRouter);

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
