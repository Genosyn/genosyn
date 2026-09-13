import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AppSetting } from "../db/entities/AppSetting.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import {
  CUSTOM_JAVASCRIPT_SETTING_KEY,
  MAX_CUSTOM_JAVASCRIPT_LENGTH,
  resetCustomJavaScriptCacheForTests,
} from "../services/customJavaScript.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { adminRouter } from "./admin.js";
import { customJavaScriptRouter } from "./customJavaScript.js";

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    await persistTestSession(req);
    next();
  });
  app.use("/api/app", customJavaScriptRouter);
  app.use("/api/admin", adminRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  resetCustomJavaScriptCacheForTests();
  const operator = await insert(User, {
    email: "operator@example.com",
    name: "Operator",
    passwordHash: "x",
    sessionVersion: 0,
    isMasterAdmin: true,
    emailVerifiedAt: new Date(),
  });
  actingUserId = operator.id;
});

async function call<T = Record<string, unknown>>(
  method: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}/api/admin/custom-javascript`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

test("a master admin can save, read, and clear a complete analytics snippet", async () => {
  const customJavaScript = `<script async src="https://www.googletagmanager.com/gtag/js?id=G-TEST"></script>
<script>window.dataLayer = window.dataLayer || [];</script>`;
  const saved = await call<{ customJavaScript: string; configured: boolean }>("PUT", {
    customJavaScript,
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body, { customJavaScript, configured: true });

  const read = await call<{ customJavaScript: string; configured: boolean }>("GET");
  assert.deepEqual(read.body, saved.body);
  const row = await AppDataSource.getRepository(AppSetting).findOneByOrFail({
    key: CUSTOM_JAVASCRIPT_SETTING_KEY,
  });
  assert.equal(row.value, customJavaScript);

  const cleared = await call<{ customJavaScript: string; configured: boolean }>("PUT", {
    customJavaScript: "",
  });
  assert.deepEqual(cleared.body, { customJavaScript: "", configured: false });
  assert.equal(
    await AppDataSource.getRepository(AppSetting).findOneBy({
      key: CUSTOM_JAVASCRIPT_SETTING_KEY,
    }),
    null,
  );
});

test("the setting is private to signed-in master admins", async () => {
  actingUserId = null;
  assert.equal((await call("GET")).status, 401);

  const member = await insert(User, {
    email: "member@example.com",
    name: "Member",
    passwordHash: "x",
    sessionVersion: 0,
    isMasterAdmin: false,
    emailVerifiedAt: new Date(),
  });
  actingUserId = member.id;
  assert.equal((await call("GET")).status, 403);
  assert.equal((await call("PUT", { customJavaScript: "window.no = true;" })).status, 403);
});

test("invalid or oversized code is rejected without changing the setting", async () => {
  assert.equal(
    (await call("PUT", { customJavaScript: "<script>window.incomplete = true" })).status,
    400,
  );
  assert.equal(
    (
      await call("PUT", {
        customJavaScript: "x".repeat(MAX_CUSTOM_JAVASCRIPT_LENGTH + 1),
      })
    ).status,
    400,
  );
  assert.equal(
    await AppDataSource.getRepository(AppSetting).findOneBy({
      key: CUSTOM_JAVASCRIPT_SETTING_KEY,
    }),
    null,
  );
});

test("the browser asset is same-origin, non-cached, and requires a valid session", async () => {
  await call("PUT", { customJavaScript: "window.__customAssetLoaded = true;" });

  const loader = await fetch(`${baseUrl}/api/app/custom-javascript-loader.js`);
  assert.match(await loader.text(), /custom-javascript\.js\?page=/);

  const assetUrl = `${baseUrl}/api/app/custom-javascript.js?page=${encodeURIComponent("/c/acme")}`;
  const response = await fetch(assetUrl);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/javascript/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.match(await response.text(), /window\.__customAssetLoaded = true/);

  actingUserId = null;
  const anonymous = await fetch(assetUrl);
  assert.doesNotMatch(await anonymous.text(), /__customAssetLoaded/);
});

test("the browser asset stays empty on sensitive, encoded, safe, and unknown page loads", async () => {
  await call("PUT", { customJavaScript: "window.__customAssetLoaded = true;" });

  for (const page of [
    "/login",
    "/l%6fgin",
    "/forgot",
    "/res%65t/secret",
    "/c/acme?ssoLink=secret",
    "/c/acme?safe=1",
  ]) {
    const response = await fetch(
      `${baseUrl}/api/app/custom-javascript.js?page=${encodeURIComponent(page)}`,
    );
    assert.doesNotMatch(await response.text(), /__customAssetLoaded/, page);
  }

  const noPage = await fetch(`${baseUrl}/api/app/custom-javascript.js`);
  assert.doesNotMatch(await noPage.text(), /__customAssetLoaded/);
});
