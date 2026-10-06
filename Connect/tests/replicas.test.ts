import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { client, readReturn, startTestService, type TestService } from "./helpers.js";

/**
 * Replicas share nothing but the operator's secret: no database, no sticky
 * sessions. Each step of one sign-in may land on a different replica, and one
 * started before a restart finishes after it, as long as the secret is the same.
 */
let first: TestService;
let second: TestService;
let stranger: TestService;

before(async () => {
  first = await startTestService();
  second = await startTestService();
  stranger = await startTestService({ config: { secret: "t".repeat(48) } });
});
after(async () => {
  await Promise.all([first.close(), second.close(), stranger.close()]);
});

test("every step of a sign-in may land on a different replica", async () => {
  const a = client(first);
  const b = client(second);
  const started = await a.start();
  assert.equal(started.response.status, 200);
  // The consent page and its form go to the second replica, the provider
  // returns to the first.
  const consent = await b.consent(started.body.requestId, started.browserProof);
  assert.equal(consent.response.status, 303);
  const returned = await a.callback(consent.state, consent.callbackCookie);
  assert.equal(returned.status, 303);
  const delivered = readReturn(returned.headers.get("location"), started);
  assert.equal(delivered.state, started.state);
  assert.equal(delivered.credential?.refreshToken, "google-refresh-token");
  assert.equal(second.google.calls.length, 0, "the code is redeemed once, where it arrived");
  assert.equal(
    first.google.calls.filter((call) => call.body.get("grant_type") === "authorization_code")
      .length,
    1,
  );
});

test("a replica with another secret can continue none of it, but still renews", async () => {
  const a = client(first);
  const c = client(stranger);
  const started = await a.start();
  const page = await c.page(started.body.requestId);
  assert.equal(page.response.status, 400);
  assert.match(page.html, /expired or is no longer valid/);

  const consent = await a.consent(started.body.requestId, started.browserProof);
  const elsewhere = await c.callback(consent.state, consent.callbackCookie);
  assert.equal(elsewhere.status, 400);
  assert.equal(stranger.google.calls.length, 0);
  // The sign-in itself is untouched and finishes where the secret matches.
  assert.equal((await a.callback(consent.state, consent.callbackCookie)).status, 303);

  // Renewal needs only the OAuth client, never the secret.
  const renewed = await c.post("/refresh", {
    clientId: stranger.config.google!.clientId,
    refreshToken: "issued-by-another-replica",
  });
  assert.equal(renewed.status, 200);
});
