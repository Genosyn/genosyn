/**
 * Connecting Gmail and Calendar through Genosyn Connect, end to end, in a real
 * browser. The App's real form, modal, routes and (in-memory) database run on
 * one origin; the real Genosyn Connect service runs on another, the way
 * connect.genosyn.com and a self-hosted installation do. Only Google is a
 * fixture: its consent page is routed inside the browser, and its token and
 * profile endpoints are answered in-process. No credentials are needed.
 *
 * Needs Connect's dependencies: `npm ci` in ../Connect, then from App/:
 *   npm run test:connect-sign-in [case substring]
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { chromium, type Page } from "playwright-core";
import { createServer } from "vite";
import { createConnectApp } from "../../Connect/src/app";
import { silentLogger } from "../../Connect/src/log";
import { createProviders } from "../../Connect/src/providers/index";
import { createSealer } from "../../Connect/src/secrets";
import { AppDataSource } from "../server/db/datasource";
import { Company } from "../server/db/entities/Company";
import { IntegrationConnection } from "../server/db/entities/IntegrationConnection";
import { MailAccount } from "../server/db/entities/MailAccount";
import { Membership } from "../server/db/entities/Membership";
import { User } from "../server/db/entities/User";
import { errorHandler } from "../server/middleware/error";
import { securityHeaders } from "../server/middleware/httpSecurity";
import { integrationsRouter } from "../server/routes/integrations";
import { integrationsOauthRouter } from "../server/routes/integrationsOauth";
import { mailRouter } from "../server/routes/mail";
import { decryptConnectionConfig } from "../server/services/integrations";
import { resetHostedOauthAvailabilityForTests } from "../server/services/hostedOauth";
import { overrideRuntimeSettingsForTests } from "../server/services/runtimeSettings";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../server/test/dbHarness";
import { persistTestSession } from "../server/test/userSession";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(root, "../output/playwright");
const GOOGLE_CLIENT = {
  clientId: "connect-fixture.apps.googleusercontent.com",
  clientSecret: "connect-fixture-secret",
};
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";

const listen = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );

// ---------- Google, as Genosyn Connect sees it ----------
type Exchange = { code: string; verifier: string; secret: string; redirect: string };
const google = {
  exchanges: [] as Exchange[],
  consents: [] as URLSearchParams[],
  email: "member@gmail.com",
};
const googleFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  if (url === "https://oauth2.googleapis.com/token") {
    const body = new URLSearchParams(String(init?.body));
    google.exchanges.push({
      code: body.get("code") ?? "",
      verifier: body.get("code_verifier") ?? "",
      secret: body.get("client_secret") ?? "",
      redirect: body.get("redirect_uri") ?? "",
    });
    const consent = google.consents.at(-1);
    return Response.json({
      access_token: `google-access-${crypto.randomBytes(6).toString("hex")}`,
      refresh_token: "google-refresh-token",
      expires_in: 3599,
      // Google grants what its consent screen asked for.
      scope: consent?.get("scope") ?? "",
      token_type: "Bearer",
    });
  }
  if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
    return Response.json({ email: google.email, email_verified: true });
  }
  throw new Error(`Unexpected request from Genosyn Connect: ${url}`);
};

// ---------- Genosyn Connect on its own origin, keeping nothing ----------
const connectServer = createHttpServer();
const connectPort = await listen(connectServer);
const connectOrigin = `http://localhost:${connectPort}`;
const connectConfig = {
  port: connectPort,
  listenHost: "127.0.0.1",
  publicUrl: connectOrigin,
  secret: crypto.randomBytes(32).toString("hex"),
  secretIsEphemeral: false,
  trustedProxyHops: 0,
  accessLog: false,
  links: { privacy: null, terms: null },
  google: { ...GOOGLE_CLIENT, scopeGroups: ["gmail", "calendar"] },
};
connectServer.on(
  "request",
  createConnectApp({
    config: connectConfig,
    sealer: createSealer(connectConfig.secret),
    providers: createProviders(connectConfig, { fetch: googleFetch }),
    log: silentLogger,
  }),
);

// ---------- The installation ----------
await initTestDb();
const realFetch = globalThis.fetch;
const gmailCalls: string[] = [];
// The App reaches Genosyn Connect over HTTP for real; Gmail's API is a fixture.
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin === connectOrigin) return realFetch(input, init);
  if (url.origin === "https://gmail.googleapis.com") {
    gmailCalls.push(url.pathname);
    const reply = (value: unknown) => Response.json(value);
    if (url.pathname.endsWith("/profile"))
      return reply({ emailAddress: google.email, historyId: "100" });
    if (url.pathname.endsWith("/labels")) return reply({ labels: [] });
    if (url.pathname.endsWith("/threads")) return reply({ threads: [], resultSizeEstimate: 0 });
    if (url.pathname.endsWith("/history")) return reply({ history: [], historyId: "100" });
    if (url.pathname.endsWith("/drafts")) return reply({ drafts: [], resultSizeEstimate: 0 });
  }
  throw new Error(`Unexpected request from the App: ${url}`);
};

let owner: User;
let company: Company;
const app = express();
const appServer = createHttpServer(app);
const dev = await createServer({
  configFile: path.join(root, "vite.config.ts"),
  server: { middlewareMode: true, hmr: { server: appServer } },
  optimizeDeps: {
    noDiscovery: true,
    include: [
      "react",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "react-dom",
      "react-dom/client",
      "react-router-dom",
      "lucide-react",
    ],
  },
  cacheDir: path.join(root, "node_modules/.vite-connect-sign-in"),
});
// The App's own headers: its COOP keeps the popup's opener for the handshake.
app.use(securityHeaders);
app.use(express.json({ limit: "1mb" }));
// Where Genosyn Connect sends the popup back; before the session, as in the App.
app.use("/api/integrations/oauth", integrationsOauthRouter);
app.use("/api", async (req, _res, next) => {
  req.session = { userId: owner.id, sessionVersion: 0 };
  await persistTestSession(req);
  next();
});
app.use("/api/companies/:cid/integrations", integrationsRouter);
app.use("/api/companies/:cid", mailRouter);
app.use(errorHandler);
app.get("/__connect_sign_in", async (_req, res) => {
  res
    .type("html")
    .send(
      await dev.transformIndexHtml(
        "/__connect_sign_in",
        '<!doctype html><html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"><div id="root"></div>' +
          `<script type="module" src="/@fs${root}/scripts/connectSignInHarness.tsx"></script></html>`,
      ),
    );
});
app.use(dev.middlewares);
const appOrigin = `http://127.0.0.1:${await listen(appServer)}`;

/** Google's consent page, served inside the browser. */
const GOOGLE_PAGE = (
  params: URLSearchParams,
) => `<!doctype html><html><head><title>Sign in - Google Accounts</title></head><body>
  <h1>Google consent fixture</h1><p id="client">${params.get("client_id")}</p><p id="scope">${params.get("scope")}</p>
  <a id="allow" href="${params.get("redirect_uri")}?state=${encodeURIComponent(params.get("state") ?? "")}&code=google-fixture-code&scope=${encodeURIComponent(params.get("scope") ?? "")}&authuser=0&prompt=consent">Allow</a>
  <a id="cancel" href="${params.get("redirect_uri")}?state=${encodeURIComponent(params.get("state") ?? "")}&error=access_denied">Cancel</a>
</body></html>`;

type Case = {
  name: string;
  run: (page: Page) => Promise<void>;
  mode?: "integration";
  mobile?: boolean;
};
const cases: Case[] = [];
const add = (name: string, run: Case["run"], options: Omit<Case, "name" | "run"> = {}) =>
  cases.push({ name, run, ...options });

async function signInFromPopup(
  page: Page,
  start: () => Promise<void>,
  decision: "allow" | "cancel" = "allow",
) {
  const opened = page.waitForEvent("popup");
  await start();
  const popup = await opened;
  // Genosyn Connect's consent page, on its own origin, proven by the opener.
  await popup.waitForURL(`${connectOrigin}/api/connect/google/authorize?requestId=*`);
  await popup.getByText("Opened from your Genosyn installation.", { exact: false }).waitFor();
  const continueButton = popup.getByRole("button", { name: "Continue with Google" });
  assert.equal(await continueButton.isEnabled(), true);
  assert.equal(await popup.locator(".origin").textContent(), appOrigin);
  await popup.screenshot({ path: path.join(output, "connect-consent.png"), fullPage: true });
  await continueButton.click();
  await popup.waitForURL("https://accounts.google.com/**");
  await popup.locator(`#${decision}`).click();
  // Connect sends the popup back to this installation's own page, with the
  // result in the fragment, which the page hands to its server and removes.
  await popup.waitForURL(`${appOrigin}/api/integrations/oauth/hosted/return**`);
  await popup
    .getByRole("heading", { name: decision === "allow" ? "Connected" : "Sign-in could not finish" })
    .waitFor();
  assert.equal(new URL(popup.url()).hash, "", "the fragment leaves the address bar");
  return popup;
}

add(
  "Gmail: an address, one button, Google's consent, and the mailbox is connected",
  async (page) => {
    await page.getByRole("textbox", { name: "Email address" }).fill(google.email);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByText(/Genosyn Connect handles Google sign-in/).waitFor();
    assert.equal(
      await page.locator('input[type="password"]').count(),
      0,
      "no password and no client secret",
    );
    await page.screenshot({
      path: path.join(output, "connect-mailbox-choice.png"),
      fullPage: true,
    });
    await signInFromPopup(page, () =>
      page.getByRole("button", { name: "Continue", exact: true }).click(),
    );
    // The form learns the address from the server afterwards; OAuth reports the mailbox itself.
    await page
      .getByRole("status")
      .getByText("Connected Google mailbox")
      .waitFor({ timeout: 30_000 });
    await page.screenshot({
      path: path.join(output, "connect-mailbox-connected.png"),
      fullPage: true,
    });

    const consent = google.consents.at(-1)!;
    assert.equal(consent.get("client_id"), GOOGLE_CLIENT.clientId);
    assert.equal(consent.get("redirect_uri"), `${connectOrigin}/api/connect/google/callback`);
    assert.equal(consent.get("code_challenge_method"), "S256");
    assert.equal(consent.get("access_type"), "offline");
    assert.deepEqual(consent.get("scope")!.split(" ").sort(), [
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.settings.basic",
      "https://www.googleapis.com/auth/userinfo.email",
      "openid",
    ]);
    const exchange = google.exchanges.at(-1)!;
    assert.equal(
      exchange.secret,
      GOOGLE_CLIENT.clientSecret,
      "only Connect holds the client secret",
    );
    assert.equal(
      crypto.createHash("sha256").update(exchange.verifier).digest("base64url"),
      consent.get("code_challenge"),
    );

    const [connection] = await AppDataSource.getRepository(IntegrationConnection).find();
    const config = decryptConnectionConfig(connection);
    assert.equal(config.credentialSource, "hosted");
    assert.equal(config.tokenBrokerUrl, connectOrigin);
    assert.equal(config.tokenBrokerPath, "/api/connect/google");
    assert.equal("clientSecret" in config, false);
    assert.ok(String(config.scope).includes(GMAIL_SCOPE));
    const [mailbox] = await AppDataSource.getRepository(MailAccount).find();
    assert.equal(mailbox.address, google.email);
    assert.equal(mailbox.connectionId, connection.id);
    assert.ok(gmailCalls.length > 0, "the mailbox talks to Gmail directly");
  },
);

add(
  "cancelling on Google's screen is reported inline, and the form can start again",
  async (page) => {
    await page.getByRole("textbox", { name: "Email address" }).fill(google.email);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByText(/Genosyn Connect handles Google sign-in/).waitFor();
    const popup = await signInFromPopup(
      page,
      () => page.getByRole("button", { name: "Continue", exact: true }).click(),
      "cancel",
    );
    await page
      .getByRole("alert")
      .getByText("Google sign-in was cancelled. Start again when ready.")
      .waitFor({ timeout: 30_000 });
    assert.equal(await AppDataSource.getRepository(IntegrationConnection).count(), 0);
    assert.equal(
      await page.getByRole("button", { name: "Continue", exact: true }).isEnabled(),
      true,
    );
    // The installation may already have closed its popup.
    if (!popup.isClosed()) {
      await popup.getByText("Google sign-in was cancelled. Start again when ready.").waitFor();
    }
  },
);

add("a consent link opened outside the installation cannot continue", async (page) => {
  const started = await realFetch(
    `${appOrigin}/api/companies/${company.id}/integrations/oauth/start`,
    {
      method: "POST",
      headers: { "content-type": "application/json", origin: appOrigin },
      body: JSON.stringify({ provider: "google", label: "Copied link", scopeGroups: ["mail"] }),
    },
  );
  assert.equal(started.status, 200);
  const { authorizeUrl, hostedAttempt } = (await started.json()) as {
    authorizeUrl: string;
    hostedAttempt: string;
  };
  assert.ok(authorizeUrl.startsWith(`${connectOrigin}/api/connect/google/authorize?requestId=`));
  await page.goto(authorizeUrl);
  await page
    .getByText("Return to your Genosyn installation and start again from there.", { exact: false })
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Continue with Google" }).isDisabled(), true);
  await page.screenshot({
    path: path.join(output, "connect-consent-without-installation.png"),
    fullPage: true,
  });
  const cancelled = await realFetch(
    `${appOrigin}/api/companies/${company.id}/integrations/oauth/hosted/cancel`,
    {
      method: "POST",
      headers: { "content-type": "application/json", origin: appOrigin },
      body: JSON.stringify({ attempt: hostedAttempt }),
    },
  );
  assert.equal(cancelled.status, 200);
  assert.equal(google.consents.length, 0, "nobody reached Google");
});

add(
  "Calendar from the Integrations modal: offered by Connect, no client to set up, its own Connection",
  async (page) => {
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await dialog.getByText(/Genosyn Connect handles Google sign-in/).waitFor();
    const scope = (name: string) => dialog.getByRole("checkbox", { name: new RegExp(`^${name} `) });
    assert.equal(await scope("Gmail").isChecked(), true);
    assert.equal(await scope("Calendar").isChecked(), true);
    assert.equal(await scope("Drive").isChecked(), false);
    assert.equal(await dialog.locator('input[type="password"]').count(), 0);
    await scope("Gmail").uncheck();
    await page.screenshot({
      path: path.join(output, "connect-integration-modal.png"),
      fullPage: true,
    });
    const popup = await signInFromPopup(page, () =>
      dialog.getByRole("button", { name: "Connect with Google Workspace" }).click(),
    );
    void popup;
    await page.getByRole("status").getByText("Saved Google Workspace").waitFor({ timeout: 30_000 });
    assert.deepEqual(google.consents.at(-1)!.get("scope")!.split(" ").sort(), [
      CALENDAR_SCOPE,
      "https://www.googleapis.com/auth/userinfo.email",
      "openid",
    ]);
    const [connection] = await AppDataSource.getRepository(IntegrationConnection).find();
    const config = decryptConnectionConfig(connection);
    assert.deepEqual(config.scopeGroups, ["calendar"]);
    assert.equal(config.credentialSource, "hosted");
    assert.equal(await AppDataSource.getRepository(MailAccount).count(), 0);
  },
  { mode: "integration" },
);

add(
  "the consent page fits a phone",
  async (page) => {
    await page.getByRole("textbox", { name: "Email address" }).fill(google.email);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByText(/Genosyn Connect handles Google sign-in/).waitFor();
    const opened = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const popup = await opened;
    await popup.setViewportSize({ width: 390, height: 844 });
    await popup.getByText("Opened from your Genosyn installation.", { exact: false }).waitFor();
    assert.equal(
      await popup.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    await popup.screenshot({
      path: path.join(output, "connect-consent-mobile.png"),
      fullPage: true,
    });
    await popup.close();
  },
  { mobile: true },
);

const browser = await chromium.launch({
  channel: process.env.GENOSYN_TEST_BROWSER ?? "chrome",
  headless: true,
});
let passed = 0;
try {
  await fs.mkdir(output, { recursive: true });
  const filter = process.argv.slice(2).join(" ").toLowerCase();
  const selected = cases.filter((item) => item.name.toLowerCase().includes(filter));
  assert.ok(selected.length, `No case matches ${JSON.stringify(filter)}`);
  for (const item of selected) {
    await resetTestDb();
    resetHostedOauthAvailabilityForTests();
    overrideRuntimeSettingsForTests({
      oauth: { hostedSignInEnabled: true, hostedSignInUrl: connectOrigin },
    });
    owner = await insert(User, {
      email: "owner@example.com",
      name: "Owner",
      passwordHash: "x",
      sessionVersion: 0,
    });
    company = await insert(Company, {
      name: "Connect fixture",
      slug: "connect-fixture",
      ownerId: owner.id,
    });
    await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
    google.consents.length = 0;
    google.exchanges.length = 0;
    gmailCalls.length = 0;

    const errors: string[] = [];
    const unexpected: string[] = [];
    const context = await browser.newContext({
      viewport: item.mobile ? { width: 390, height: 844 } : { width: 1200, height: 900 },
    });
    context.on("page", (opened) => opened.on("pageerror", (error) => errors.push(error.message)));
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === "https://accounts.google.com") {
        google.consents.push(url.searchParams);
        return route.fulfill({ contentType: "text/html", body: GOOGLE_PAGE(url.searchParams) });
      }
      // Playwright does not intercept the hop a redirect leads to, so Connect's
      // real consent POST runs here and its 303 to Google is replayed as a
      // fresh navigation that the fixture above can answer.
      if (
        request.method() === "POST" &&
        request.url() === `${connectOrigin}/api/connect/google/authorize`
      ) {
        const response = await route.fetch({ maxRedirects: 0 });
        if (response.status() !== 303) return route.fulfill({ response });
        const location = response.headers().location;
        assert.ok(location.startsWith("https://accounts.google.com/o/oauth2/v2/auth?"), location);
        const cookies = response
          .headersArray()
          .filter((header) => header.name.toLowerCase() === "set-cookie")
          .map((header) => header.value);
        const callbackCookie = cookies
          .map((cookie) => cookie.split(";")[0].split("="))
          .find(([, value]) => value);
        assert.ok(callbackCookie, "Connect sets the callback cookie on the consenting browser");
        assert.ok(
          cookies.every(
            (cookie) => /HttpOnly/.test(cookie) && /Path=\/api\/connect\/google/.test(cookie),
          ),
        );
        await context.addCookies([
          {
            name: callbackCookie[0],
            value: callbackCookie[1],
            url: `${connectOrigin}/api/connect/google/`,
            httpOnly: true,
            sameSite: "Lax",
          },
        ]);
        return route.fulfill({
          contentType: "text/html",
          body: `<script>location.replace(${JSON.stringify(location)})</script>`,
        });
      }
      if ([appOrigin, connectOrigin].includes(url.origin)) return route.continue();
      unexpected.push(url.toString());
      return route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    page.on("pageerror", (error) => errors.push(error.message));
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("requestfailed", (request) =>
      failedRequests.push(`${request.url()}: ${request.failure()?.errorText}`),
    );
    console.log(`RUN ${item.name}`);
    try {
      await page.goto(
        `${appOrigin}/__connect_sign_in?company=${company.id}${item.mode ? `&mode=${item.mode}` : ""}`,
        { waitUntil: "commit", timeout: 60_000 },
      );
      // Allow the first Vite compilation.
      await page.getByText("Genosyn Connect fixture").waitFor({ timeout: 300_000 });
      await item.run(page);
      assert.deepEqual(errors, [], "no page may throw");
      assert.deepEqual(unexpected, [], "every request stays on the two fixture origins and Google");
      console.log(`PASS ${item.name}`);
      passed++;
    } catch (error) {
      await page
        .screenshot({ path: path.join(output, "connect-sign-in-failure.png"), fullPage: true })
        .catch(() => {});
      await fs.writeFile(
        path.join(output, "connect-sign-in-failure.json"),
        JSON.stringify(
          {
            name: item.name,
            error: String(error),
            errors,
            consoleErrors,
            failedRequests,
            unexpected,
          },
          null,
          2,
        ),
      );
      throw error;
    } finally {
      await context.close();
    }
  }
  console.log(`${passed} Genosyn Connect end-to-end cases passed.`);
} finally {
  await browser.close();
  await dev.close();
  await new Promise<void>((resolve) => appServer.close(() => resolve()));
  await new Promise<void>((resolve) => connectServer.close(() => resolve()));
  globalThis.fetch = realFetch;
  overrideRuntimeSettingsForTests(null);
  await closeTestDb();
}
