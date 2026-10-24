/**
 * Disposable real-app boot for test-mcp-oauth-consent.ts; never reads a
 * developer database. The real router, services and an isolated in-memory
 * SQLite, seeded with Members who sign in through the real login page, behind
 * the production client bundle — so the consent flow runs exactly as an
 * install serves it.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import bcrypt from "bcrypt";
import express from "express";
import { config } from "../config.js";

const testRoot = process.argv[2];
assert(testRoot && path.basename(testRoot).startsWith("genosyn-mcp-oauth-"));
assert.equal(path.dirname(fs.realpathSync(testRoot)), fs.realpathSync(os.tmpdir()));
const port = Number(process.argv[3] ?? "18687");
const uiPort = Number(process.argv[4] ?? "18689");
const clientDir = fileURLToPath(new URL("../dist/client/", import.meta.url));
assert(
  fs.existsSync(path.join(clientDir, "index.html")),
  "Run npm run build:client before the MCP OAuth consent browser suite.",
);
Object.assign(config, {
  dataDir: path.join(testRoot, "data"),
  port,
  sessionSecret: randomBytes(32).toString("hex"),
});
Object.assign(config.db, {
  sqlitePath: path.join(testRoot, "data", "app.sqlite"),
  driver: "sqlite",
});
Object.assign(config.security, {
  encryptionSecret: randomBytes(32).toString("hex"),
  secureCookies: false,
  trustedProxyHops: 1,
});
Object.assign(config.agent.codingTools, { enabled: false, executionMode: "disabled" });

const { initTestDb, insert } = await import("../server/test/dbHarness.js");
await initTestDb();
const { User } = await import("../server/db/entities/User.js");
const { Company } = await import("../server/db/entities/Company.js");
const { Membership } = await import("../server/db/entities/Membership.js");

// The browser-facing origin is the client server below: the MCP endpoint,
// discovery and the authorization endpoint are all reached through it.
const { setPublicUrl } = await import("../server/services/publicUrl.js");
await setPublicUrl(`http://127.0.0.1:${uiPort}`);

const passwordHash = await bcrypt.hash("Consent-QA-password-42", 4);
const owner = await insert(User, {
  email: "morgan@example.test",
  name: "Morgan Lee",
  passwordHash,
  emailVerifiedAt: new Date(),
  sessionVersion: 0,
});
const companies: Record<string, { id: string; slug: string }> = {};
for (const [name, slug, role] of [
  ["Sunwise", "sunwise", "owner"],
  ["Northwind", "northwind", "admin"],
  ["Acme", "acme", "member"],
] as const) {
  const company = await insert(Company, { name, slug, ownerId: owner.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role });
  companies[slug] = { id: company.id, slug };
}
console.log(`[mcp-oauth-companies] ${JSON.stringify(companies)}`);

await import("../server/index.js");

// The production client bundle, with everything the server answers passed
// through: the API, OAuth discovery and the authorization endpoint.
const ui = express();
const passThrough: express.RequestHandler = (req, res) => {
  const upstream = http.request(
    {
      hostname: "127.0.0.1",
      port,
      method: req.method,
      path: req.originalUrl,
      headers: {
        ...req.headers,
        host: `127.0.0.1:${port}`,
        "x-forwarded-host": req.headers.host ?? `127.0.0.1:${uiPort}`,
        "x-forwarded-proto": "http",
      },
    },
    (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    },
  );
  upstream.on("error", () => res.status(502).end());
  req.pipe(upstream);
};
ui.use("/api", passThrough);
ui.use("/.well-known", passThrough);
ui.use("/oauth/authorize", passThrough);
ui.use(express.static(clientDir));
ui.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(clientDir, "index.html")));
await new Promise<void>((resolve) => http.createServer(ui).listen(uiPort, "127.0.0.1", resolve));
console.log(`[mcp-oauth-stage] built client listening on :${uiPort}`);
