/**
 * Real-browser passwordless passkey regression.
 *
 * Run `npm run build:client` first, then `npm run test:passkey-signin`.
 * The suite boots the existing disposable onboarding server, enrolls a
 * discoverable credential in Chromium's virtual authenticator, signs in with
 * it, and proves the completed assertion cannot be replayed.
 */
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type Browser, type CDPSession, type Page } from "playwright-core";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(appRoot, "../output/playwright");
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-onboarding-fullstack-passkey-"));
const port = 18587;
const uiPort = 18589;
// WebAuthn accepts localhost as a development RP ID, but rejects a numeric IP
// as an invalid domain. The existing test server still binds only to loopback.
const origin = `http://localhost:${uiPort}`;
const serverLogPath = path.join(output, "passkey-signin-server.log");
const browserLogPath = path.join(output, "passkey-signin-browser.log");

await fs.mkdir(output, { recursive: true });
await fs.writeFile(serverLogPath, "");
await fs.writeFile(browserLogPath, "");

const child = spawn(
  process.execPath,
  [
    "--import",
    "tsx",
    "scripts/fullstackOnboardingServer.ts",
    testRoot,
    String(port),
    String(uiPort),
  ],
  {
    cwd: appRoot,
    env: { ...process.env, NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let serverLog = "";
child.stdout.on("data", (chunk) => {
  serverLog += String(chunk);
  appendFileSync(serverLogPath, chunk);
  for (const line of String(chunk).split("\n")) {
    if (line.startsWith("[fullstack-stage]") || line.startsWith("[genosyn] listening")) {
      console.log(line);
    }
  }
});
child.stderr.on("data", (chunk) => {
  serverLog += String(chunk);
  appendFileSync(serverLogPath, chunk);
});

let browser: Browser | undefined;
let page: Page | undefined;
let cdp: CDPSession | undefined;
let authenticatorId: string | undefined;
const consoleErrors: string[] = [];
const checks: string[] = [];
const email = "onboarding-owner@example.test";
const password = "Passkey-QA-password-42";

async function until(check: () => boolean, description: string, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (child.exitCode !== null) {
      throw new Error(
        `App exited (${child.exitCode}) while ${description}: ${serverLog.slice(-6000)}`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out ${description}: ${serverLog.slice(-4000)}`);
    }
    await delay(200);
  }
}

function record(message: string) {
  checks.push(message);
  console.log(`PASS ${message}`);
}

async function go(route: string) {
  await page!.goto(`${origin}${route}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
}

async function currentMember() {
  const response = await page!.request.get(`${origin}/api/auth/me`);
  const text = await response.text();
  assert.equal(response.status(), 200, `/api/auth/me: ${text}`);
  return JSON.parse(text) as { email: string; isMasterAdmin: boolean };
}

try {
  await until(
    () =>
      serverLog.includes(`[genosyn] listening on :${port}`) &&
      serverLog.includes(`[fullstack-stage] built client listening on :${uiPort}`),
    "starting isolated app",
    600_000,
  );

  browser = await chromium.launch({
    channel: process.env.GENOSYN_TEST_BROWSER ?? "chrome",
    headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  context.setDefaultTimeout(45_000);
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.protocol === "data:" ||
      url.protocol === "blob:"
      ? route.continue()
      : route.abort();
  });

  page = await context.newPage();
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      appendFileSync(browserLogPath, `CONSOLE ${message.text()}\n`);
    }
  });
  page.on("requestfailed", (request) => {
    if (request.url().startsWith(origin)) {
      appendFileSync(browserLogPath, `FAILED ${request.url()} ${request.failure()?.errorText}\n`);
    }
  });
  page.on("response", (response) => {
    const request = response.request();
    if (
      response.url().startsWith(`${origin}/api/`) &&
      (request.method() !== "GET" || response.status() >= 400)
    ) {
      appendFileSync(
        browserLogPath,
        `${request.method()} ${response.status()} ${response.url()}\n`,
      );
    }
  });

  cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  const authenticator = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      automaticPresenceSimulation: true,
      isUserVerified: true,
    },
  });
  authenticatorId = authenticator.authenticatorId;
  assert.ok(authenticatorId, "Chromium did not create a virtual passkey authenticator");

  await go("/signup");
  await page.getByLabel("Name", { exact: true }).fill("Passkey Owner");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  const registered = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/auth/signup") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  assert.equal((await registered).status(), 200);
  await page.waitForURL((url) => url.pathname !== "/signup");
  assert.equal((await currentMember()).email, email);

  await until(
    () => /http:\/\/127\.0\.0\.1:\d+\/verify-email\/[a-f0-9]+/.test(serverLog),
    "receiving console verification",
  );
  const verificationLinkFromLog = serverLog.match(
    /http:\/\/127\.0\.0\.1:\d+\/verify-email\/[a-f0-9]+/,
  )![0];
  // Keep the ceremony on the same localhost origin. The server prints the
  // address it was initially seeded with, before operator login captures the
  // browser-facing public URL.
  const verificationLink = verificationLinkFromLog.replace("127.0.0.1", "localhost");
  await page.goto(verificationLink, { waitUntil: "domcontentloaded" });
  await page
    .getByText("Your email is verified. You can continue to Genosyn.", { exact: true })
    .waitFor();
  await page.getByRole("link", { name: "Continue", exact: true }).click();
  await page.getByRole("heading", { name: "Welcome back", exact: true }).waitFor();

  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Set up your company", exact: true }).waitFor();
  assert.equal((await currentMember()).isMasterAdmin, true);
  const publicUrl = await page.request.put(`${origin}/api/admin/instance-settings`, {
    data: { publicUrl: origin },
  });
  assert.equal(publicUrl.status(), 200, await publicUrl.text());
  record("Bootstrap Member verified and signed in with a password");

  await go("/security");
  await page.getByRole("heading", { name: "Security", exact: true }).waitFor();
  await page.getByRole("button", { name: "Add passkey", exact: true }).click();
  const passkeyDialog = page.getByRole("dialog", { name: "Add passkey" });
  await passkeyDialog.getByLabel("Name", { exact: true }).fill("Chromium passkey");
  await passkeyDialog.getByLabel("Current password", { exact: true }).fill(password);
  const enrolled = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/auth/two-factor/webauthn/verify") &&
      response.request().method() === "POST",
  );
  await passkeyDialog.getByRole("button", { name: "Add passkey", exact: true }).click();
  assert.equal((await enrolled).status(), 200);
  await passkeyDialog.getByRole("button", { name: "Done", exact: true }).click();
  await passkeyDialog.waitFor({ state: "hidden" });
  await page.getByText("Chromium passkey", { exact: true }).waitFor();
  record("Discoverable passkey enrolled through Account → Security");

  const logout = await page.request.post(`${origin}/api/auth/logout`);
  assert.equal(logout.status(), 200, await logout.text());
  await go("/login");
  await page.getByRole("heading", { name: "Welcome back", exact: true }).waitFor();

  const optionsResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/auth/login/passkey/options") &&
      response.request().method() === "POST",
  );
  type VerifyBody = {
    flowToken?: string;
    response?: { id?: string; response?: { userHandle?: unknown } };
  };
  let forwardedVerifyBody: VerifyBody | undefined;
  const verifyResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/auth/login/passkey/verify") &&
      response.request().method() === "POST",
  );
  // Some platform authenticators return a valid signed assertion with a null
  // userHandle. SimpleWebAuthn omits that nullable value from its JSON, so
  // delete the field when present and exercise the same wire payload with
  // Chromium's real signature.
  await page.route(
    "**/api/auth/login/passkey/verify",
    async (route) => {
      const body = route.request().postDataJSON() as VerifyBody;
      if (body.response?.response) delete body.response.response.userHandle;
      forwardedVerifyBody = body;
      await route.continue({ postData: JSON.stringify(body) });
    },
    { times: 1 },
  );
  await page.getByRole("button", { name: "Sign in with a passkey", exact: true }).click();

  const optionsResponse = await optionsResponsePromise;
  const optionsText = await optionsResponse.text();
  assert.equal(optionsResponse.status(), 200, optionsText);
  const optionsBody = JSON.parse(optionsText) as {
    options?: { challenge?: string };
    flowToken?: string;
  };
  assert.equal(typeof optionsBody.options?.challenge, "string");
  assert.equal(typeof optionsBody.flowToken, "string");
  assert.ok(optionsBody.flowToken);

  const verifyResponse = await verifyResponsePromise;
  // The client intentionally hard-navigates as soon as this succeeds, which
  // can discard the old document's response body before Playwright reads it.
  assert.equal(verifyResponse.status(), 200);

  const verifyBody = forwardedVerifyBody;
  assert.ok(verifyBody, "The handleless passkey request was not forwarded");
  assert.equal(verifyBody.flowToken, optionsBody.flowToken);
  assert.equal(typeof verifyBody.response?.id, "string");
  assert.equal(verifyBody.response?.response?.userHandle, undefined);
  await page.waitForURL((url) => url.pathname !== "/login");
  const passkeyMember = await currentMember();
  assert.equal(passkeyMember.email, email);
  assert.equal(passkeyMember.isMasterAdmin, true);
  record("A handleless passwordless passkey assertion established an authenticated session");

  const replay = await page.request.post(`${origin}/api/auth/login/passkey/verify`, {
    data: verifyBody,
  });
  const replayText = await replay.text();
  assert.equal(replay.status(), 400, replayText);
  assert.ok(
    typeof (JSON.parse(replayText) as { error?: unknown }).error === "string",
    "Replay failure did not return a safe API error",
  );
  assert.equal((await currentMember()).email, email);
  record("Completed passkey assertion and flow token cannot be replayed");

  assert.deepEqual(consoleErrors, []);
  await page.screenshot({ path: path.join(output, "passkey-signin-summary.png") });
  await fs.writeFile(
    path.join(output, "passkey-signin-results.json"),
    JSON.stringify({ checks, consoleErrors }, null, 2),
  );
  console.log(`Passed ${checks.length} passwordless passkey browser checks.`);
} catch (error) {
  if (page) {
    await page
      .screenshot({ path: path.join(output, "passkey-signin-failure.png") })
      .catch(() => undefined);
    await fs.writeFile(
      path.join(output, "passkey-signin-failure.txt"),
      await page
        .locator("body")
        .innerText()
        .catch(() => ""),
    );
  }
  throw error;
} finally {
  if (cdp && authenticatorId) {
    await cdp
      .send("WebAuthn.removeVirtualAuthenticator", { authenticatorId })
      .catch(() => undefined);
  }
  await cdp?.send("WebAuthn.disable").catch(() => undefined);
  await browser?.close();
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(8000),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
  await fs.writeFile(serverLogPath, serverLog);
  await fs.rm(testRoot, { recursive: true, force: true });
}
