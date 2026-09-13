import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import vm from "node:vm";

import { AppDataSource } from "../db/datasource.js";
import { AppSetting } from "../db/entities/AppSetting.js";
import { closeTestDb, initTestDb, resetTestDb } from "../test/dbHarness.js";
import {
  compileCustomJavaScript,
  CUSTOM_JAVASCRIPT_SETTING_KEY,
  customJavaScriptAllowedForUrl,
  getCustomJavaScriptAsset,
  getCustomJavaScriptLoaderAsset,
  getCustomJavaScriptSettings,
  resetCustomJavaScriptCacheForTests,
  setCustomJavaScript,
} from "./customJavaScript.js";

before(initTestDb);
after(closeTestDb);

beforeEach(async () => {
  await resetTestDb();
  resetCustomJavaScriptCacheForTests();
});

test("a fresh install serves an empty, valid JavaScript asset", async () => {
  assert.deepEqual(await getCustomJavaScriptSettings(), {
    customJavaScript: "",
    configured: false,
  });
  assert.equal(getCustomJavaScriptAsset(), "/* No custom JavaScript configured. */\n");
});

test("raw JavaScript is persisted verbatim and safely served as an external asset", async () => {
  const source = 'window.__customJavaScript = "</script> survives";\r\nwindow.__line = 2;';
  assert.equal(compileCustomJavaScript(source), source);

  const saved = await setCustomJavaScript(source);
  assert.deepEqual(saved, { customJavaScript: source, configured: true });
  const row = await AppDataSource.getRepository(AppSetting).findOneByOrFail({
    key: CUSTOM_JAVASCRIPT_SETTING_KEY,
  });
  assert.equal(row.value, source);

  const asset = getCustomJavaScriptAsset();
  assert.ok(asset.includes(source));
  assert.ok(asset.includes("</script> survives"));
  assert.ok(asset.includes("\r\nwindow.__line"));
});

test("the served classic script preserves globals and strict-mode directives", async () => {
  const source = `"use strict";
var analyticsQueue = [];
function gtag() { analyticsQueue.push(arguments); }
window.__strictMode = (function () { return this === undefined; })();`;
  await setCustomJavaScript(source);

  const sandbox: Record<string, unknown> = {};
  sandbox.window = sandbox;
  vm.runInNewContext(getCustomJavaScriptAsset(), sandbox);
  assert.ok(Array.isArray(sandbox.analyticsQueue));
  assert.equal(typeof sandbox.gtag, "function");
  assert.equal(sandbox.__strictMode, true);
});

test("the fixed loader keeps its guard separate from operator globals", async () => {
  await setCustomJavaScript("const params = {}; function gtag() {}");
  const loader = getCustomJavaScriptLoaderAsset();
  assert.match(loader, /custom-javascript\.js\?page=/);
  assert.match(loader, /document\.write/);
  assert.doesNotMatch(loader, /function gtag/);
  assert.doesNotMatch(getCustomJavaScriptAsset(), /URLSearchParams/);
});

test("the fixed loader requests the current safe page and blocks encoded auth paths", async () => {
  await setCustomJavaScript("window.loaded = true;");
  const writes: string[] = [];
  const runLoader = (pathname: string, search = "") => {
    vm.runInNewContext(getCustomJavaScriptLoaderAsset(), {
      decodeURIComponent,
      document: { write: (value: string) => writes.push(value) },
      encodeURIComponent,
      URLSearchParams,
      window: { location: { pathname, search } },
    });
  };

  runLoader("/c/acme", "?tab=work");
  assert.deepEqual(writes, [
    '<script src="/api/app/custom-javascript.js?page=%2Fc%2Facme%3Ftab%3Dwork"></script>',
  ]);
  writes.length = 0;
  runLoader("/l%6fgin");
  assert.deepEqual(writes, []);
});

test("complete analytics snippets compile into the same-origin JavaScript asset", async () => {
  const source = `<!-- Google tag -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-TEST"></script>
<script>window.dataLayer = window.dataLayer || [];</script>`;

  const compiled = compileCustomJavaScript(source);
  assert.match(compiled, /document\.createElement\("script"\)/);
  assert.match(compiled, /googletagmanager\.com/);
  assert.match(compiled, /window\.dataLayer = window\.dataLayer \|\| \[\]/);
  await setCustomJavaScript(source);
  assert.match(getCustomJavaScriptAsset(), /googletagmanager\.com/);
});

test("separate inline script elements keep their original statement boundary", () => {
  const compiled = compileCustomJavaScript(
    "<script>window.first = function () { return 'first' }</script>" +
      "<script>(window.second = 'second')</script>",
  );
  assert.match(compiled, /}\n;\n\(window\.second/);
});

test("script snippet validation rejects partial tags, other HTML, and unsafe sources", () => {
  assert.throws(
    () => compileCustomJavaScript("<script>window.one=1;</script><script>window.two=2;"),
    /complete|incomplete|other HTML/,
  );
  assert.throws(
    () => compileCustomJavaScript("<div>no</div><script>window.one=1;</script>"),
    /without other HTML/,
  );
  assert.throws(
    () => compileCustomJavaScript('<script async src="http://tracker.test/a.js"></script>'),
    /HTTPS/,
  );
  assert.throws(
    () => compileCustomJavaScript('<script src="https://tracker.test/a.js"></script>'),
    /async/,
  );
});

test("credential-bearing, authentication, and safe-mode page loads are excluded", () => {
  for (const value of [
    "/SIGN/secret",
    "/reset/secret",
    "/verify-email/secret",
    "/invite/secret",
    "/link-chat/id/secret",
    "/login",
    "/login/sso/acme",
    "/signup",
    "/forgot",
    "/forgot/",
    "/l%6fgin",
    "/res%65t/secret",
    "/%66orgot",
    "/login%ZZ",
    "/?safe=1",
    "/?safe=0&safe=1",
    "/c/acme?ssoLink=secret",
    "/c/acme?TOKEN=secret",
    "/index.html",
  ]) {
    assert.equal(customJavaScriptAllowedForUrl(value), false, value);
  }
  assert.equal(customJavaScriptAllowedForUrl("/c/acme/home?tab=work"), true);
});

test("clearing the field removes both the row and live browser asset", async () => {
  await setCustomJavaScript("window.enabled = true;");
  const cleared = await setCustomJavaScript("   \n");
  assert.deepEqual(cleared, { customJavaScript: "", configured: false });
  assert.equal(
    await AppDataSource.getRepository(AppSetting).findOneBy({
      key: CUSTOM_JAVASCRIPT_SETTING_KEY,
    }),
    null,
  );
  assert.equal(getCustomJavaScriptAsset(), "/* No custom JavaScript configured. */\n");
});
