import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { z } from "zod";
import {
  CALENDAR_SCOPE,
  client,
  digest,
  GMAIL_SCOPES,
  GMAIL_SETTINGS_SCOPE,
  IDENTITY_SCOPES,
  INSTALLATION,
  random,
  RELEASED_GMAIL_SCOPES,
  startTestService,
  type TestService,
} from "./helpers.js";

/**
 * Installations released before protocol 2 (1.227 up to it) speak protocol 1:
 * the credential waits on the service until they poll for it. Protocol 2 keeps
 * nothing to poll, so those installations must read the service as "not
 * available here" and offer their own OAuth app instead — never start a
 * sign-in they cannot finish — while every Connection they already hold keeps
 * renewing on the path that issued it. These schemas are copied from those
 * releases; if a change here satisfies `status` or breaks `refresh`, those
 * installations break.
 */
const released = {
  status: z.object({
    version: z.literal(1),
    available: z.boolean(),
    scopes: z.array(z.string().min(1).max(256)).max(256).optional(),
  }),
  refresh: z.object({
    accessToken: z.string().min(1).max(16_384),
    expiresAt: z.number().finite().positive(),
    refreshToken: z.string().min(1).max(16_384).optional(),
    scope: z.string().max(8192).optional(),
  }),
};
const LEGACY = "/api/google-sign-in";

let service: TestService;
beforeEach(async () => {
  service = await startTestService();
});
afterEach(async () => {
  await service.close();
});

test("a released installation reads protocol 2 as not available here", async () => {
  const canonical = await fetch(client(service).url("/status"));
  assert.equal(canonical.status, 200, "a 404 would send the newest release to the legacy path");
  assert.equal(released.status.safeParse(await canonical.json()).success, false);
  const legacy = await fetch(`${service.base}${LEGACY}/status`);
  assert.equal(legacy.status, 404);
});

test("a released start request is refused before anything is sealed or shown", async () => {
  const v1 = {
    codeChallenge: digest(random()),
    browserChallenge: digest(random()),
    installationOrigin: INSTALLATION,
  };
  const canonical = client(service);
  for (const body of [v1, { ...v1, scopes: RELEASED_GMAIL_SCOPES }]) {
    const response = await canonical.post("/start", body);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Invalid request" });
  }
  const legacy = client(service, LEGACY);
  assert.equal((await legacy.post("/start", v1)).status, 404);
  for (const api of [canonical, legacy]) {
    const poll = await api.post("/poll", { requestId: random(), codeVerifier: random() });
    assert.equal(poll.status, 404);
  }
  assert.equal((await fetch(legacy.url(`/authorize?requestId=${random()}`))).status, 404);
  assert.equal((await fetch(legacy.url(`/callback?state=${random()}&code=c`))).status, 404);
  assert.equal(service.google.calls.length, 0);
});

for (const path of ["/api/connect/google", LEGACY]) {
  test(`a Connection issued on ${path} keeps renewing there unchanged`, async () => {
    const api = client(service, path);
    const clientId = service.config.google!.clientId;
    const renewed = await api.post("/refresh", { clientId, refreshToken: "issued-earlier" });
    assert.equal(renewed.status, 200);
    const body = released.refresh.parse(await renewed.json());
    assert.equal(body.accessToken, "refreshed-access");
    const call = service.google.calls.at(-1)!;
    assert.equal(call.body.get("refresh_token"), "issued-earlier");
    assert.equal(call.body.get("client_secret"), service.config.google!.clientSecret);

    const wrong = await api.post("/refresh", { clientId: "another-client", refreshToken: "r" });
    assert.equal(wrong.status, 401);
    const browser = await fetch(api.url("/refresh"), {
      method: "POST",
      headers: { "content-type": "application/json", origin: INSTALLATION },
      body: JSON.stringify({ clientId, refreshToken: "r" }),
    });
    assert.equal(browser.status, 403);
  });
}

test("a release that still names Gmail settings access signs in, and Google is asked for Gmail alone", async () => {
  // Releases before 1.253.1 start only when status offers every scope they
  // name, and accept the credential once gmail.modify is granted.
  const api = client(service);
  const status = (await (await fetch(api.url("/status"))).json()) as { scopes: string[] };
  for (const scope of RELEASED_GMAIL_SCOPES) assert.ok(status.scopes.includes(scope), scope);

  const { consent, delivered } = await api.signIn({
    scopes: [...IDENTITY_SCOPES, ...RELEASED_GMAIL_SCOPES],
  });
  const asked = [...IDENTITY_SCOPES, ...GMAIL_SCOPES].join(" ");
  assert.equal(consent.upstream!.searchParams.get("scope"), asked);
  assert.match(consent.page.html, /Connect Gmail/);
  assert.equal(delivered.credential!.scope, asked);

  const settingsOnly = await api.start({ scopes: [GMAIL_SETTINGS_SCOPE] });
  assert.equal(settingsOnly.response.status, 400);
  assert.match(settingsOnly.body.error ?? "", /at least one product/);
});

test("Connections renew after the operator stops offering their product", async () => {
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
  const canonical = client(service);
  for (const scopes of [GMAIL_SCOPES, RELEASED_GMAIL_SCOPES]) {
    const refused = await canonical.start({ scopes });
    assert.equal(refused.response.status, 400);
    assert.match(refused.body.error ?? "", /does not offer Gmail\. /);
  }
  assert.equal((await canonical.start({ scopes: [CALENDAR_SCOPE] })).response.status, 200);
  for (const path of ["/api/connect/google", LEGACY]) {
    const renewed = await client(service, path).post("/refresh", {
      clientId: "connect-client.apps.googleusercontent.com",
      refreshToken: "issued-while-gmail-was-offered",
    });
    assert.equal(renewed.status, 200, path);
  }
});

test("without a Google client the released path has nothing to renew with", async () => {
  await service.close();
  service = await startTestService({ config: { google: null } });
  const renewed = await client(service, LEGACY).post("/refresh", {
    clientId: "connect-client.apps.googleusercontent.com",
    refreshToken: "r",
  });
  assert.equal(renewed.status, 503);
});
