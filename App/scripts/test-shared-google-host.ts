/** Real Admin Runtime + broker routes on one server, two browser origins.
 * Uses an in-memory database and intercepted Google responses only.
 * Run with Node 22: node node_modules/tsx/dist/cli.mjs scripts/test-shared-google-host.ts
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { User } from "../server/db/entities/User";
import { errorHandler } from "../server/middleware/error";
import { securityHeaders } from "../server/middleware/httpSecurity";
import { adminRouter } from "../server/routes/admin";
import { connectSignInRouter } from "../server/routes/connectSignIn";
import { saveOauthApp } from "../server/services/oauthApps";
import { getPublicUrl, setPublicUrl } from "../server/services/publicUrl";
import {
  getRuntimeOauthSettings,
  resetRuntimeSettingsCacheForTests,
} from "../server/services/runtimeSettings";
import { closeTestDb, initTestDb, insert } from "../server/test/dbHarness";
import { persistTestSession } from "../server/test/userSession";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const realFetch = globalThis.fetch;
const googleCalls: URLSearchParams[] = [];
const brokerCookies: string[] = [];
const consentHeaders: Array<{
  origin: string | undefined;
  fetchSite: string | undefined;
  hasCookie: boolean;
}> = [];
const browserErrors: string[] = [];
const verifier = crypto.randomBytes(32).toString("base64url");
const proof = crypto.randomBytes(32).toString("base64url");
const digest = (value: string) => crypto.createHash("sha256").update(value).digest("base64url");
let started: { authorizeUrl: string; requestId: string };

await initTestDb();
resetRuntimeSettingsCacheForTests();
const operator = await insert(User, {
  email: "operator@example.test",
  name: "Operator",
  passwordHash: "fixture",
  sessionVersion: 0,
  isMasterAdmin: true,
  emailVerifiedAt: new Date(),
});
const app = express();
const server = createHttpServer(app);
const dev = await createServer({
  configFile: path.join(root, "vite.config.ts"),
  server: { middlewareMode: true, hmr: { server } },
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
  cacheDir: path.join(root, "node_modules/.vite-shared-google-host"),
});
app.use(securityHeaders);
app.use(express.json({ limit: "1mb" }));
// An authenticated operator fixture; the real admin middleware and schemas run.
app.use(
  "/api/admin",
  async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = { userId: operator.id, sessionVersion: 0 };
    await persistTestSession(req);
    next();
  },
  adminRouter,
);
app.use(
  "/api/connect",
  (req, _res, next) => {
    brokerCookies.push(req.headers.cookie ?? "");
    if (req.method === "POST" && req.path === "/google/authorize") {
      consentHeaders.push({
        origin: req.get("origin"),
        fetchSite: req.get("sec-fetch-site"),
        hasCookie: Boolean(req.headers.cookie),
      });
    }
    next();
  },
  connectSignInRouter,
);
app.get("/__runtime", async (_req, res) => {
  res
    .type("html")
    .send(
      await dev.transformIndexHtml(
        "/__runtime",
        '<!doctype html><html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"><div id="root"></div>' +
          `<script type="module" src="/@fs${root}/scripts/sharedGoogleHostHarness.tsx"></script></html>`,
      ),
    );
});
app.get("/__opener", (_req, res) => {
  res.type("html").send(`<!doctype html><html><button id="connect">Connect Gmail</button><script>
    let popup;
    document.getElementById("connect").onclick=()=>{popup=window.open(${JSON.stringify(started.authorizeUrl)});};
    window.addEventListener("message",event=>{
      if(event.source===popup && event.origin===${JSON.stringify(brokerOrigin)} && event.data?.source==="genosyn-sign-in-ready" && event.data.requestId===${JSON.stringify(started.requestId)})
        popup.postMessage({source:"genosyn-sign-in-launch",requestId:${JSON.stringify(started.requestId)},proof:${JSON.stringify(proof)}},event.origin);
    });
  </script></html>`);
});
app.use(dev.middlewares);
app.use(errorHandler);
server.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const port = (server.address() as AddressInfo).port;
const appOrigin = `http://127.0.0.1:${port}`;
const brokerOrigin = `http://localhost:${port}`;
await setPublicUrl(appOrigin);
await saveOauthApp("google", { clientId: "shared-client", clientSecret: "fixture-secret" });
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url === "https://oauth2.googleapis.com/token") {
    googleCalls.push(new URLSearchParams(String(init?.body)));
    return Response.json({
      access_token: "fixture-access",
      refresh_token: "fixture-refresh",
      token_type: "Bearer",
      expires_in: 3600,
      scope:
        "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.settings.basic",
    });
  }
  if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
    return Response.json({ email: "member@gmail.com", email_verified: true });
  }
  throw new Error("Unexpected external request in shared-host browser check");
};
const browser = await chromium.launch({
  channel: process.env.GENOSYN_TEST_BROWSER ?? "chrome",
  headless: true,
});
try {
  const runtimeSettings = await realFetch(`${appOrigin}/api/admin/runtime-settings`);
  assert.equal(runtimeSettings.status, 200, "The fixture operator must pass real admin auth");
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route("**/*", (route) => {
    const hostname = new URL(route.request().url()).hostname;
    return ["localhost", "127.0.0.1"].includes(hostname) ? route.continue() : route.abort();
  });
  await context.addCookies([
    { name: "genosyn.sid", value: "app-session-fixture", url: appOrigin, httpOnly: true },
  ]);
  context.on("page", (page) => page.on("pageerror", (error) => browserErrors.push(error.message)));
  const page = await context.newPage();
  await page.goto(`${appOrigin}/__runtime`, { waitUntil: "commit" });
  const host = page.getByRole("textbox", { name: "Hosted sign-in address", exact: true });
  // Vite compiles the real admin screen and its styles on the first request.
  // Keep the ordinary interaction deadlines once the fixture has mounted.
  await host.waitFor({ timeout: 180_000 });
  const form = page.locator("form").filter({ has: host });
  await host.fill("https://connect.example.test/invalid-path");
  await form.getByRole("button", { name: "Save changes", exact: true }).click();
  await form.getByText("Invalid runtime settings", { exact: true }).waitFor();
  assert.equal(getRuntimeOauthSettings().hostSignIn, false);
  await host.fill(`${brokerOrigin}/`);
  await page
    .getByRole("checkbox", { name: "Host shared sign-in on this installation", exact: true })
    .check();
  await form.getByRole("button", { name: "Save changes", exact: true }).click();
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/admin/runtime-settings/oauth") && response.status() === 200,
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Enable hosting", exact: true })
    .click();
  await saved;
  await page.reload();
  await host.waitFor();
  assert.equal(await host.inputValue(), brokerOrigin);
  assert.equal(getRuntimeOauthSettings().signInHostUrl, brokerOrigin);
  assert.equal(getRuntimeOauthSettings().hostedSignInUrl, "https://connect.genosyn.com");
  assert.equal(getPublicUrl(), appOrigin);
  await fs.mkdir(path.join(root, "../output/playwright"), { recursive: true });
  await form.screenshot({
    path: path.join(root, "../output/playwright/shared-google-host-settings.png"),
  });

  const start = await realFetch(`${brokerOrigin}/api/connect/google/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      codeChallenge: digest(verifier),
      browserChallenge: digest(proof),
      installationOrigin: appOrigin,
    }),
  });
  assert.equal(start.status, 200);
  started = (await start.json()) as typeof started;
  assert.equal(new URL(started.authorizeUrl).origin, brokerOrigin);
  // Redirected requests can bypass a route matched only against Google's URL.
  // Execute the real consent handler, inspect its Google redirect, then return
  // the mock code without making a browser request to an external service.
  await context.route(`${brokerOrigin}/api/connect/google/authorize`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch({ maxRedirects: 0 });
    if (response.status() !== 303) return route.fulfill({ response });
    assert.equal(response.headers()["referrer-policy"], "no-referrer");
    const consent = new URL(response.headers().location);
    assert.equal(consent.origin, "https://accounts.google.com");
    assert.equal(consent.pathname, "/o/oauth2/v2/auth");
    assert.equal(
      consent.searchParams.get("redirect_uri"),
      `${brokerOrigin}/api/connect/google/callback`,
    );
    const callback = new URL(consent.searchParams.get("redirect_uri")!);
    callback.search = new URLSearchParams({
      state: consent.searchParams.get("state")!,
      code: "fixture-code",
    }).toString();
    return route.fulfill({ response, headers: { ...response.headers(), location: callback.href } });
  });
  await page.goto(`${appOrigin}/__opener`);
  const popupReady = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Connect Gmail", exact: true }).click();
  const popup = await popupReady;
  const proceed = popup.getByRole("button", { name: "Continue with Google", exact: true });
  await proceed.waitFor();
  await popup.getByText(/Opened from your Genosyn installation/).waitFor();
  const flowCookies = (
    await context.cookies(`${brokerOrigin}/api/connect/google/authorize`)
  ).filter((cookie) => cookie.name.startsWith("genosyn_sign_in_google_"));
  assert.ok(flowCookies.length > 0, "Broker nonce cookie must be present on its own host");
  assert.ok(flowCookies.every((cookie) => cookie.domain === "localhost" && cookie.httpOnly));
  await proceed.click();
  if ((await popup.locator("body").innerText()).includes("did not come from the sign-in page")) {
    throw new Error(`Consent form rejected: ${JSON.stringify(consentHeaders)}`);
  }
  await popup
    .getByText("Gmail sign-in is complete. Return to your installation to finish connecting.", {
      exact: true,
    })
    .waitFor();
  const result = await realFetch(`${brokerOrigin}/api/connect/google/poll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId: started.requestId, codeVerifier: verifier }),
  });
  assert.equal(result.status, 200);
  const completed = (await result.json()) as { status: string; credential: { email: string } };
  assert.equal(completed.status, "complete");
  assert.equal(completed.credential.email, "member@gmail.com");
  assert.equal(consentHeaders.length, 1);
  assert.equal(consentHeaders[0].origin, brokerOrigin);
  assert.equal(consentHeaders[0].hasCookie, true);
  // The intercepted consent uses APIRequestContext, which may omit Fetch Metadata.
  assert.notEqual(consentHeaders[0].fetchSite, "cross-site");
  assert.equal(googleCalls[0].get("redirect_uri"), `${brokerOrigin}/api/connect/google/callback`);
  assert.ok(
    brokerCookies.every((cookie) => !cookie.includes("genosyn.sid")),
    "App session must stay on the App host",
  );
  assert.deepEqual(browserErrors, []);
  console.log(
    "Shared-host browser check passed: real settings save/validation, separate-origin consent and callback, isolated cookies, unchanged App URL.",
  );
} catch (error) {
  console.error("Browser errors:", browserErrors);
  for (const failedPage of browser.contexts()[0]?.pages() ?? []) {
    console.error(failedPage.url(), (await failedPage.locator("body").innerText()).slice(0, 2500));
  }
  throw error;
} finally {
  globalThis.fetch = realFetch;
  await browser.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await dev.close();
  await closeTestDb();
}
