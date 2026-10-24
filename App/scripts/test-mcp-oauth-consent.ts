/**
 * Real Chrome through the OAuth sign-in claude.ai and ChatGPT use to connect
 * to the Genosyn MCP server, against the real app and the production client:
 * an untrusted request stops on Genosyn's own page; an app's request survives
 * sign-in to a consent page that names the app, where it returns, the company
 * and what approving grants; Allow sends a code back that the app exchanges
 * for a token the MCP SDK then works the server with; without a resource the
 * Member picks the company and cannot pick one they may not connect; Deny
 * answers access_denied; Settings → API keys lists the app and disconnecting
 * it stops its token; and the page fits a phone.
 *
 * Run `npm run build:client` first, then `npm run test:mcp-oauth-consent`.
 */
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type Browser, type Page } from "playwright-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CONNECT_APPS_ROLE_REQUIRED } from "../shared/connectedApps";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(appRoot, "../output/playwright");
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-mcp-oauth-"));
const port = 18687;
const uiPort = 18689;
const origin = `http://127.0.0.1:${uiPort}`;
const email = "morgan@example.test";
const password = "Consent-QA-password-42";
await fs.mkdir(output, { recursive: true });
const serverLogPath = path.join(output, "mcp-oauth-consent-server.log");
await fs.writeFile(serverLogPath, "");

const child = spawn(
  process.execPath,
  [
    "--import",
    "tsx",
    "scripts/mcpOauthConsentServer.ts",
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
});
child.stderr.on("data", (chunk) => {
  serverLog += String(chunk);
  appendFileSync(serverLogPath, chunk);
});

async function until(check: () => boolean, description: string, timeout = 300_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (child.exitCode !== null) {
      throw new Error(`App exited (${child.exitCode}) while ${description}: ${serverLog.slice(-6000)}`);
    }
    if (Date.now() > deadline) throw new Error(`Timed out ${description}: ${serverLog.slice(-4000)}`);
    await delay(200);
  }
}

// ── the app being connected: a loopback page its sign-in returns to ──────────

type Returned = { code: string | null; state: string | null; error: string | null; iss: string | null };
const returned: Returned[] = [];
const appServer = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/callback") {
    res.writeHead(404).end();
    return;
  }
  returned.push({
    code: url.searchParams.get("code"),
    state: url.searchParams.get("state"),
    error: url.searchParams.get("error"),
    iss: url.searchParams.get("iss"),
  });
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<!doctype html><title>Back in the app</title><h1>Back in the app</h1>");
});
await new Promise<void>((resolve) => appServer.listen(0, "127.0.0.1", resolve));
const redirectUri = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}/callback`;

async function registerApp(name: string): Promise<string> {
  const response = await fetch(`${origin}/api/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  return ((await response.json()) as { client_id: string }).client_id;
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function authorizeUrl(params: Record<string, string>): string {
  const url = new URL(`${origin}/oauth/authorize`);
  for (const [name, value] of Object.entries({
    response_type: "code",
    redirect_uri: redirectUri,
    code_challenge_method: "S256",
    scope: "mcp",
    ...params,
  })) {
    url.searchParams.set(name, value);
  }
  return url.toString();
}

const mcpUrl = (companyId: string) => `${origin}/api/companies/${companyId}/mcp`;

async function noSidewaysScroll(page: Page, label: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  assert.equal(overflow, false, `${label}: the page does not scroll sideways`);
}

let browser: Browser | undefined;
const pageErrors: string[] = [];
const checks: string[] = [];
function record(message: string) {
  checks.push(message);
  console.log(`PASS ${message}`);
}

try {
  await until(
    () =>
      serverLog.includes(`[genosyn] listening on :${port}`) &&
      serverLog.includes(`[mcp-oauth-stage] built client listening on :${uiPort}`),
    "starting the isolated app",
  );
  const companies = JSON.parse(
    /\[mcp-oauth-companies\] (.+)/.exec(serverLog)![1],
  ) as Record<"sunwise" | "northwind" | "acme", { id: string; slug: string }>;

  browser = await chromium.launch({
    channel: process.env.GENOSYN_TEST_BROWSER ?? "chrome",
    headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  context.setDefaultTimeout(45_000);
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.hostname === "127.0.0.1" || url.protocol === "data:" || url.protocol === "blob:"
      ? route.continue()
      : route.abort();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));

  // 1. A request Genosyn cannot trust stops on its own page, signed out or not.
  const claude = await registerApp("Claude");
  await page.goto(
    authorizeUrl({
      client_id: claude,
      code_challenge: pkce().challenge,
      state: "state-untrusted",
      redirect_uri: "https://attacker.example.test/steal",
    }),
    { waitUntil: "domcontentloaded" },
  );
  await page.getByRole("heading", { name: "This link isn't safe to follow" }).waitFor();
  assert.equal(new URL(page.url()).origin, origin);
  assert.equal(returned.length, 0, "nothing was sent anywhere");
  record("an unregistered redirect URI stops on Genosyn's page, before sign-in");

  // 2. claude.ai's request survives sign-in, and the consent page says what it is.
  const allow = pkce();
  await page.goto(
    authorizeUrl({
      client_id: claude,
      code_challenge: allow.challenge,
      state: "state-allow",
      resource: mcpUrl(companies.sunwise.id),
    }),
    { waitUntil: "domcontentloaded" },
  );
  await page.getByRole("heading", { name: "Welcome back" }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/login");
  await page.getByText("Sign in to finish connecting an app to Genosyn.").waitFor();
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Connect Claude to Genosyn" }).waitFor();
  const appHostText = new URL(redirectUri).host;
  await page.getByText(appHostText, { exact: true }).waitFor();
  await page.getByText("Morgan Lee", { exact: true }).waitFor();
  await page.getByText("Sunwise", { exact: true }).waitFor();
  await page
    .getByText(/Claude can use Genosyn as you in Sunwise — as the owner, with full Finance access/)
    .waitFor();
  await page.getByText(/Only allow this if you started connecting Claude yourself/).waitFor();
  await noSidewaysScroll(page, "consent");
  await page.screenshot({ path: path.join(output, "mcp-oauth-consent.png"), fullPage: true });
  record("signing in returns to the consent page, which names the app, its address and the grant");

  // 3. Allow: the app gets a code, exchanges it, and works the server as Morgan.
  await page.getByRole("button", { name: "Allow", exact: true }).click();
  await page.waitForURL((url) => url.href.startsWith(redirectUri));
  await page.getByRole("heading", { name: "Back in the app" }).waitFor();
  const approved = returned.at(-1)!;
  assert.equal(approved.state, "state-allow");
  assert.equal(approved.error, null);
  assert.equal(approved.iss, origin);
  assert.ok(approved.code);
  const exchanged = await fetch(`${origin}/api/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: approved.code,
      code_verifier: allow.verifier,
      redirect_uri: redirectUri,
      client_id: claude,
      resource: mcpUrl(companies.sunwise.id),
    }),
  });
  assert.equal(exchanged.status, 200, await exchanged.clone().text());
  const tokens = (await exchanged.json()) as { access_token: string; refresh_token: string };
  const mcp = new Client({ name: "consent-suite", version: "1.0.0" });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(mcpUrl(companies.sunwise.id)), {
      requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
    }),
  );
  const me = (await mcp.callTool({ name: "whoami", arguments: {} })) as CallToolResult & {
    structuredContent: Record<string, unknown>;
  };
  await mcp.close();
  assert.equal(me.structuredContent.authentication, "connected_app");
  assert.equal(me.structuredContent.role, "owner");
  assert.equal((me.structuredContent.company as { name: string }).name, "Sunwise");
  assert.equal((me.structuredContent.connectedApp as { name: string }).name, "Claude");
  record("Allow returns a code the app exchanges for a token the MCP SDK uses as Morgan");

  // 4. No resource: Morgan picks the company, cannot pick one they may not
  //    connect, and denies.
  const chatgpt = await registerApp("ChatGPT");
  await page.goto(
    authorizeUrl({ client_id: chatgpt, code_challenge: pkce().challenge, state: "state-deny" }),
    { waitUntil: "domcontentloaded" },
  );
  await page.getByRole("heading", { name: "Connect ChatGPT to Genosyn" }).waitFor();
  const choices = page.getByRole("radio");
  assert.equal(await choices.count(), 3);
  await page.getByLabel("Acme").check();
  await page.getByText(CONNECT_APPS_ROLE_REQUIRED, { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Allow", exact: true }).isDisabled(), true);
  await page.getByLabel("Northwind").check();
  await page.getByText(/in Northwind — as an admin/).waitFor();
  assert.equal(await page.getByRole("button", { name: "Allow", exact: true }).isDisabled(), false);
  await page.screenshot({ path: path.join(output, "mcp-oauth-consent-choose.png"), fullPage: true });
  await page.getByRole("button", { name: "Deny", exact: true }).click();
  await page.waitForURL((url) => url.href.startsWith(redirectUri));
  const denied = returned.at(-1)!;
  assert.equal(denied.error, "access_denied");
  assert.equal(denied.state, "state-deny");
  assert.equal(denied.code, null);
  record("without a resource the Member chooses among companies they may connect; Deny says so");

  // 5. Settings → API keys lists the app; disconnecting it stops its token.
  await page.goto(`${origin}/c/sunwise/settings/api-keys`, { waitUntil: "domcontentloaded" });
  const card = page.locator("div.rounded-xl", {
    has: page.getByRole("heading", { name: "Connected apps", exact: true }),
  });
  await card.getByText("Claude", { exact: true }).waitFor();
  await card.getByText(appHostText, { exact: true }).waitFor();
  await card.getByRole("button", { name: "Disconnect" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Disconnect" }).click();
  await card.getByText("Disconnected", { exact: true }).waitFor();
  const refused = await fetch(mcpUrl(companies.sunwise.id), {
    method: "POST",
    headers: {
      authorization: `Bearer ${tokens.access_token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(refused.status, 401);
  const mcpCard = page.locator("div.rounded-xl", {
    has: page.getByRole("heading", { name: "MCP server", exact: true }),
  });
  const first = mcpCard.getByRole("tab", { name: "claude.ai", exact: true });
  assert.equal(await first.getAttribute("aria-selected"), "true");
  await mcpCard
    .getByRole("tabpanel", { name: "claude.ai setup" })
    .getByText(mcpUrl(companies.sunwise.id), { exact: true })
    .waitFor();
  await page.screenshot({ path: path.join(output, "mcp-oauth-connected-apps.png"), fullPage: true });
  record("Settings → API keys lists the app, and disconnecting it refuses its token at once");

  // 6. On a phone the consent page fits.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    authorizeUrl({
      client_id: claude,
      code_challenge: pkce().challenge,
      state: "state-phone",
      resource: mcpUrl(companies.sunwise.id),
    }),
    { waitUntil: "domcontentloaded" },
  );
  await page.getByRole("heading", { name: "Connect Claude to Genosyn" }).waitFor();
  await noSidewaysScroll(page, "consent on a phone");
  const allowBox = await page.getByRole("button", { name: "Allow", exact: true }).boundingBox();
  assert.ok(allowBox && allowBox.x + allowBox.width <= 390, "Allow is on screen");
  await page.screenshot({ path: path.join(output, "mcp-oauth-consent-phone.png"), fullPage: true });
  record("the consent page fits a phone");

  assert.deepEqual(pageErrors, [], "the pages threw no errors");
  console.log(`\nMCP OAuth consent: ${checks.length} checks passed in real Chrome.`);
} finally {
  await browser?.close();
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => appServer.close(() => resolve()));
  await fs.rm(testRoot, { recursive: true, force: true });
}
