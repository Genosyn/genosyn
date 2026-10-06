import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  discoverHostedSignIn,
  requestHostedSignIn,
  resetHostedSignInDiscoveryForTests,
} from "./hostedSignInTransport.js";

const originalFetch = globalThis.fetch;
const issuer = "https://connect.example";
const CALENDAR = "https://www.googleapis.com/auth/calendar";
let calls: string[];
beforeEach(() => {
  calls = [];
  resetHostedSignInDiscoveryForTests();
  globalThis.fetch = async (input, init) => {
    calls.push(String(input));
    assert.equal(init?.redirect, "error");
    assert.equal(init?.body, undefined);
    assert.equal(new Headers(init?.headers).has("cookie"), false);
    return Response.json({ version: 2, available: true, scopes: [CALENDAR] });
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("provider discovery is neutral and its cache is isolated by provider and issuer", async () => {
  const offer = { path: "/api/connect/google", scopes: [CALENDAR] };
  assert.deepEqual(await discoverHostedSignIn(issuer, "google"), offer);
  assert.deepEqual(await discoverHostedSignIn(issuer, "google"), offer);
  assert.deepEqual(await discoverHostedSignIn(issuer, "future-provider"), {
    path: "/api/connect/future-provider",
    scopes: [CALENDAR],
  });
  assert.deepEqual(await discoverHostedSignIn("https://other.example", "google"), offer);
  assert.deepEqual(calls, [
    `${issuer}/api/connect/google/status`,
    `${issuer}/api/connect/future-provider/status`,
    "https://other.example/api/connect/google/status",
  ]);
});

test("only protocol 2 counts, and nothing falls back to the Gmail-only path", async () => {
  for (const response of [
    () => Response.json({ version: 1, available: true }),
    () => Response.json({ version: 1, available: true, scopes: [CALENDAR] }),
    () => Response.json({ version: 2, available: false, scopes: [] }),
    () => Response.json({ version: 2, available: true }),
    () => Response.json({ version: 3, available: true, scopes: [CALENDAR] }),
    () => new Response(null, { status: 404 }),
    () => new Response(null, { status: 503 }),
    () => new Response(null, { status: 302, headers: { location: "/api/google-sign-in/status" } }),
  ]) {
    resetHostedSignInDiscoveryForTests();
    calls = [];
    globalThis.fetch = async (input) => {
      calls.push(String(input));
      return response();
    };
    assert.equal(await discoverHostedSignIn(issuer, "google").catch(() => null), null);
    assert.deepEqual(calls, [`${issuer}/api/connect/google/status`]);
  }
});

test("stored protocol paths cannot send a token to another provider or arbitrary path", async () => {
  for (const path of [
    "/api/connect/github",
    "/api/admin",
    "https://other.example/refresh",
    "/api/connect/google/../github",
  ]) {
    await assert.rejects(
      requestHostedSignIn(issuer, "google", path, "refresh", { refreshToken: "private" }),
      /unavailable/,
    );
  }
  await assert.rejects(
    requestHostedSignIn(issuer, "github", "/api/google-sign-in", "refresh", {
      refreshToken: "private",
    }),
    /unavailable/,
    "the Gmail-only path renews Google Connections only",
  );
  await assert.rejects(discoverHostedSignIn(issuer, "../admin"), /unavailable/);
  await assert.rejects(discoverHostedSignIn("http://remote.example", "google"), /unavailable/);
  assert.equal(calls.length, 0);
});

test("Connections from the Gmail-only path renew there", async () => {
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return Response.json({ accessToken: "renewed", expiresAt: Date.now() + 60_000 });
  };
  const renewed = await requestHostedSignIn(issuer, "google", "/api/google-sign-in", "refresh", {
    clientId: "client",
    refreshToken: "private",
  });
  assert.equal((renewed as { accessToken: string }).accessToken, "renewed");
  assert.deepEqual(calls, [`${issuer}/api/google-sign-in/refresh`]);
});

test("credential requests do not rediscover or fall back after failure, and hide upstream detail", async () => {
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response("private-upstream-token", { status: 404 });
  };
  await assert.rejects(
    requestHostedSignIn(issuer, "google", "/api/connect/google", "refresh", {
      refreshToken: "private",
    }),
    (error: Error) => error.message === "Hosted sign-in is unavailable. Please try again later.",
  );
  assert.deepEqual(calls, [`${issuer}/api/connect/google/refresh`]);
});

test("oversized responses and network failures expose no credential material", async () => {
  for (const oversized of [true, false]) {
    globalThis.fetch = async () => {
      if (oversized) return new Response("x".repeat(65_537));
      throw new Error("private-upstream-token");
    };
    await assert.rejects(
      requestHostedSignIn(issuer, "google", "/api/connect/google", "refresh", {
        refreshToken: "private",
      }),
      (error: Error) => error.message === "Hosted sign-in is unavailable. Please try again later.",
    );
  }
});

test("discovery reports exactly the scopes a service offers, or nothing for a malformed list", async () => {
  assert.deepEqual(await discoverHostedSignIn(issuer, "google"), {
    path: "/api/connect/google",
    scopes: [CALENDAR],
  });
  for (const scopes of ["openid", [1], Array(257).fill("s"), ["x".repeat(257)], [""]]) {
    resetHostedSignInDiscoveryForTests();
    globalThis.fetch = async () => Response.json({ version: 2, available: true, scopes });
    assert.equal(
      await discoverHostedSignIn(issuer, "google"),
      null,
      JSON.stringify(scopes).slice(0, 30),
    );
  }
});
