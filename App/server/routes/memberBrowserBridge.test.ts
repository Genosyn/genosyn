import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { MemberBrowser } from "../db/entities/MemberBrowser.js";
import { AppDataSource } from "../db/datasource.js";
import { hashToken } from "../lib/token.js";
import { errorHandler } from "../middleware/error.js";
import { createMemberBrowser } from "../services/memberBrowsers.js";
import { closeTestDb, initTestDb, resetTestDb, testCompanyId } from "../test/dbHarness.js";
import { memberBrowserBridgeRouter } from "./memberBrowserBridge.js";

/**
 * The machine-facing half of member browsers: the only two endpoints a Node
 * process on somebody's laptop talks to before it holds a token. Nothing here
 * is authenticated, so the pairing code is the whole boundary.
 */

let server: Server;
let baseUrl = "";
let companyId: string;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/api/internal/member-browsers", memberBrowserBridgeRouter);
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
  companyId = testCompanyId();
});

async function pair(code: string) {
  const response = await fetch(`${baseUrl}/api/internal/member-browsers/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, agentVersion: "1.0.0" }),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, string>,
  };
}

async function newBrowser(name = "MacBook") {
  return createMemberBrowser({ companyId, ownerUserId: "user_1", name });
}

describe("redeeming a pairing code", () => {
  test("hands the bridge token back exactly once and stores only its hash", async () => {
    const { browser, pairingCode } = await newBrowser();

    const paired = await pair(pairingCode);
    assert.equal(paired.status, 200);
    assert.equal(paired.body.browserId, browser.id);
    assert.equal(paired.body.name, "MacBook");
    assert.ok(paired.body.token.length >= 32);

    const stored = await AppDataSource.getRepository(MemberBrowser).findOneByOrFail({
      id: browser.id,
    });
    assert.equal(stored.tokenHash, hashToken(paired.body.token));
    assert.equal(stored.tokenPrefix, paired.body.token.slice(0, 8));
    assert.doesNotMatch(JSON.stringify(stored), new RegExp(paired.body.token));
    assert.equal(stored.status, "offline");
  });

  test("accepts the code with or without the dashes a human reads it by", async () => {
    const { pairingCode } = await newBrowser();
    const paired = await pair(pairingCode.replace(/-/g, "").toUpperCase());
    assert.equal(paired.status, 200);
  });

  test("refuses the same code the second time", async () => {
    const { pairingCode } = await newBrowser();
    assert.equal((await pair(pairingCode)).status, 200);

    const replay = await pair(pairingCode);
    assert.equal(replay.status, 400);
    assert.match(replay.body.error, /work once/i);
  });

  test("refuses a code whose ten-minute window has closed", async () => {
    const { browser, pairingCode } = await newBrowser();
    await AppDataSource.getRepository(MemberBrowser).update(
      { id: browser.id },
      { pairingCodeExpiresAt: new Date(Date.now() - 1_000) },
    );

    const expired = await pair(pairingCode);
    assert.equal(expired.status, 400);
    const stored = await AppDataSource.getRepository(MemberBrowser).findOneByOrFail({
      id: browser.id,
    });
    assert.equal(stored.tokenHash, null);
    assert.equal(stored.status, "pending");
  });

  test("answers a wrong code identically whether or not any browser exists", async () => {
    const { pairingCode } = await newBrowser();
    // Flip one hex digit: same length, same shape, wrong value. If the reply
    // differed from the reply to pure noise, an unauthenticated caller could
    // sweep the endpoint to learn which installs have browsers waiting to pair.
    const nearMiss = pairingCode.replace(/[0-9a-f]$/, (last) =>
      last === "0" ? "1" : String.fromCharCode(last.charCodeAt(0) - 1),
    );

    const wrong = await pair(nearMiss);
    const noise = await pair("ffffffff-ffffffff-ffffffff-ffffffff-ffffffff");

    assert.equal(wrong.status, 400);
    assert.deepEqual(wrong.body, noise.body);
  });

  test("rejects a code too short to be one before it reaches the database", async () => {
    const response = await fetch(`${baseUrl}/api/internal/member-browsers/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "abc" }),
    });
    assert.equal(response.status, 400);
  });
});

describe("serving the bridge agent", () => {
  test("serves the agent unauthenticated and uncacheable", async () => {
    const response = await fetch(`${baseUrl}/api/internal/member-browsers/agent.mjs`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/javascript/);
    // A cached copy would survive a security fix to the CDP deny list.
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(body, /Genosyn browser bridge/);
    assert.match(body, /DENIED_CDP_METHODS/);
    // It ships to a human's machine, so it must arrive carrying no secrets.
    assert.doesNotMatch(body, /Bearer [A-Za-z0-9_-]{20,}/);
  });
});
