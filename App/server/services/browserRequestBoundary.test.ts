import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import test from "node:test";
import { chromium } from "playwright-core";
import express from "express";
import {
  AI_BROWSER_REQUEST_HEADER,
  AI_BROWSER_REQUEST_VALUE,
  markAiBrowserSessionRequestHeaders,
  rejectAiBrowserAppRequests,
} from "./browserRequestBoundary.js";

test("marks App-owned Browser requests that carry a Genosyn Member session", () => {
  const marked = markAiBrowserSessionRequestHeaders({
    Cookie: "theme=dark; genosyn.sid=s%3Asession; genosyn.sid.sig=signature",
    [AI_BROWSER_REQUEST_HEADER]: "page-cannot-clear-this",
  });
  assert.equal(marked[AI_BROWSER_REQUEST_HEADER], AI_BROWSER_REQUEST_VALUE);
  assert.match(marked.Cookie, /genosyn\.sid=/);
});

test("leaves unrelated website requests unmarked", () => {
  const headers = { cookie: "external_session=value", accept: "text/html" };
  assert.strictEqual(markAiBrowserSessionRequestHeaders(headers), headers);
  assert.equal(AI_BROWSER_REQUEST_HEADER in headers, false);
});

test("rejects every App API centrally when the AI Browser marker is present", async () => {
  const app = express();
  app.use("/api", rejectAiBrowserAppRequests);
  app.get("/api/settings/api-keys", (_req, res) => res.json({ token: "must-not-return" }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/settings/api-keys`,
      { headers: { [AI_BROWSER_REQUEST_HEADER]: AI_BROWSER_REQUEST_VALUE } },
    );
    assert.equal(response.status, 403);
    assert.doesNotMatch(await response.text(), /must-not-return/);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("marks a real Chromium request carrying the HttpOnly Genosyn session cookie", async (t) => {
  const executablePath = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    chromium.executablePath(),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/chromium",
  ]
    .filter((value): value is string => Boolean(value))
    .find((value) => existsSync(value));
  if (!executablePath) {
    t.skip("No Chromium executable is available for the Browser request-boundary test");
    return;
  }

  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.headers));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    await context.addCookies([
      {
        name: "genosyn.sid",
        value: "member-session",
        url: origin,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    await context.route("**/*", async (route) => {
      const headers = await route.request().allHeaders();
      await route.continue({ headers: markAiBrowserSessionRequestHeaders(headers) });
    });
    const page = await context.newPage();
    await page.goto(origin);
    const received = JSON.parse(await page.locator("body").innerText()) as Record<string, string>;
    assert.equal(received[AI_BROWSER_REQUEST_HEADER], AI_BROWSER_REQUEST_VALUE);
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
