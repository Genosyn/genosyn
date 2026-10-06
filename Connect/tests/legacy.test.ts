import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { z } from "zod";
import {
  CALENDAR_SCOPE,
  client,
  GMAIL_SCOPES,
  IDENTITY_SCOPES,
  PUBLIC_URL,
  startTestService,
  type TestService,
} from "./helpers.js";

/**
 * Installations already released (up to 1.248) speak this protocol and will
 * keep speaking it until they upgrade. These schemas are copied from that
 * release's `hostedGoogleOauth.ts` and `hostedSignInTransport.ts`; if a change
 * here breaks them, those installations lose Gmail sign-in and renewal.
 */
const released = {
  status: z.object({ version: z.literal(1), available: z.boolean() }),
  start: z.object({
    requestId: z.string().min(1).max(256),
    authorizeUrl: z.string().url().max(8192),
    expiresAt: z.number().finite().positive(),
  }),
  poll: z.discriminatedUnion("status", [
    z.object({ status: z.literal("pending") }),
    z.object({ status: z.literal("denied"), detail: z.string().max(2000).optional() }),
    z.object({
      status: z.literal("complete"),
      credential: z.object({
        clientId: z.string().min(1).max(512),
        accessToken: z.string().min(1).max(16_384),
        refreshToken: z.string().min(1).max(16_384),
        expiresAt: z.number().finite().positive(),
        scope: z.string().max(8192),
        email: z.string().email().max(320),
      }),
    }),
  ]),
  refresh: z.object({
    accessToken: z.string().min(1).max(16_384),
    expiresAt: z.number().finite().positive(),
    refreshToken: z.string().min(1).max(16_384).optional(),
    scope: z.string().max(8192).optional(),
  }),
};

/** The released consumer's own checks on a start response. */
function assertReleasedAuthorizeUrl(path: string, body: z.infer<typeof released.start>) {
  const authorize = new URL(body.authorizeUrl);
  assert.equal(authorize.origin, new URL(PUBLIC_URL).origin);
  assert.equal(authorize.username + authorize.password + authorize.hash, "");
  assert.equal(authorize.pathname, `${path}/authorize`);
  assert.equal(authorize.searchParams.get("requestId"), body.requestId);
}

let service: TestService;
beforeEach(async () => {
  service = await startTestService();
});
afterEach(async () => {
  await service.close();
});

for (const path of ["/api/connect/google", "/api/google-sign-in"]) {
  test(`a released Gmail installation signs in and renews on ${path} unchanged`, async () => {
    const api = client(service, path);
    const status = released.status.parse(await (await fetch(api.url("/status"))).json());
    assert.equal(status.available, true);

    const { started, consent, returned } = await api.signIn();
    assertReleasedAuthorizeUrl(path, released.start.parse(started.body));
    assert.equal(
      consent.upstream!.searchParams.get("scope"),
      [...IDENTITY_SCOPES, ...GMAIL_SCOPES].join(" "),
    );
    assert.equal(
      consent.upstream!.searchParams.get("redirect_uri"),
      `${PUBLIC_URL}${path}/callback`,
    );
    assert.equal(returned.status, 200);

    const result = released.poll.parse(
      (await api.poll(started.body.requestId, started.codeVerifier)).body,
    );
    assert.equal(result.status, "complete");
    if (result.status !== "complete") return;
    assert.ok(
      result.credential.scope.split(" ").includes("https://www.googleapis.com/auth/gmail.modify"),
    );

    const renewed = await api.post("/refresh", {
      clientId: result.credential.clientId,
      refreshToken: result.credential.refreshToken,
    });
    assert.equal(renewed.status, 200);
    released.refresh.parse(await renewed.json());
  });
}

test("the original Gmail path keeps its cookie prefix and window message names", async () => {
  const api = client(service, "/api/google-sign-in");
  const started = await api.start();
  const page = await api.page(started.body.requestId);
  assert.match(page.setCookie, /^genosyn_gmail_[0-9a-f]{24}=/);
  assert.match(page.setCookie, /Path=\/api\/google-sign-in/);
  assert.match(page.html, /"genosyn-google-sign-in-ready"/);
  assert.match(page.html, /"genosyn-google-sign-in-launch"/);
  assert.match(page.html, /action="\/api\/google-sign-in\/authorize"/);
  assert.match(page.html, /Connect Gmail/);
});

test("the original Gmail path accepts exactly the released start request", async () => {
  const api = client(service, "/api/google-sign-in");
  const named = await api.start({ scopes: [CALENDAR_SCOPE] });
  assert.equal(named.response.status, 400);
  const canonical = client(service);
  const accepted = await canonical.start({ scopes: [CALENDAR_SCOPE] });
  assert.equal(accepted.response.status, 200);
});

test("a sign-in started on one path cannot be continued on the other", async () => {
  const legacy = client(service, "/api/google-sign-in");
  const canonical = client(service);
  const started = await legacy.start();
  const crossedPage = await canonical.page(started.body.requestId);
  assert.equal(crossedPage.response.status, 400);
  assert.match(crossedPage.html, /expired or was already used/);
  assert.equal(
    (await canonical.poll(started.body.requestId, started.codeVerifier)).body.status,
    "denied",
  );

  const consent = await legacy.consent(started.body.requestId, started.browserProof);
  assert.equal(consent.response.status, 303);
  const cookieValue = consent.callbackCookie.split("=")[1];
  const crossedCallback = await canonical.callback(
    consent.state,
    `genosyn_connect_google_x=${cookieValue}`,
  );
  assert.equal(crossedCallback.status, 400);
  assert.equal(service.google.calls.length, 0);

  // The legacy sign-in itself is untouched by those attempts.
  assert.equal((await legacy.callback(consent.state, consent.callbackCookie)).status, 200);
  assert.equal(
    (await legacy.poll(started.body.requestId, started.codeVerifier)).body.status,
    "complete",
  );
});

test("when Gmail is not offered, the Gmail-only path is unavailable but other products are not", async () => {
  await service.close();
  service = await startTestService({
    config: {
      google: {
        clientId: "connect-client.apps.googleusercontent.com",
        clientSecret: "connect-client-secret",
        scopeGroups: ["calendar"],
      },
    },
  });
  const legacy = client(service, "/api/google-sign-in");
  const canonical = client(service);
  assert.deepEqual(await (await fetch(legacy.url("/status"))).json(), {
    version: 1,
    available: false,
    scopes: [],
  });
  assert.equal((await legacy.start()).response.status, 503);
  assert.deepEqual(await (await fetch(canonical.url("/status"))).json(), {
    version: 1,
    available: true,
    scopes: [CALENDAR_SCOPE],
  });
  const unnamed = await canonical.start();
  assert.equal(unnamed.response.status, 400);
  assert.match(unnamed.body.error ?? "", /does not offer Gmail/);
  assert.equal((await canonical.start({ scopes: [CALENDAR_SCOPE] })).response.status, 200);

  // Connections issued while Gmail was offered still renew.
  const renewed = await legacy.post("/refresh", {
    clientId: "connect-client.apps.googleusercontent.com",
    refreshToken: "issued-earlier",
  });
  assert.equal(renewed.status, 200);
});
