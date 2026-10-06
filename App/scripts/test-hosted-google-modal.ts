/** Real modal + Chrome, local sign-in fixtures, no credentials or App database.
 * Run with Node 22: node node_modules/tsx/dist/cli.mjs scripts/test-hosted-google-modal.ts
 * An optional case substring selects one browser case. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright-core";
import { createServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(root, "../output/playwright");
const base = "/api/companies/company/integrations";
const requestId = "b".repeat(43);
const browserProof = "p".repeat(43);
type State = {
  complete: boolean;
  legacyProtocol: boolean;
  startError: boolean;
  pollError: boolean;
  calls: Array<{ path: string; body: Record<string, unknown> }>;
};
const fixture = (): State => ({
  complete: false,
  legacyProtocol: false,
  startError: false,
  pollError: false,
  calls: [],
});
let state = fixture();
const unexpected: string[] = [];

const server = await createServer({
  configFile: path.join(root, "vite.config.ts"),
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
  server: { host: "127.0.0.1", port: 0, hmr: false },
  cacheDir: path.join(root, "node_modules/.vite-hosted-google-modal"),
  plugins: [
    {
      name: "hosted-google-modal-fixture",
      configureServer(dev) {
        dev.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url ?? "/", "http://fixture");
          if (url.pathname === "/__hosted_google_modal") {
            res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
            res.setHeader("content-type", "text/html");
            res.end(
              await dev.transformIndexHtml(
                url.pathname,
                '<!doctype html><html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"><div id="root"></div>' +
                  `<script type="module" src="/@fs${root}/scripts/hostedGoogleModalHarness.tsx"></script></html>`,
              ),
            );
            return;
          }
          if (url.pathname === "/__hosted_modal_popup") {
            res.setHeader("content-type", "text/html");
            res.setHeader("Cross-Origin-Opener-Policy", "unsafe-none");
            res.end(`<!doctype html><html><button disabled>Complete consent</button><script>
            const button=document.querySelector("button");
            window.addEventListener("message",event=>{
              if(event.source===window.opener && event.origin===${JSON.stringify(origin)} && event.data?.source===${JSON.stringify(state.legacyProtocol ? "genosyn-google-sign-in-launch" : "genosyn-sign-in-launch")} && event.data.requestId===${JSON.stringify(requestId)} && event.data.proof===${JSON.stringify(browserProof)}) button.disabled=false;
            });
            window.opener.postMessage({source:${JSON.stringify(state.legacyProtocol ? "genosyn-google-sign-in-ready" : "genosyn-sign-in-ready")},requestId:${JSON.stringify(requestId)}},${JSON.stringify(origin)});
            window.opener.postMessage({source:"genosyn-oauth",ok:true},${JSON.stringify(origin)});
            button.onclick=async()=>{await fetch("/__complete_modal_consent",{method:"POST"});button.textContent="Consent complete";};
          </script></html>`);
            return;
          }
          if (url.pathname === "/__direct_modal_popup") {
            res.setHeader("content-type", "text/html");
            res.end(
              '<script>window.opener.postMessage({source:"genosyn-oauth",ok:true},window.location.origin);window.close();</script>',
            );
            return;
          }
          if (url.pathname === "/__complete_modal_consent") {
            state.complete = true;
            res.end("ok");
            return;
          }
          if (!url.pathname.startsWith("/api/")) return next();
          let raw = "";
          for await (const chunk of req) raw += chunk.toString();
          const body = JSON.parse(raw || "{}") as Record<string, unknown>;
          state.calls.push({ path: url.pathname, body });
          const json = (value: unknown, status = 200) => {
            res.statusCode = status;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(value));
          };
          if (
            req.method === "POST" &&
            (url.pathname === `${base}/oauth/start` ||
              url.pathname === `${base}/connections/connection/reconnect/oauth`)
          ) {
            if (state.startError)
              return json({ error: "Google sign-in could not start. Try again." }, 503);
            if (body.clientId) return json({ authorizeUrl: `${origin}/__direct_modal_popup` });
            return json({
              authorizeUrl: `${brokerOrigin}/__hosted_modal_popup?requestId=${requestId}`,
              hostedAttempt: "a".repeat(43),
              hostedBrowserProof: browserProof,
              expiresAt: Date.now() + 600_000,
            });
          }
          if (req.method === "POST" && url.pathname === `${base}/oauth/hosted/poll`) {
            if (state.pollError)
              return json({ error: "Hosted Gmail is temporarily unavailable. Try again." }, 503);
            return json({ status: state.complete ? "complete" : "pending" });
          }
          if (req.method === "POST" && url.pathname === `${base}/oauth/hosted/cancel`)
            return json({ ok: true });
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
  .launch({ channel: process.env.GENOSYN_TEST_BROWSER ?? "chrome", headless: true })
  .catch(async (error) => {
    await server.close();
    throw error;
  });

type Case = {
  name: string;
  run: (page: Page) => Promise<void>;
  reconnect?: boolean;
  mobile?: boolean;
  /** Scope groups the fixture's Genosyn Connect offers; Gmail alone by default. */
  offer?: string[];
};
const cases: Case[] = [];
const dialog = (page: Page) => page.getByRole("dialog");
const submit = (page: Page) =>
  dialog(page).getByRole("button", { name: "Connect with Google Workspace", exact: true });
const scope = (page: Page, name: string) =>
  dialog(page).getByRole("checkbox", { name: new RegExp(`^${name} `) });
const clientId = (page: Page) =>
  dialog(page).getByRole("textbox", { name: "OAuth Client ID", exact: true });
const noClientFields = async (page: Page) => {
  assert.equal(await clientId(page).count(), 0);
  assert.equal(await dialog(page).locator('input[type="password"]').count(), 0);
};
const saved = async (page: Page, count: number) => {
  assert.equal(await page.locator("main").getByRole("status").textContent(), `Saved ${count}`);
};

cases.push({
  name: "fresh hosted Google defaults to Gmail and returns from other products without client setup",
  run: async (page) => {
    assert.equal(await scope(page, "Gmail").isChecked(), true);
    assert.equal(await scope(page, "Drive").isChecked(), false);
    assert.equal(await scope(page, "Calendar").isChecked(), false);
    await noClientFields(page);
    assert.equal(await submit(page).isEnabled(), true);
    await scope(page, "Drive").check();
    await clientId(page).waitFor();
    assert.equal(await submit(page).isDisabled(), true);
    assert.equal(await dialog(page).locator('input[type="password"]').count(), 1);
    await dialog(page)
      .getByRole("button", { name: "Use Genosyn Connect for Gmail instead" })
      .click();
    await noClientFields(page);
    assert.equal(await scope(page, "Drive").isChecked(), false);
    assert.equal(await scope(page, "Gmail").isChecked(), true);
    await page.screenshot({
      path: path.join(output, "hosted-google-modal-desktop.png"),
      fullPage: true,
    });
    await saved(page, 0);
  },
});

cases.push({
  name: "a Connect offering several products starts from them and explains the ones it lacks",
  offer: ["mail", "calendar"],
  run: async (page) => {
    assert.equal(await scope(page, "Gmail").isChecked(), true);
    assert.equal(await scope(page, "Calendar").isChecked(), true);
    assert.equal(await scope(page, "Drive").isChecked(), false);
    await dialog(page)
      .getByText(/Genosyn Connect handles Google sign-in/)
      .waitFor();
    await noClientFields(page);
    // What Connect does not offer is marked before anyone picks it.
    const ownClient = (name: string) =>
      dialog(page).getByRole("checkbox", { name: new RegExp(`^${name} Own OAuth client `) });
    assert.equal(await ownClient("Drive").count(), 1);
    assert.equal(await ownClient("Gmail").count(), 0);
    assert.equal(await ownClient("Calendar").count(), 0);
    await scope(page, "Drive").check();
    await clientId(page).waitFor();
    await dialog(page)
      .getByText(
        "Genosyn Connect offers Gmail, Calendar without any setup. Drive needs an OAuth client of your own.",
      )
      .waitFor();
    await dialog(page)
      .getByRole("button", { name: "Use Genosyn Connect for Gmail, Calendar instead" })
      .click();
    await noClientFields(page);
    assert.equal(await scope(page, "Drive").isChecked(), false);
    assert.equal(await scope(page, "Calendar").isChecked(), true);
    await scope(page, "Gmail").uncheck();
    await completeHosted(page);
    const started = state.calls.find((call) => call.path.endsWith("/oauth/start"))!;
    assert.deepEqual(started.body.scopeGroups, ["calendar"]);
    assert.equal(started.body.clientId, undefined);
  },
});

cases.push({
  name: "explicit own client survives Gmail-only selection and is sent unchanged",
  run: async (page) => {
    await dialog(page).getByRole("button", { name: "Use my own OAuth client instead" }).click();
    await clientId(page).fill("own-google-client");
    await dialog(page).locator('input[type="password"]').fill("fixture-client-secret");
    await scope(page, "Drive").check();
    await scope(page, "Drive").uncheck();
    assert.equal(await clientId(page).inputValue(), "own-google-client");
    await submit(page).click();
    await page.locator("main").getByRole("status").getByText("Saved 1", { exact: true }).waitFor();
    const started = state.calls.find((call) => call.path.endsWith("/oauth/start"))!;
    assert.equal(started.body.clientId, "own-google-client");
    assert.equal(started.body.clientSecret, "fixture-client-secret");
    assert.deepEqual(started.body.scopeGroups, ["mail"]);
    assert.equal(
      state.calls.some((call) => call.path.endsWith("/hosted/poll")),
      false,
    );
  },
});

async function completeHosted(page: Page, reconnect = false) {
  const opened = page.waitForEvent("popup");
  await (
    reconnect ? dialog(page).getByRole("button", { name: "Reconnect", exact: true }) : submit(page)
  ).click();
  const popup = await opened;
  await popup.getByRole("button", { name: "Complete consent" }).waitFor();
  await dialog(page).getByRole("status").getByText("Waiting for sign-in…").waitFor();
  await saved(page, 0);
  await popup.getByRole("button", { name: "Complete consent" }).click();
  await page.locator("main").getByRole("status").getByText("Saved 1", { exact: true }).waitFor();
  assert.ok(state.calls.some((call) => call.path.endsWith("/hosted/poll")));
  assert.equal(await dialog(page).count(), 0);
}

cases.push({
  name: "hosted consent saves only after polling reports completion",
  run: async (page) => {
    await completeHosted(page);
    const started = state.calls.find((call) => call.path.endsWith("/oauth/start"))!;
    assert.equal(started.body.clientId, undefined);
    assert.equal(started.body.clientSecret, undefined);
    assert.deepEqual(started.body.scopeGroups, ["mail"]);
  },
});

cases.push({
  name: "a page speaking the retired Gmail-only messages is never sent the browser proof",
  run: async (page) => {
    state.legacyProtocol = true;
    const opened = page.waitForEvent("popup");
    await submit(page).click();
    const popup = await opened;
    await dialog(page).getByRole("status").getByText("Waiting for sign-in…").waitFor();
    // Give the opener every chance to answer the page's ready message.
    await popup.waitForTimeout(500);
    assert.equal(await popup.getByRole("button", { name: "Complete consent" }).isDisabled(), true);
    await dialog(page).getByRole("button", { name: "Cancel sign-in" }).click();
    await saved(page, 0);
  },
});

cases.push({
  name: "hosted reconnect exposes Gmail only and preserves the existing Connection",
  reconnect: true,
  run: async (page) => {
    assert.equal(await dialog(page).getByRole("checkbox").count(), 1);
    assert.equal(await scope(page, "Gmail").isChecked(), true);
    await noClientFields(page);
    await completeHosted(page, true);
    const started = state.calls.find((call) => call.path.endsWith("/reconnect/oauth"))!;
    assert.equal(started.path, `${base}/connections/connection/reconnect/oauth`);
    assert.deepEqual(started.body, { scopeGroups: ["mail"] });
  },
});

for (const failure of ["start", "poll"] as const) {
  cases.push({
    name: `${failure} errors remain inline without reporting saved`,
    run: async (page) => {
      state.startError = failure === "start";
      state.pollError = failure === "poll";
      await submit(page).click();
      const error =
        failure === "start"
          ? "Google sign-in could not start. Try again."
          : "Hosted Gmail is temporarily unavailable. Try again.";
      await dialog(page).getByRole("alert").getByText(error, { exact: true }).waitFor();
      assert.equal(await page.getByRole("dialog").count(), 1);
      assert.equal(await submit(page).isEnabled(), true);
      await noClientFields(page);
      await saved(page, 0);
    },
  });
}

cases.push({
  name: "hosted Google modal fits a mobile viewport",
  mobile: true,
  run: async (page) => {
    await noClientFields(page);
    const bounds = await dialog(page).boundingBox();
    assert.ok(bounds);
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    await page.screenshot({
      path: path.join(output, "hosted-google-modal-mobile.png"),
      fullPage: true,
    });
  },
});

let passed = 0;
try {
  await fs.mkdir(output, { recursive: true });
  const filter = process.argv.slice(2).join(" ").toLowerCase();
  const selected = cases.filter((item) => item.name.toLowerCase().includes(filter));
  assert.ok(selected.length, `No browser case matches ${JSON.stringify(filter)}`);
  for (const item of selected) {
    state = fixture();
    unexpected.length = 0;
    const errors: string[] = [];
    const consoleErrors: string[] = [];
    const pendingRequests = new Set<string>();
    const failedRequests: string[] = [];
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
    page.on("pageerror", (error) => errors.push(error.message));
    context.on("page", (opened) => opened.on("pageerror", (error) => errors.push(error.message)));
    await context.route("**/*", (route) => {
      if ([origin, brokerOrigin].includes(new URL(route.request().url()).origin))
        return route.continue();
      unexpected.push(`External request: ${route.request().url()}`);
      return route.abort();
    });
    console.log(`RUN ${item.name}`);
    try {
      const query = new URLSearchParams();
      if (item.reconnect) query.set("reconnect", "");
      if (item.offer) query.set("offer", item.offer.join(","));
      await page.goto(`${origin}/__hosted_google_modal${query.size ? `?${query}` : ""}`, {
        waitUntil: "commit",
        timeout: 60_000,
      });
      // Allow the first Vite compilation; interactions keep their short deadline.
      await dialog(page).waitFor({ timeout: 180_000 });
      await item.run(page);
      assert.deepEqual(errors, [], "Browser must not throw");
      assert.deepEqual(unexpected, [], "All requests must be expected and local");
      console.log(`PASS ${item.name}`);
      passed++;
    } catch (error) {
      await fs.writeFile(
        path.join(output, "hosted-google-modal-failure.json"),
        JSON.stringify(
          {
            name: item.name,
            error: String(error),
            errors,
            consoleErrors,
            pendingRequests: [...pendingRequests],
            failedRequests,
            unexpected,
            calls: state.calls,
          },
          null,
          2,
        ),
      );
      await page
        .screenshot({ path: path.join(output, "hosted-google-modal-failure.png"), fullPage: true })
        .catch(() => {});
      throw error;
    } finally {
      await context.close();
    }
  }
  console.log(`${passed} hosted Google modal browser cases passed.`);
} finally {
  await browser.close();
  await server.close();
}
