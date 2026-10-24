/** Disposable real-app boot for test-employee-access.ts; never reads a developer database. */
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
assert(testRoot && path.basename(testRoot).startsWith("genosyn-employee-access-"));
assert.equal(path.dirname(fs.realpathSync(testRoot)), fs.realpathSync(os.tmpdir()));
const port = Number(process.argv[3]);
const uiPort = Number(process.argv[4]);
assert(port > 0 && uiPort > 0, "Pass free ports for the API and the built client.");
const clientDir = fileURLToPath(new URL("../dist/client/", import.meta.url));
assert(
  fs.existsSync(path.join(clientDir, "index.html")),
  "Run npm run build:client before the Access page browser suite.",
);
Object.assign(config, {
  dataDir: path.join(testRoot, "data"),
  port,
  sessionSecret: randomBytes(32).toString("hex"),
});
Object.assign(config.db, { sqlitePath: path.join(testRoot, "data", "app.sqlite"), driver: "sqlite" });
Object.assign(config.security, {
  encryptionSecret: randomBytes(32).toString("hex"),
  secureCookies: false,
  trustedProxyHops: 1,
  // Nobody here becomes an instance operator: the suite is about a company.
  bootstrapMasterAdminEmail: "operator@example.test",
  multiTenant: false,
});
Object.assign(config.agent.codingTools, { enabled: false, executionMode: "disabled" });

console.log("[access-stage] creating isolated database schema");
const { initTestDb } = await import("../server/test/dbHarness.js");
await initTestDb();
const { setPublicUrl } = await import("../server/services/publicUrl.js");
await setPublicUrl(`http://127.0.0.1:${uiPort}`);

// ── Seed: one company, its owner, a colleague, a new AI Employee, and one or
// two of every grantable thing. Rows go straight in, as the server tests do;
// the Vault and Member browsers go through their services for their crypto.
const { AppDataSource } = await import("../server/db/datasource.js");
const entities = {
  AIEmployee: (await import("../server/db/entities/AIEmployee.js")).AIEmployee,
  Base: (await import("../server/db/entities/Base.js")).Base,
  CalendarAccount: (await import("../server/db/entities/CalendarAccount.js")).CalendarAccount,
  Chart: (await import("../server/db/entities/Chart.js")).Chart,
  Company: (await import("../server/db/entities/Company.js")).Company,
  Dashboard: (await import("../server/db/entities/Dashboard.js")).Dashboard,
  IntegrationConnection: (await import("../server/db/entities/IntegrationConnection.js"))
    .IntegrationConnection,
  MailAccount: (await import("../server/db/entities/MailAccount.js")).MailAccount,
  Membership: (await import("../server/db/entities/Membership.js")).Membership,
  Note: (await import("../server/db/entities/Note.js")).Note,
  Notebook: (await import("../server/db/entities/Notebook.js")).Notebook,
  Repository: (await import("../server/db/entities/Repository.js")).Repository,
  Resource: (await import("../server/db/entities/Resource.js")).Resource,
  User: (await import("../server/db/entities/User.js")).User,
};
async function insert<T extends object>(entity: new () => T, values: Partial<T>): Promise<T> {
  const repo = AppDataSource.getRepository(entity);
  return repo.save(repo.create(values as T));
}
const passwordHash = await bcrypt.hash("Access-QA-password-42", 10);
const owner = await insert(entities.User, {
  email: "access-owner@example.test",
  name: "Olivia Owner",
  passwordHash,
  emailVerifiedAt: new Date(),
  sessionVersion: 0,
});
const colleague = await insert(entities.User, {
  email: "access-colleague@example.test",
  name: "Bob Member",
  passwordHash,
  emailVerifiedAt: new Date(),
  sessionVersion: 0,
});
const company = await insert(entities.Company, {
  name: "Access QA Co",
  slug: "access-qa",
  ownerId: owner.id,
  mission: "Keep every customer's books honest.",
  vision: "Small companies run themselves.",
});
await insert(entities.Membership, { companyId: company.id, userId: owner.id, role: "owner" });
await insert(entities.Membership, { companyId: company.id, userId: colleague.id, role: "member" });
const employee = await insert(entities.AIEmployee, {
  companyId: company.id,
  name: "Ada",
  slug: "ada",
  role: "Operations",
});
const connection = await insert(entities.IntegrationConnection, {
  companyId: company.id,
  provider: "stripe",
  label: "Stripe live",
  authMode: "apikey",
  encryptedConfig: "unused-in-this-suite",
  accountHint: "acct_live_123",
});
await insert(entities.MailAccount, {
  companyId: company.id,
  connectionId: "suite-mail-connection",
  provider: "gmail",
  address: "ops@acme.test",
});
await insert(entities.CalendarAccount, {
  companyId: company.id,
  connectionId: "suite-calendar-connection",
  calendarId: "primary",
  address: "team@acme.test",
  displayName: "Team calendar",
});
await insert(entities.Repository, {
  companyId: company.id,
  name: "Website",
  slug: "website",
  gitUrl: "https://example.test/acme/website.git",
});
const notebook = await insert(entities.Notebook, {
  companyId: company.id,
  title: "Playbooks",
  slug: "playbooks",
});
const refund = await insert(entities.Note, {
  companyId: company.id,
  notebookId: notebook.id,
  title: "Refund policy",
  slug: "refund-policy",
  body: "Refunds within 30 days.",
});
await insert(entities.Note, {
  companyId: company.id,
  notebookId: notebook.id,
  parentId: refund.id,
  title: "Refund exceptions",
  slug: "refund-exceptions",
  body: "Annual plans.",
});
await insert(entities.Note, {
  companyId: company.id,
  notebookId: notebook.id,
  title: "Onboarding checklist",
  slug: "onboarding-checklist",
  body: "Day one.",
});
await insert(entities.Note, {
  companyId: company.id,
  notebookId: notebook.id,
  title: "Retired pricing",
  slug: "retired-pricing",
  body: "In the trash.",
  archivedAt: new Date(),
});
await insert(entities.Base, { companyId: company.id, name: "Leads", slug: "leads" });
await insert(entities.Chart, {
  companyId: company.id,
  title: "MRR",
  slug: "mrr",
  connectionId: connection.id,
});
await insert(entities.Dashboard, { companyId: company.id, title: "Board metrics", slug: "board-metrics" });
await insert(entities.Resource, {
  companyId: company.id,
  title: "Brand guide",
  slug: "brand-guide",
  sourceKind: "text",
  bodyText: "Use the indigo.",
  status: "ready",
});
const { createVaultItem } = await import("../server/services/vault.js");
await createVaultItem({
  companyId: company.id,
  actor: { userId: owner.id, role: "owner" },
  type: "login",
  visibility: "company",
  payload: {
    title: "Stripe dashboard",
    username: "ops@acme.test",
    secret: "s3cret-value",
    websiteUrl: "https://dashboard.stripe.com",
    notes: "",
    totp: null,
    passkeys: [],
    passkeyRegistrationLease: null,
  },
});
const { createMemberBrowser } = await import("../server/services/memberBrowsers.js");
await createMemberBrowser({ companyId: company.id, ownerUserId: owner.id, name: "Work laptop" });
await createMemberBrowser({ companyId: company.id, ownerUserId: colleague.id, name: "Home desktop" });
console.log(
  `[access-seed] ${JSON.stringify({ companyId: company.id, companySlug: company.slug, employeeId: employee.id, employeeSlug: employee.slug })}`,
);

console.log("[access-stage] importing real app server");
await import("../server/index.js");

// Serve the production client bundle through a local proxy, the way the
// onboarding suite does: the API runs the real entrypoint with every guard.
const ui = express();
ui.use("/api", (req, res) => {
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
});
ui.use(express.static(clientDir));
ui.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(clientDir, "index.html")));
await new Promise<void>((resolve) => http.createServer(ui).listen(uiPort, "127.0.0.1", resolve));
console.log(`[access-stage] built client listening on :${uiPort}`);
