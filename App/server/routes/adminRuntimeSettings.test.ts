import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AppSetting } from "../db/entities/AppSetting.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import {
  RUNTIME_SETTINGS_DEFAULTS,
  RUNTIME_SETTING_KEYS,
  getMailSettings,
  getWebSettings,
  resetRuntimeSettingsCacheForTests,
} from "../services/runtimeSettings.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { adminRouter } from "./admin.js";

/**
 * Admin → Runtime.
 *
 * The endpoints behind the page that replaced the operational half of
 * `config.ts`. Two things matter beyond the happy path: a full-group replace
 * (so a stale form cannot silently revert a field it never showed), and a hard
 * refusal of out-of-range values — these rows drive fetch budgets and poll
 * intervals, so a mistyped number is a production incident, not a typo.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    next();
  });
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
  resetRuntimeSettingsCacheForTests();
  const operator = await insert(User, {
    email: "op@example.com",
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
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}/api/admin${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

type Snapshot = {
  web: typeof RUNTIME_SETTINGS_DEFAULTS.web;
  mail: typeof RUNTIME_SETTINGS_DEFAULTS.mail;
  meetings: typeof RUNTIME_SETTINGS_DEFAULTS.meetings;
  browser: typeof RUNTIME_SETTINGS_DEFAULTS.browser;
  agent: typeof RUNTIME_SETTINGS_DEFAULTS.agent;
  overridden: Record<string, boolean>;
};

describe("GET /api/admin/runtime-settings", () => {
  test("a fresh install reports the shipped defaults, nothing overridden", async () => {
    const { status, body } = await call<Snapshot>("GET", "/runtime-settings");

    assert.equal(status, 200);
    assert.deepEqual(body.web, RUNTIME_SETTINGS_DEFAULTS.web);
    assert.deepEqual(body.mail, RUNTIME_SETTINGS_DEFAULTS.mail);
    assert.deepEqual(body.meetings, RUNTIME_SETTINGS_DEFAULTS.meetings);
    assert.deepEqual(body.browser, RUNTIME_SETTINGS_DEFAULTS.browser);
    assert.deepEqual(body.agent, RUNTIME_SETTINGS_DEFAULTS.agent);
    assert.deepEqual(body.overridden, {
      web: false,
      mail: false,
      meetings: false,
      browser: false,
      agent: false,
    });
  });

  test("only a signed-in master admin can read it", async () => {
    actingUserId = null;
    assert.equal((await call("GET", "/runtime-settings")).status, 401);
  });
});

describe("PUT /api/admin/runtime-settings/:group", () => {
  test("a save persists, is reflected in the snapshot, and reaches the readers", async () => {
    const { status, body } = await call<Snapshot>("PUT", "/runtime-settings/web", {
      enabled: false,
      searchProvider: "disabled",
      maxSearchResults: 3,
      maxDocumentBytes: 1024 * 1024,
      maxTextChars: 5_000,
    });

    assert.equal(status, 200);
    assert.equal(body.web.enabled, false);
    assert.equal(body.overridden.web, true);
    // The other groups are untouched.
    assert.equal(body.overridden.mail, false);
    assert.deepEqual(body.mail, RUNTIME_SETTINGS_DEFAULTS.mail);
    // And the in-process readers see it without waiting for a refresh.
    assert.equal(getWebSettings().enabled, false);
    assert.equal(getWebSettings().maxSearchResults, 3);

    const row = await AppDataSource.getRepository(AppSetting).findOneBy({
      key: RUNTIME_SETTING_KEYS.web,
    });
    assert.equal(JSON.parse(row!.value).maxTextChars, 5_000);
  });

  test("an out-of-range value is a 400 and writes nothing", async () => {
    const { status, body } = await call<{ error: string }>("PUT", "/runtime-settings/mail", {
      syncIntervalSec: 1,
      backfillThreadsPerPass: 200,
      backfillPassSeconds: 25,
      backfillDays: 0,
    });

    assert.equal(status, 400);
    assert.match(body.error, /Invalid runtime settings/);
    assert.equal(
      await AppDataSource.getRepository(AppSetting).findOneBy({
        key: RUNTIME_SETTING_KEYS.mail,
      }),
      null,
    );
    assert.deepEqual(getMailSettings(), RUNTIME_SETTINGS_DEFAULTS.mail);
  });

  test("a partial body is refused — the write replaces the whole group", async () => {
    const { status } = await call("PUT", "/runtime-settings/web", { enabled: false });

    assert.equal(status, 400);
    assert.equal(getWebSettings().enabled, true);
  });

  test("an unknown group is a 400 rather than a new settings key", async () => {
    const { status } = await call("PUT", "/runtime-settings/smtp", { host: "x" });

    assert.equal(status, 400);
    assert.deepEqual(await AppDataSource.getRepository(AppSetting).find(), []);
  });

  test("the agent group round-trips its nested tool discovery block", async () => {
    const { status, body } = await call<Snapshot>("PUT", "/runtime-settings/agent", {
      taintPolicy: "off",
      memberBrowsersEnabled: false,
      toolDiscovery: { enabled: false, minCatalogueSize: 12 },
    });

    assert.equal(status, 200);
    assert.deepEqual(body.agent, {
      taintPolicy: "off",
      memberBrowsersEnabled: false,
      toolDiscovery: { enabled: false, minCatalogueSize: 12 },
    });
  });

  test('the browser group accepts "auto" and an explicit boolean for headless', async () => {
    assert.equal(
      (
        await call<Snapshot>("PUT", "/runtime-settings/browser", {
          ...RUNTIME_SETTINGS_DEFAULTS.browser,
          headless: true,
        })
      ).body.browser.headless,
      true,
    );
    assert.equal(
      (
        await call<Snapshot>("PUT", "/runtime-settings/browser", {
          ...RUNTIME_SETTINGS_DEFAULTS.browser,
          headless: "auto",
        })
      ).body.browser.headless,
      "auto",
    );
    assert.equal(
      (
        await call("PUT", "/runtime-settings/browser", {
          ...RUNTIME_SETTINGS_DEFAULTS.browser,
          headless: "sometimes",
        })
      ).status,
      400,
    );
  });
});

describe("DELETE /api/admin/runtime-settings/:group", () => {
  test("a reset drops the row and returns the group to the defaults", async () => {
    await call("PUT", "/runtime-settings/meetings", {
      enabled: false,
      syncIntervalSeconds: 900,
      transcriptionModel: "whisper-large-v3",
      maxRecordingBytes: 1024 * 1024,
    });

    const { status, body } = await call<Snapshot>("DELETE", "/runtime-settings/meetings");

    assert.equal(status, 200);
    assert.equal(body.overridden.meetings, false);
    assert.deepEqual(body.meetings, RUNTIME_SETTINGS_DEFAULTS.meetings);
    assert.equal(
      await AppDataSource.getRepository(AppSetting).findOneBy({
        key: RUNTIME_SETTING_KEYS.meetings,
      }),
      null,
    );
  });

  test("resetting a group that was never saved is harmless", async () => {
    const { status, body } = await call<Snapshot>("DELETE", "/runtime-settings/browser");
    assert.equal(status, 200);
    assert.deepEqual(body.browser, RUNTIME_SETTINGS_DEFAULTS.browser);
  });
});
