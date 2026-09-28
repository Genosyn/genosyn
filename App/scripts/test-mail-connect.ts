/**
 * Real-browser mailbox onboarding regressions. Run npm run test:mail-connect,
 * optionally with a case substring. The React form and discovery are real;
 * account authentication is local fixture data, so no credentials or external
 * Google account are needed and no application database is contacted.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright-core";
import { createServer } from "vite";
import { discoverMailbox } from "../server/services/mail/discovery";
import { googleSignInPage } from "../server/services/googleSignInBroker";
import express from "express";
import { integrationsOauthRouter } from "../server/routes/integrationsOauth";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(root, "../output/playwright");
const base = "/api/companies/company";
type Call = { path: string; body: Record<string, unknown> };
type State = {
  googleReady: boolean;
  discoveryError: boolean;
  oauthError: boolean;
  consentDenied: boolean;
  hosted: boolean;
  hostedComplete: boolean;
  hostedExpired: boolean;
  hostedPollError: boolean;
  brokerLaunchVerified: boolean;
  realDirectCallback: boolean;
  calls: Call[];
};
const fixture = (): State => ({
  googleReady: true,
  discoveryError: false,
  oauthError: false,
  consentDenied: false,
  hosted: false,
  hostedComplete: false,
  hostedExpired: false,
  hostedPollError: false,
  brokerLaunchVerified: false,
  realDirectCallback: false,
  calls: [],
});
let state = fixture();
const unexpected: string[] = [];
const server = await createServer({
  optimizeDeps: {
    noDiscovery: true,
    // This form needs only React and icons. Avoid prebuilding the PDF and
    // document editors used by broader page fixtures before it can render.
    include: [
      "react",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "react-dom",
      "react-dom/client",
      "lucide-react",
    ],
  },
  configFile: path.join(root, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0, hmr: false },
  cacheDir: path.join(root, "node_modules/.vite-mail-connect"),
  plugins: [
    {
      name: "mail-connect-fixture",
      configureServer(dev) {
        const callbackApp = express();
        callbackApp.use("/api/integrations/oauth", integrationsOauthRouter);
        dev.middlewares.use(callbackApp);
        dev.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url ?? "/", "http://fixture");
          if (url.pathname === "/__mail_connect") {
            res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
            const html = await dev.transformIndexHtml(
              url.pathname,
              '<!doctype html><html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"><div id="root"></div>' +
                `<script type="module" src="/@fs${root}/scripts/mailConnectHarness.tsx"></script></html>`,
            );
            res.setHeader("content-type", "text/html");
            res.end(html);
            return;
          }
          if (url.pathname === "/__oauth_popup") {
            res.setHeader("content-type", "text/html");
            const result = {
              source: "genosyn-oauth",
              ok: !state.consentDenied,
              ...(state.consentDenied
                ? { detail: "Google sign-in was cancelled. Try again when ready." }
                : {}),
            };
            res.end(
              `<script>window.opener.postMessage(${JSON.stringify(result)}, window.location.origin);window.close();</script>`,
            );
            return;
          }
          if (url.pathname === "/__hosted_popup") {
            res.setHeader("content-type", "text/html");
            res.setHeader("Cross-Origin-Opener-Policy", "unsafe-none");
            res.setHeader(
              "Content-Security-Policy",
              "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; style-src 'unsafe-inline'; script-src 'nonce-fixture-script'",
            );
            res.end(
              googleSignInPage({
                scriptNonce: "fixture-script",
                form: {
                  requestId: "b".repeat(43),
                  browserNonce: "n".repeat(43),
                  installationOrigin: origin,
                },
              }),
            );
            return;
          }
          if (url.pathname === "/api/google-sign-in/authorize") {
            let raw = "";
            for await (const chunk of req) raw += chunk.toString();
            const body = new URLSearchParams(raw);
            state.brokerLaunchVerified =
              body.get("browserProof") === "p".repeat(43) && req.headers.origin === brokerOrigin;
            assert.ok(
              state.brokerLaunchVerified,
              "The actual broker page must receive the launch proof from its opener",
            );
            state.hostedComplete = true;
            res.setHeader("content-type", "text/html");
            res.end(googleSignInPage({ detail: "Gmail sign-in is complete. Return to Genosyn." }));
            return;
          }
          if (!url.pathname.startsWith("/api/")) return next();
          const json = (value: unknown, status = 200) => {
            res.statusCode = status;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(value));
          };
          let raw = "";
          for await (const chunk of req) raw += chunk.toString();
          const body = JSON.parse(raw || "{}") as Record<string, unknown>;
          state.calls.push({ path: url.pathname, body });
          if (req.method === "POST" && url.pathname === `${base}/mail/connect/discover`) {
            if (state.discoveryError)
              return json({ error: "Mailbox lookup is unavailable. Try again." }, 400);
            const found = await discoverMailbox(String(body.email), {
              resolveMx: async (domain) =>
                domain === "workspace.example" ? ["aspmx.l.google.com"] : [],
              resolveSrv: async () => [],
              fetchAutoconfig: async () => null,
            });
            const { routes, ...rest } = found;
            return json({
              plan: {
                ...rest,
                options: routes.map((route) => ({
                  ...route,
                  ready: route.kind === "imap" || state.googleReady,
                  ...(route.kind === "oauth" && state.hosted ? { hostedSignIn: true } : {}),
                  ...(route.kind === "oauth" && !state.googleReady
                    ? {
                        blockedReason:
                          "No Google OAuth app is registered on this install. Ask an instance admin to add one at Admin → Integrations, then return here to sign in.",
                      }
                    : {}),
                })),
              },
            });
          }
          if (req.method === "POST" && url.pathname === `${base}/integrations/oauth/start`) {
            if (state.oauthError)
              return json({ error: "Google sign-in could not start. Try again." }, 400);
            if (state.realDirectCallback)
              return json({
                authorizeUrl: `${origin}/api/integrations/oauth/callback/google?error=access_denied&error_description=${encodeURIComponent("Denied </script><script>throw new Error('injected')</script>")}`,
              });
            if (state.hosted)
              return json({
                authorizeUrl: `${brokerOrigin}/__hosted_popup?requestId=${"b".repeat(43)}`,
                hostedAttempt: "fixture-attempt",
                hostedBrowserProof: "p".repeat(43),
                expiresAt: Date.now() + (state.hostedExpired ? -1 : 10 * 60_000),
              });
            return json({ authorizeUrl: `${origin}/__oauth_popup` });
          }
          if (req.method === "POST" && url.pathname === `${base}/integrations/oauth/hosted/poll`) {
            if (state.hostedPollError)
              return json(
                { error: "Gmail sign-in is temporarily unavailable. Please try again." },
                503,
              );
            if (!state.hostedComplete) return json({ status: "pending" });
            return json(
              state.consentDenied
                ? {
                    status: "denied",
                    detail: "Google sign-in was cancelled. Try again when ready.",
                  }
                : { status: "complete" },
            );
          }
          if (
            req.method === "POST" &&
            url.pathname === `${base}/integrations/oauth/hosted/cancel`
          ) {
            return json({ ok: true });
          }
          if (req.method === "POST" && url.pathname === `${base}/mail/connect/imap`) {
            return json({ account: { id: "mailbox", address: body.address, provider: "imap" } });
          }
          unexpected.push(`${req.method} ${url.pathname}`);
          return json({ error: "Unexpected fixture request" }, 500);
        });
      },
    },
  ],
});
await server.listen();
const origin = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}`;
const brokerOrigin = `http://localhost:${(server.httpServer!.address() as AddressInfo).port}`;
const browser = await chromium
  .launch({
    channel: process.env.GENOSYN_TEST_BROWSER ?? "chrome",
    headless: true,
  })
  .catch(async (error) => {
    await server.close();
    throw error;
  });
const cases: Array<{
  name: string;
  run: (page: Page) => Promise<void>;
  mobile?: boolean;
  member?: boolean;
}> = [];
const add = (name: string, run: (page: Page) => Promise<void>, options = {}) =>
  cases.push({ name, run, ...options });
const form = (page: Page) => page.getByRole("main");
const proceed = (page: Page) => form(page).getByRole("button", { name: "Continue", exact: true });
async function discover(page: Page, address = "owner@gmail.com") {
  await page.getByRole("textbox", { name: "Email address", exact: true }).fill(address);
  await proceed(page).click();
  await form(page).getByRole("button", { name: "Change", exact: true }).waitFor();
}
async function assertNoPassword(page: Page) {
  assert.equal(await form(page).locator('input[type="password"]').count(), 0);
  assert.equal(
    await form(page).getByRole("button", { name: "Server settings", exact: true }).count(),
    0,
  );
  assert.equal(
    await form(page)
      .getByText(/Sign in with a password/)
      .count(),
    0,
  );
  assert.equal(await form(page).getByRole("button", { name: "Other ways to connect" }).count(), 0);
}

add("Gmail offers only OAuth and connects after successful consent", async (page) => {
  await discover(page);
  await form(page).getByText("Continue with Google", { exact: true }).waitFor();
  await assertNoPassword(page);
  await page.screenshot({
    path: path.join(output, "mail-connect-gmail-desktop.png"),
    fullPage: true,
  });
  await proceed(page).click();
  await page.getByRole("status").getByText("Connected Google mailbox").waitFor();
  assert.deepEqual(
    state.calls.map((call) => call.path),
    [`${base}/mail/connect/discover`, `${base}/integrations/oauth/start`],
  );
  assert.deepEqual(state.calls[1].body, {
    provider: "google",
    label: "owner@gmail.com",
    scopeGroups: ["mail"],
    linkMailbox: true,
  });
});
add("unconfigured Gmail explains admin setup without showing a password fallback", async (page) => {
  state.googleReady = false;
  await discover(page);
  await form(page)
    .getByText(/Admin → Integrations/)
    .waitFor();
  await assertNoPassword(page);
  assert.equal(await proceed(page).count(), 0);
  assert.equal(state.calls.length, 1);
});
for (const address of ["owner@googlemail.com", "owner@workspace.example"]) {
  add(`${address} uses only Google sign-in`, async (page) => {
    await discover(page, address);
    await form(page).getByText("Continue with Google", { exact: true }).waitFor();
    await assertNoPassword(page);
    assert.equal(await proceed(page).count(), 1);
  });
}
add("discovery errors remain inline and the same address can be retried", async (page) => {
  state.discoveryError = true;
  const email = page.getByRole("textbox", { name: "Email address", exact: true });
  await email.fill("owner@gmail.com");
  await proceed(page).click();
  await form(page)
    .getByText("Mailbox lookup is unavailable. Try again.", { exact: true })
    .waitFor();
  assert.equal(await email.inputValue(), "owner@gmail.com");
  state.discoveryError = false;
  await proceed(page).click();
  await form(page).getByText("Continue with Google", { exact: true }).waitFor();
  await assertNoPassword(page);
});
add("failed OAuth startup can be retried without entering an app password", async (page) => {
  state.oauthError = true;
  await discover(page);
  await proceed(page).click();
  await form(page)
    .getByText("Google sign-in could not start. Try again.", { exact: true })
    .waitFor();
  await assertNoPassword(page);
  assert.equal(await proceed(page).isEnabled(), true);
  state.oauthError = false;
  await proceed(page).click();
  await page.getByRole("status").waitFor();
});
add(
  "denied Google consent restores the sign-in button with a useful inline error",
  async (page) => {
    state.consentDenied = true;
    await discover(page);
    await proceed(page).click();
    await form(page)
      .getByText("Google sign-in was cancelled. Try again when ready.", { exact: true })
      .waitFor();
    await assertNoPassword(page);
    assert.equal(await proceed(page).isEnabled(), true);
    state.consentDenied = false;
    await proceed(page).click();
    await page.getByRole("status").waitFor();
  },
);
add("blocked popups explain the retry and keep Google as the only choice", async (page) => {
  await discover(page);
  await page.evaluate(() => {
    window.open = () => null;
  });
  await proceed(page).click();
  await form(page)
    .getByText("Popup blocked — allow popups for this site and try again.", { exact: true })
    .waitFor();
  await assertNoPassword(page);
  assert.equal(await proceed(page).isEnabled(), true);
});
add(
  "hosted Gmail connects from a private installation without a registered client",
  async (page) => {
    state.hosted = true;
    await discover(page);
    await assertNoPassword(page);
    await form(page)
      .getByText(/Genosyn handles Google sign-in/)
      .waitFor();
    await page.screenshot({
      path: path.join(output, "mail-connect-hosted-gmail.png"),
      fullPage: true,
    });
    const opened = page.waitForEvent("popup");
    await proceed(page).click();
    const popup = await opened;
    await popup.getByRole("button", { name: "Continue with Google" }).waitFor();
    assert.equal(new URL(popup.url()).origin, brokerOrigin);
    await popup.screenshot({
      path: path.join(output, "mail-connect-hosted-broker.png"),
      fullPage: true,
    });
    await form(page).getByRole("status").getByText("Waiting for Google sign-in…").waitFor();
    // A forged same-origin message is not proof that the hosted flow completed.
    await page.evaluate(() =>
      window.postMessage({ source: "genosyn-oauth", ok: true }, window.location.origin),
    );
    assert.equal(
      await form(page).getByText("Connected Google mailbox", { exact: true }).count(),
      0,
    );
    await popup.getByRole("button", { name: "Continue with Google" }).click();
    await form(page).getByRole("status").getByText("Connected Google mailbox").waitFor();
    const start = state.calls.find((call) => call.path.endsWith("/oauth/start"))!;
    assert.equal(start.body.clientId, undefined);
    assert.equal(start.body.clientSecret, undefined);
    assert.ok(state.calls.some((call) => call.path.endsWith("/hosted/poll")));
    assert.equal(state.brokerLaunchVerified, true);
    assert.ok(state.calls.every((call) => !JSON.stringify(call.body).includes("refreshToken")));
  },
);
add(
  "direct OAuth callback executes under its production CSP and escapes provider text",
  async (page) => {
    state.realDirectCallback = true;
    await discover(page);
    await proceed(page).click();
    await form(page)
      .getByText("Denied </script><script>throw new Error('injected')</script>", { exact: true })
      .waitFor();
    assert.equal(await proceed(page).isEnabled(), true);
  },
);
add("hosted Gmail cancellation stops polling and permits another sign-in", async (page) => {
  state.hosted = true;
  await discover(page);
  await proceed(page).click();
  await form(page).getByRole("button", { name: "Cancel sign-in" }).click();
  await proceed(page).waitFor({ state: "visible" });
  assert.equal(await proceed(page).isEnabled(), true);
  assert.ok(state.calls.some((call) => call.path.endsWith("/hosted/cancel")));
  const opened = page.waitForEvent("popup");
  await proceed(page).click();
  await (await opened).getByRole("button", { name: "Continue with Google" }).click();
  await form(page).getByRole("status").getByText("Connected Google mailbox").waitFor();
});
add("hosted Gmail refuses a sign-in page opened without its installation", async (page) => {
  const standalone = await page.context().newPage();
  await standalone.goto(`${brokerOrigin}/__hosted_popup?requestId=${"b".repeat(43)}`);
  assert.equal(
    await standalone.getByRole("button", { name: "Continue with Google" }).isEnabled(),
    false,
  );
  await standalone.evaluate(() =>
    window.postMessage(
      {
        source: "genosyn-google-sign-in-launch",
        requestId: "b".repeat(43),
        proof: "p".repeat(43),
      },
      window.location.origin,
    ),
  );
  assert.equal(
    await standalone.getByRole("button", { name: "Continue with Google" }).isEnabled(),
    false,
  );
  assert.equal(state.brokerLaunchVerified, false);
  await standalone.close();
});
add("hosted Gmail denial stays inline and can be retried", async (page) => {
  state.hosted = true;
  state.consentDenied = true;
  await discover(page);
  const opened = page.waitForEvent("popup");
  await proceed(page).click();
  await (await opened).getByRole("button", { name: "Continue with Google" }).click();
  await form(page)
    .getByText("Google sign-in was cancelled. Try again when ready.", { exact: true })
    .waitFor();
  assert.equal(await proceed(page).isEnabled(), true);
  await assertNoPassword(page);
});
add("hosted Gmail expiry restores the form", async (page) => {
  state.hosted = true;
  state.hostedExpired = true;
  await discover(page);
  await proceed(page).click();
  await form(page).getByText("Sign-in timed out. Please try again.", { exact: true }).waitFor();
  assert.equal(await proceed(page).isEnabled(), true);
});
add("hosted Gmail service errors stay inline", async (page) => {
  state.hosted = true;
  state.hostedPollError = true;
  await discover(page);
  await proceed(page).click();
  await form(page)
    .getByText("Gmail sign-in is temporarily unavailable. Please try again.", { exact: true })
    .waitFor();
  assert.equal(await proceed(page).isEnabled(), true);
});
add("other services still connect with a password and discovered servers", async (page) => {
  await discover(page, "owner@fastmail.com");
  await page.getByLabel("Password", { exact: true }).fill("fixture-app-password");
  await form(page).getByRole("button", { name: "Server settings", exact: true }).click();
  assert.equal(
    await page.getByLabel("IMAP server", { exact: true }).inputValue(),
    "imap.fastmail.com",
  );
  assert.equal(
    await page.getByLabel("SMTP server", { exact: true }).inputValue(),
    "smtp.fastmail.com",
  );
  await form(page).getByRole("button", { name: "Connect mailbox", exact: true }).click();
  await page.getByRole("status").getByText("Connected owner@fastmail.com").waitFor();
  assert.deepEqual(state.calls[1].body, {
    address: "owner@fastmail.com",
    password: "fixture-app-password",
    imapHost: "imap.fastmail.com",
    imapPort: 993,
    smtpHost: "smtp.fastmail.com",
    smtpPort: 465,
  });
});
add(
  "changing a password mailbox to Gmail removes password fields on mobile",
  async (page) => {
    await discover(page, "owner@fastmail.com");
    await page.getByLabel("Password", { exact: true }).fill("fixture-app-password");
    await form(page).getByRole("button", { name: "Change", exact: true }).click();
    await discover(page, "owner@gmail.com");
    await assertNoPassword(page);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    await page.screenshot({
      path: path.join(output, "mail-connect-gmail-mobile.png"),
      fullPage: true,
    });
  },
  { mobile: true },
);
add(
  "Members without admin access never see a credential form",
  async (page) => {
    await form(page)
      .getByText(/an owner or admin/)
      .waitFor();
    assert.equal(await form(page).locator("input").count(), 0);
    assert.equal(state.calls.length, 0);
  },
  { member: true },
);

let passed = 0;
try {
  await fs.mkdir(output, { recursive: true });
  const filter = process.argv.slice(2).join(" ").toLowerCase();
  const selected = cases.filter((item) => item.name.toLowerCase().includes(filter));
  assert.ok(selected.length, `No browser cases match ${JSON.stringify(filter)}`);
  for (const item of selected) {
    state = fixture();
    unexpected.length = 0;
    const errors: string[] = [];
    const pendingRequests = new Set<string>();
    const failedRequests: string[] = [];
    const consoleErrors: string[] = [];
    const context = await browser.newContext({
      viewport: item.mobile ? { width: 390, height: 844 } : { width: 1200, height: 900 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on("request", (request) => pendingRequests.add(request.url()));
    page.on("requestfinished", (request) => pendingRequests.delete(request.url()));
    page.on("requestfailed", (request) => {
      pendingRequests.delete(request.url());
      failedRequests.push(`${request.url()}: ${request.failure()?.errorText}`);
    });
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    context.on("page", (opened) => opened.on("pageerror", (error) => errors.push(error.message)));
    page.on("pageerror", (error) => errors.push(error.message));
    await context.route("**/*", (route) => {
      if ([origin, brokerOrigin].includes(new URL(route.request().url()).origin))
        return route.continue();
      unexpected.push(`External request: ${route.request().url()}`);
      return route.abort();
    });
    console.log(`RUN ${item.name}`);
    try {
      await page.goto(`${origin}/__mail_connect${item.member ? "?member" : ""}`, {
        waitUntil: "commit",
        timeout: 60_000,
      });
      await form(page)
        .getByRole("heading", { name: "Connect a mailbox" })
        // Vite compiles the fixture and its styles on the first request.
        // Interaction assertions below still keep their 15-second deadline.
        .waitFor({ timeout: 180_000 });
      await item.run(page);
      assert.deepEqual(errors, [], "Browser must not throw");
      assert.deepEqual(unexpected, [], "All requests must be expected and local");
      console.log(`PASS ${item.name}`);
      passed++;
    } catch (error) {
      console.error(`FAIL ${item.name}`, error);
      await fs.writeFile(
        path.join(output, "mail-connect-failure.json"),
        JSON.stringify(
          {
            name: item.name,
            error: String(error),
            errors,
            consoleErrors,
            failedRequests,
            pendingRequests: [...pendingRequests],
            unexpected,
            calls: state.calls,
          },
          null,
          2,
        ),
      );
      await page
        .screenshot({ path: path.join(output, "mail-connect-failure.png"), fullPage: true })
        .catch(() => {});
      throw error;
    } finally {
      await context.close();
    }
  }
  console.log(`${passed} mailbox connection browser cases passed.`);
} finally {
  await browser.close();
  await server.close();
}
