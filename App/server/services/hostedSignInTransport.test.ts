import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  discoverHostedSignInPath,
  requestHostedSignIn,
  resetHostedSignInDiscoveryForTests,
} from "./hostedSignInTransport.js";

const originalFetch = globalThis.fetch;
const issuer = "https://connect.example";
let calls: string[];
beforeEach(() => {
  calls = [];
  resetHostedSignInDiscoveryForTests();
  globalThis.fetch = async (input, init) => {
    calls.push(String(input));
    assert.equal(init?.redirect, "error");
    assert.equal(init?.body, undefined);
    assert.equal(new Headers(init?.headers).has("cookie"), false);
    return Response.json({ version: 1, available: true });
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("provider discovery is neutral and its cache is isolated by provider and issuer", async () => {
  assert.equal(await discoverHostedSignInPath(issuer, "google"), "/api/connect/google");
  assert.equal(await discoverHostedSignInPath(issuer, "google"), "/api/connect/google");
  assert.equal(
    await discoverHostedSignInPath(issuer, "future-provider"),
    "/api/connect/future-provider",
  );
  assert.equal(
    await discoverHostedSignInPath("https://other.example", "google"),
    "/api/connect/google",
  );
  assert.equal(calls.length, 3);
});

test("only an absent Google namespace can discover a legacy host", async () => {
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    return url.includes("/api/connect/")
      ? new Response(null, { status: 404 })
      : Response.json({ version: 1, available: true });
  };
  assert.equal(await discoverHostedSignInPath(issuer, "google"), "/api/google-sign-in");
  assert.deepEqual(calls, [
    `${issuer}/api/connect/google/status`,
    `${issuer}/api/google-sign-in/status`,
  ]);
  await assert.rejects(discoverHostedSignInPath(issuer, "unknown"), /unavailable/);
  assert.equal(calls.length, 3);
});

test("disabled, incompatible, unavailable and redirecting providers never downgrade", async () => {
  for (const response of [
    () => Response.json({ version: 1, available: false }),
    () => Response.json({ version: 2, available: true }),
    () => new Response(null, { status: 503 }),
    () => new Response(null, { status: 302, headers: { location: "/api/google-sign-in/status" } }),
  ]) {
    resetHostedSignInDiscoveryForTests();
    calls = [];
    globalThis.fetch = async (input) => {
      calls.push(String(input));
      return response();
    };
    assert.equal(await discoverHostedSignInPath(issuer, "google").catch(() => null), null);
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
  await assert.rejects(discoverHostedSignInPath(issuer, "../admin"), /unavailable/);
  await assert.rejects(discoverHostedSignInPath("http://remote.example", "google"), /unavailable/);
  assert.equal(calls.length, 0);
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
