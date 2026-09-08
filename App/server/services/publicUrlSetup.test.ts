import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import type { Request } from "express";
import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AppSetting } from "../db/entities/AppSetting.js";
import { closeTestDb, initTestDb, resetTestDb } from "../test/dbHarness.js";
import {
  capturePublicUrlFromMasterAdminRequest,
  getPublicUrl,
  PUBLIC_URL_SETTING_KEY,
  setPublicUrl,
} from "./publicUrl.js";
import { initializePublicUrl, publicUrlSetupRequired } from "./publicUrlSetup.js";

const security = config.security as unknown as { multiTenant: boolean };
const originalMultiTenant = security.multiTenant;

before(initTestDb);
beforeEach(async () => {
  await resetTestDb();
  security.multiTenant = true;
});
after(async () => {
  security.multiTenant = originalMultiTenant;
  await closeTestDb();
});

test("shared SaaS requires an explicitly configured HTTPS origin", async () => {
  assert.equal(await publicUrlSetupRequired(), true);
  await assert.rejects(initializePublicUrl("http://genosyn.example.test"), /requires an HTTPS/);
  assert.equal(await AppDataSource.getRepository(AppSetting).count(), 0);
  const configured = await initializePublicUrl("https://genosyn.example.test/");
  assert.deepEqual(configured, { publicUrl: "https://genosyn.example.test", configured: true });
  assert.equal(getPublicUrl(), configured.publicUrl);
  assert.equal(await publicUrlSetupRequired(), false);
});

test("setup is idempotent and cannot replace an operator's existing URL", async () => {
  await initializePublicUrl("https://genosyn.example.test");
  await initializePublicUrl("https://genosyn.example.test/");
  await assert.rejects(initializePublicUrl("https://another.example.test"), /Admin → General/);
  assert.equal(getPublicUrl(), "https://genosyn.example.test");
  assert.equal(await AppDataSource.getRepository(AppSetting).count(), 1);
});

test("shared SaaS never initializes its canonical URL from browser request metadata", async () => {
  await publicUrlSetupRequired();
  await capturePublicUrlFromMasterAdminRequest({
    headers: { origin: "https://genosyn.example.test", host: "genosyn.example.test" },
    secure: true,
  } as Request);
  assert.equal(await AppDataSource.getRepository(AppSetting).count(), 0);
  assert.equal(await publicUrlSetupRequired(), true);
});

test("each replica checks the shared setting instead of trusting its cached origin", async () => {
  await initializePublicUrl("https://genosyn.example.test");
  await AppDataSource.getRepository(AppSetting).delete({ key: PUBLIC_URL_SETTING_KEY });
  assert.equal(await publicUrlSetupRequired(), true);
  await setPublicUrl("http://genosyn.example.test");
  assert.equal(await publicUrlSetupRequired(), true);
});

test("setup rejects non-origin values before writing any setting", async () => {
  for (const value of [
    "genosyn.example.test",
    "https://genosyn.example.test/app",
    "https://genosyn.example.test?query=1",
  ]) {
    await assert.rejects(initializePublicUrl(value), /Public URL/);
  }
  assert.equal(await AppDataSource.getRepository(AppSetting).count(), 0);
});

test("self-hosted development keeps its existing zero-configuration behavior", async () => {
  security.multiTenant = false;
  assert.equal(await publicUrlSetupRequired(), false);
  assert.deepEqual(await initializePublicUrl("http://localhost:8080"), {
    publicUrl: "http://localhost:8080",
    configured: true,
  });
});
