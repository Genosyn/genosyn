import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  CALENDAR_SCOPE,
  client,
  digest,
  GMAIL_SCOPES,
  IDENTITY_SCOPES,
  INSTALLATION,
  PUBLIC_URL,
  random,
  startTestService,
  type TestService,
} from "./helpers.js";

let service: TestService;
let api: ReturnType<typeof client>;

beforeEach(async () => {
  service = await startTestService();
  api = client(service);
});
afterEach(async () => {
  await service.close();
});

test("discovery lists every known provider with only the scopes the operator offers", async () => {
  const index = (await (await fetch(`${service.base}/api/connect`)).json()) as {
    version: number;
    providers: Array<{
      id: string;
      available: boolean;
      scopes: string[];
      groups: Array<{ key: string }>;
    }>;
  };
  assert.equal(index.version, 1);
  assert.deepEqual(
    index.providers.map((provider) => provider.id),
    ["google"],
  );
  assert.equal(index.providers[0].available, true);
  assert.deepEqual(index.providers[0].scopes, [...GMAIL_SCOPES, CALENDAR_SCOPE]);
  assert.deepEqual(
    index.providers[0].groups.map((group) => group.key),
    ["gmail", "calendar"],
  );

  const status = await fetch(api.url("/status"));
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), {
    version: 1,
    available: true,
    scopes: [...GMAIL_SCOPES, CALENDAR_SCOPE],
  });
  assert.equal((await fetch(api.url("/status?probe=1"))).status, 400);
  const unknown = await fetch(`${service.base}/api/connect/github/status`);
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: "Sign-in provider not found" });
  assert.equal((await fetch(`${service.base}/api/connect/Google/status`)).status, 404);
});

test("an unconfigured provider reports unavailable and refuses every operation", async () => {
  await service.close();
  service = await startTestService({ config: { google: null } });
  api = client(service);
  assert.deepEqual(await (await fetch(api.url("/status"))).json(), {
    version: 1,
    available: false,
    scopes: [],
  });
  const started = await api.start();
  assert.equal(started.response.status, 503);
  assert.match(started.body.error ?? "", /unavailable/);
  const refresh = await api.post("/refresh", { clientId: "x", refreshToken: "y" });
  assert.equal(refresh.status, 503);
  assert.equal(service.google.calls.length, 0);
});

test("a default Gmail sign-in reaches Google with PKCE and hands the credential over exactly once", async () => {
  const { started, consent, returned } = await api.signIn();
  assert.equal(
    started.body.authorizeUrl,
    `${PUBLIC_URL}/api/connect/google/authorize?requestId=${started.body.requestId}`,
  );
  assert.ok(started.body.expiresAt <= Date.now() + 10 * 60_000);

  const upstream = consent.upstream!;
  assert.equal(upstream.origin + upstream.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  const params = Object.fromEntries(upstream.searchParams);
  assert.equal(params.client_id, service.config.google!.clientId);
  assert.equal(params.redirect_uri, `${PUBLIC_URL}/api/connect/google/callback`);
  assert.equal(params.response_type, "code");
  assert.equal(params.scope, [...IDENTITY_SCOPES, ...GMAIL_SCOPES].join(" "));
  assert.equal(params.access_type, "offline");
  assert.equal(params.prompt, "consent");
  assert.equal(params.include_granted_scopes, "false");
  assert.equal(params.code_challenge_method, "S256");
  assert.match(params.code_challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(params.state, consent.state);
  assert.equal(consent.response.headers.get("referrer-policy"), "no-referrer");

  assert.equal(returned.status, 200);
  const page = await returned.text();
  assert.match(page, /Google is connected/);
  assert.match(page, /window\.close/);

  const exchange = service.google.calls.find(
    (call) => call.body.get("grant_type") === "authorization_code",
  )!;
  assert.equal(exchange.body.get("client_secret"), service.config.google!.clientSecret);
  assert.equal(exchange.body.get("code"), "google-auth-code");
  assert.equal(exchange.body.get("redirect_uri"), `${PUBLIC_URL}/api/connect/google/callback`);
  assert.equal(digest(exchange.body.get("code_verifier")!), params.code_challenge);

  const first = await api.poll(started.body.requestId, started.codeVerifier);
  assert.equal(first.response.status, 200);
  assert.equal(first.body.status, "complete");
  const credential = first.body.credential as Record<string, unknown>;
  assert.equal(credential.clientId, service.config.google!.clientId);
  assert.equal(credential.accessToken, "google-access-token");
  assert.equal(credential.refreshToken, "google-refresh-token");
  assert.equal(credential.email, "member@gmail.com");
  assert.equal(credential.account, "member@gmail.com");
  assert.equal(credential.scope, [...IDENTITY_SCOPES, ...GMAIL_SCOPES].join(" "));
  assert.ok(typeof credential.expiresAt === "number" && credential.expiresAt > Date.now());
  assert.equal(JSON.stringify(first.body).includes(service.config.google!.clientSecret), false);

  const replay = await api.poll(started.body.requestId, started.codeVerifier);
  assert.equal(replay.body.status, "denied");
  assert.equal("credential" in replay.body, false);
});

test("named scopes are requested with the identity scopes, and a partial grant is returned as granted", async () => {
  service.google.state.grantedScope = [...IDENTITY_SCOPES, CALENDAR_SCOPE].join(" ");
  const { started, consent } = await api.signIn({ scopes: [CALENDAR_SCOPE, CALENDAR_SCOPE] });
  assert.equal(
    consent.upstream!.searchParams.get("scope"),
    [...IDENTITY_SCOPES, CALENDAR_SCOPE].join(" "),
  );
  assert.match(consent.page.html, /Connect Calendar/);
  assert.doesNotMatch(consent.page.html, /Gmail/);
  const result = await api.poll(started.body.requestId, started.codeVerifier);
  assert.equal(result.body.status, "complete");
  assert.equal(
    (result.body.credential as { scope: string }).scope,
    [...IDENTITY_SCOPES, CALENDAR_SCOPE].join(" "),
  );

  // Granular consent: the person unticked Calendar but kept Gmail. A client
  // that named its scopes decides for itself whether that is enough.
  service.google.state.grantedScope = [...IDENTITY_SCOPES, ...GMAIL_SCOPES].join(" ");
  const partial = await api.signIn({ scopes: [...GMAIL_SCOPES, CALENDAR_SCOPE] });
  assert.match(partial.consent.page.html, /Connect Google/);
  assert.match(partial.consent.page.html, /Gmail/);
  assert.match(partial.consent.page.html, /Calendar/);
  const kept = await api.poll(partial.started.body.requestId, partial.started.codeVerifier);
  assert.equal(kept.body.status, "complete");
});

test("scopes the operator does not offer are refused before anyone reaches a consent screen", async () => {
  const drive = await api.start({ scopes: ["https://www.googleapis.com/auth/drive"] });
  assert.equal(drive.response.status, 400);
  assert.match(drive.body.error ?? "", /does not offer Drive/);
  const unknown = await api.start({ scopes: ["https://example.com/auth/everything"] });
  assert.equal(unknown.response.status, 400);
  assert.match(unknown.body.error ?? "", /https:\/\/example\.com\/auth\/everything/);
  const identityOnly = await api.start({ scopes: IDENTITY_SCOPES });
  assert.equal(identityOnly.response.status, 400);
  assert.match(identityOnly.body.error ?? "", /at least one product/);
  for (const scopes of [
    [],
    ["has space"],
    Array(33).fill(CALENDAR_SCOPE),
    ["x".repeat(257)],
    "openid",
  ]) {
    assert.equal((await api.start({ scopes })).response.status, 400);
  }
  assert.equal(service.google.calls.length, 0);
});

test("a default request whose grant lacks Gmail is denied; the installation learns why", async () => {
  service.google.state.grantedScope = IDENTITY_SCOPES.join(" ");
  const { started, returned } = await api.signIn();
  assert.match(await returned.text(), /did not grant the access Gmail needs/);
  const result = await api.poll(started.body.requestId, started.codeVerifier);
  assert.deepEqual(result.body, {
    status: "denied",
    detail: "Google did not grant the access Gmail needs. Connect again and allow Gmail access.",
  });
});

test("the consent page names the installation and its access, behind strict headers and a private cookie", async () => {
  const started = await api.start({ scopes: [...GMAIL_SCOPES, CALENDAR_SCOPE] });
  const page = await api.page(started.body.requestId);
  assert.equal(page.response.status, 200);
  assert.match(page.html, new RegExp(INSTALLATION.replace(/[.]/g, "\\.")));
  assert.match(page.html, /<strong>Gmail<\/strong>/);
  assert.match(page.html, /<strong>Calendar<\/strong>/);
  assert.match(page.html, /id="continue" type="submit" disabled>Continue with Google</);
  assert.match(page.html, /event\.source!==window\.opener\|\|event\.origin!==origin/);
  assert.match(page.html, /"genosyn-sign-in-ready"/);
  assert.match(page.html, /"genosyn-sign-in-launch"/);

  const csp = page.response.headers.get("content-security-policy")!;
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /form-action 'self' https:\/\/accounts\.google\.com/);
  const scriptNonce = /script-src 'nonce-([A-Za-z0-9_-]+)'/.exec(csp)![1];
  const styleNonce = /style-src 'nonce-([A-Za-z0-9_-]+)'/.exec(csp)![1];
  assert.match(page.html, new RegExp(`<script nonce="${scriptNonce}">`));
  assert.match(page.html, new RegExp(`<style nonce="${styleNonce}">`));
  assert.equal(page.response.headers.get("cross-origin-opener-policy"), "unsafe-none");
  assert.equal(page.response.headers.get("referrer-policy"), "same-origin");
  assert.equal(page.response.headers.get("cache-control"), "no-store");
  assert.equal(page.response.headers.get("x-frame-options"), "DENY");

  assert.match(page.setCookie, /^genosyn_connect_google_[0-9a-f]{24}=[A-Za-z0-9_-]{43};/);
  assert.match(page.setCookie, /Path=\/api\/connect\/google/);
  assert.match(page.setCookie, /HttpOnly/);
  assert.match(page.setCookie, /Secure/);
  assert.match(page.setCookie, /SameSite=Lax/);
  assert.match(page.setCookie, /Max-Age=(\d+)/);
  assert.ok(Number(/Max-Age=(\d+)/.exec(page.setCookie)![1]) <= 600);
});

test("the consent POST must come from the consent page, in the same browser, with the installation's proof", async () => {
  const started = await api.start();
  const { requestId } = started.body;
  for (const overrides of [
    { origin: "https://evil.example" },
    { origin: null },
    { origin: "http://127.0.0.1" },
    { cookie: "genosyn_connect_google_000000000000000000000000=" + random() },
    { csrfToken: random() },
  ]) {
    const refused = await api.consent(requestId, started.browserProof, overrides);
    assert.equal(refused.response.status, 403, JSON.stringify(overrides));
    assert.match(await refused.response.text(), /did not come from the sign-in page/);
  }
  const wrongProof = await api.consent(requestId, random());
  assert.equal(wrongProof.response.status, 403);
  assert.match(await wrongProof.response.text(), /open sign-in again/);

  const crossSite = await api.page(requestId);
  const crossSiteResponse = await fetch(api.url("/authorize"), {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: PUBLIC_URL,
      "sec-fetch-site": "cross-site",
      cookie: crossSite.cookie,
    },
    body: new URLSearchParams({
      requestId,
      csrfToken: crossSite.nonce,
      browserProof: started.browserProof,
    }),
  });
  assert.equal(crossSiteResponse.status, 403);

  // None of the refusals used the sign-in up; the genuine browser still can.
  const genuine = await api.consent(requestId, started.browserProof);
  assert.equal(genuine.response.status, 303);
  assert.equal(service.google.calls.length, 0);
  const again = await api.page(requestId);
  assert.equal(again.response.status, 400);
  assert.match(again.html, /expired or was already used/);
});

test("a malformed consent form gets a page, not a stack trace", async () => {
  const started = await api.start();
  const page = await api.page(started.body.requestId);
  for (const body of [
    "requestId=short",
    `requestId=${started.body.requestId}&csrfToken=${page.nonce}`,
    `requestId=${started.body.requestId}&csrfToken=${page.nonce}&browserProof=${started.browserProof}&extra=1`,
    "x=".padEnd(5000, "a"),
  ]) {
    const response = await fetch(api.url("/authorize"), {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: PUBLIC_URL,
        cookie: page.cookie,
        accept: "text/html",
      },
      body,
    });
    assert.ok([400, 413].includes(response.status), `${response.status} for ${body.slice(0, 40)}`);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  }
});

test("reloading the consent page retires the page that was open before", async () => {
  const started = await api.start();
  const first = await api.page(started.body.requestId);
  const second = await api.page(started.body.requestId);
  assert.notEqual(first.nonce, second.nonce);
  const stale = await api.consent(started.body.requestId, started.browserProof, {
    cookie: first.cookie,
    csrfToken: first.nonce,
  });
  // `consent` loads a third page; replaying the first one's pair must fail.
  assert.equal(stale.response.status, 403);
  const fresh = await api.consent(started.body.requestId, started.browserProof);
  assert.equal(fresh.response.status, 303);
});

test("the provider must return to the browser that consented, and a callback works once", async () => {
  const started = await api.start();
  const consent = await api.consent(started.body.requestId, started.browserProof);
  const otherBrowser = await api.callback(
    consent.state,
    `${consent.callbackCookie.split("=")[0]}=${random()}`,
  );
  assert.equal(otherBrowser.status, 403);
  assert.match(await otherBrowser.text(), /browser where you started it/);
  const noCookie = await api.callback(consent.state, "");
  assert.equal(noCookie.status, 403);
  assert.equal(service.google.calls.length, 0, "a foreign browser cannot redeem the code");

  const genuine = await api.callback(consent.state, consent.callbackCookie);
  assert.equal(genuine.status, 200);
  const cleared = genuine.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(consent.callbackCookie.split("=")[0]));
  assert.match(cleared ?? "", /Max-Age=0|Expires=Thu, 01 Jan 1970/);
  const replay = await api.callback(consent.state, consent.callbackCookie);
  assert.equal(replay.status, 400);
  assert.match(await replay.text(), /expired or was already used/);
  assert.equal(
    service.google.calls.filter((call) => call.body.get("grant_type") === "authorization_code")
      .length,
    1,
  );
  for (const query of [
    "",
    "state=short&code=x",
    `state=${consent.state}`,
    `state=${consent.state}&code=a&error=b`,
  ]) {
    const response = await fetch(api.url(`/callback?${query}`), {
      headers: { accept: "text/html" },
    });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /not valid/);
  }
});

test("providers may add their own callback parameters", async () => {
  const { started, returned } = await api.signIn(
    {},
    "code=google-auth-code&scope=openid&authuser=0&prompt=consent&iss=https%3A%2F%2Faccounts.google.com",
  );
  assert.equal(returned.status, 200);
  const result = await api.poll(started.body.requestId, started.codeVerifier);
  assert.equal(result.body.status, "complete");
});

test("cancelled consent and failed exchanges reach the installation without upstream detail", async () => {
  const cancelled = await api.signIn({}, "error=access_denied");
  assert.match(await cancelled.returned.text(), /Sign-in not completed/);
  assert.deepEqual(
    (await api.poll(cancelled.started.body.requestId, cancelled.started.codeVerifier)).body,
    {
      status: "denied",
      detail: "Google sign-in was cancelled. Return to your Genosyn installation to try again.",
    },
  );

  service.google.state.tokenStatus = 500;
  service.google.state.tokenBody = {
    error: "internal",
    error_description: "secret upstream detail",
  };
  const failed = await api.signIn();
  const failedPage = await failed.returned.text();
  assert.doesNotMatch(failedPage, /secret upstream detail/);
  const failedPoll = await api.poll(failed.started.body.requestId, failed.started.codeVerifier);
  assert.equal(failedPoll.body.status, "denied");
  assert.doesNotMatch(JSON.stringify(failedPoll.body), /secret upstream detail|internal/);

  service.google.state.tokenStatus = 200;
  service.google.state.tokenBody = {};
  service.google.state.profile = { email: "member@gmail.com", email_verified: false };
  const unverified = await api.signIn();
  const unverifiedPoll = await api.poll(
    unverified.started.body.requestId,
    unverified.started.codeVerifier,
  );
  assert.equal(unverifiedPoll.body.status, "denied");
  assert.match(String(unverifiedPoll.body.detail), /verified email/);

  service.google.state.profile = { email: "member@gmail.com", email_verified: true };
  service.google.state.tokenBody = {
    access_token: "a",
    expires_in: 3600,
    token_type: "Bearer",
    scope: "openid",
  };
  const noRefresh = await api.signIn({ scopes: [CALENDAR_SCOPE] });
  const noRefreshPoll = await api.poll(
    noRefresh.started.body.requestId,
    noRefresh.started.codeVerifier,
  );
  assert.equal(noRefreshPoll.body.status, "denied");
  assert.match(String(noRefreshPoll.body.detail), /offline access/);
});

test("collecting the result needs the start verifier; wrong guesses are rate limited", async () => {
  const started = await api.start();
  assert.deepEqual((await api.poll(started.body.requestId, started.codeVerifier)).body, {
    status: "pending",
  });
  // Ten wrong guesses are tolerated; the eleventh shuts the address out.
  for (let attempt = 0; attempt < 11; attempt++) {
    const wrong = await api.poll(started.body.requestId, random());
    assert.equal(wrong.response.status, 403);
  }
  const blocked = await api.poll(started.body.requestId, started.codeVerifier);
  assert.equal(blocked.response.status, 429);
  assert.ok(Number(blocked.response.headers.get("retry-after")) > 0);
  const unknown = await api.poll(random(), random());
  assert.equal(unknown.response.status, 429);
});

test("an unknown or expired request is denied, never pending forever", async () => {
  assert.deepEqual((await api.poll(random(), random())).body, {
    status: "denied",
    detail: "This sign-in expired or was already used. Connect again from your installation.",
  });
});

test("concurrent polls release a completed credential exactly once", async () => {
  const { started } = await api.signIn();
  const results = await Promise.all(
    Array.from({ length: 8 }, () => api.poll(started.body.requestId, started.codeVerifier)),
  );
  assert.equal(results.filter((result) => result.body.status === "complete").length, 1);
  assert.equal(results.filter((result) => result.body.status === "denied").length, 7);
});

test("sign-ins expire after ten minutes at every step", async () => {
  await service.close();
  let offset = 0;
  service = await startTestService({ now: () => Date.now() + offset });
  api = client(service);
  const started = await api.start();
  const consent = await api.consent(started.body.requestId, started.browserProof);
  const unopened = await api.start();
  offset = 10 * 60_000 + 1;
  const page = await api.page(unopened.body.requestId);
  assert.equal(page.response.status, 400);
  assert.match(page.html, /expired or was already used/);
  const callback = await api.callback(consent.state, consent.callbackCookie);
  assert.equal(callback.status, 400);
  assert.equal(service.google.calls.length, 0);
  assert.equal(
    (await api.poll(started.body.requestId, started.codeVerifier)).body.status,
    "denied",
  );
});

test("renewal uses only this service's client, keeps no state, and hides upstream detail", async () => {
  const clientId = service.config.google!.clientId;
  const wrong = await api.post("/refresh", { clientId: "someone-else", refreshToken: "r" });
  assert.equal(wrong.status, 401);
  assert.deepEqual(await wrong.json(), {
    error: "The sign-in registration changed. Connect again.",
  });
  assert.equal(service.google.calls.length, 0);

  const renewed = await api.post("/refresh", { clientId, refreshToken: "google-refresh-token" });
  assert.equal(renewed.status, 200);
  const body = (await renewed.json()) as Record<string, unknown>;
  assert.equal(body.accessToken, "refreshed-access");
  assert.ok(typeof body.expiresAt === "number" && body.expiresAt > Date.now());
  assert.equal("refreshToken" in body, false);
  const call = service.google.calls.at(-1)!;
  assert.equal(call.body.get("grant_type"), "refresh_token");
  assert.equal(call.body.get("refresh_token"), "google-refresh-token");
  assert.equal(call.body.get("client_secret"), service.config.google!.clientSecret);

  service.google.state.refreshBody = {
    access_token: "rotated-access",
    refresh_token: "rotated-refresh",
    expires_in: 3600,
    scope: "openid",
    token_type: "Bearer",
  };
  const rotated = (await (
    await api.post("/refresh", { clientId, refreshToken: "r2" })
  ).json()) as Record<string, unknown>;
  assert.equal(rotated.refreshToken, "rotated-refresh");
  assert.equal(rotated.scope, "openid");

  service.google.state.refreshStatus = 400;
  service.google.state.refreshBody = {
    error: "invalid_grant",
    error_description: "Token has been expired or revoked.",
  };
  const revoked = await api.post("/refresh", { clientId, refreshToken: "revoked" });
  assert.equal(revoked.status, 401);
  assert.deepEqual(await revoked.json(), {
    error: "Google access expired or was revoked. Connect again.",
  });

  service.google.state.refreshStatus = 503;
  service.google.state.refreshBody = {
    error: "backendError",
    error_description: "upstream secret",
  };
  const outage = await api.post("/refresh", { clientId, refreshToken: "outage" });
  assert.equal(outage.status, 502);
  assert.doesNotMatch(await outage.text(), /upstream secret|backendError/);
  assert.equal(await service.store.sweep(), 0, "renewal stores nothing");
});

test("renewal is budgeted per token, and repeated rejections per address", async () => {
  const clientId = service.config.google!.clientId;
  for (let attempt = 0; attempt < 20; attempt++) {
    assert.equal((await api.post("/refresh", { clientId, refreshToken: "busy" })).status, 200);
  }
  const limited = await api.post("/refresh", { clientId, refreshToken: "busy" });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.equal(
    (await api.post("/refresh", { clientId, refreshToken: "another-mailbox" })).status,
    200,
  );

  // A Google outage is not the installation's fault and must not lock it out.
  service.google.state.refreshStatus = 503;
  for (let attempt = 0; attempt < 35; attempt++) {
    assert.equal(
      (await api.post("/refresh", { clientId, refreshToken: `outage-${attempt}` })).status,
      502,
    );
  }
  service.google.state.refreshStatus = 200;
  assert.equal((await api.post("/refresh", { clientId, refreshToken: "recovered" })).status, 200);

  for (let attempt = 0; attempt < 31; attempt++) {
    assert.equal(
      (await api.post("/refresh", { clientId: "wrong", refreshToken: `guess-${attempt}` })).status,
      401,
    );
  }
  assert.equal(
    (await api.post("/refresh", { clientId, refreshToken: "after-guessing" })).status,
    429,
  );
});

test("installation endpoints refuse browsers and malformed requests", async () => {
  const body = {
    codeChallenge: digest(random()),
    browserChallenge: digest(random()),
    installationOrigin: INSTALLATION,
  };
  const browserHeaders: Array<Record<string, string>> = [
    { origin: INSTALLATION },
    { origin: "null" },
    { "sec-fetch-site": "same-origin" },
  ];
  for (const headers of browserHeaders) {
    const response = await api.post("/start", body, headers);
    assert.equal(response.status, 403);
  }
  const textPlain = await fetch(api.url("/start"), {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify(body),
  });
  assert.equal(textPlain.status, 415);
  const malformed = await fetch(api.url("/start"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: "Invalid request" });
  const large = await api.post("/start", {
    ...body,
    installationOrigin: `https://${"a".repeat(30_000)}.example`,
  });
  assert.equal(large.status, 413);
  for (const invalid of [
    { ...body, extra: true },
    { ...body, codeChallenge: "short" },
    { ...body, installationOrigin: "" },
    { ...body, installationOrigin: "javascript:alert(1)" },
    { ...body, installationOrigin: "https://user:pass@nas.example" },
    { ...body, installationOrigin: "https://nas.example/path" },
    { ...body, installationOrigin: "file:///etc/passwd" },
  ]) {
    assert.equal(
      (await api.post("/start", invalid)).status,
      400,
      JSON.stringify(invalid).slice(0, 80),
    );
  }
  assert.equal(
    (await api.post("/poll", { requestId: random(), codeVerifier: "short" })).status,
    400,
  );
  assert.equal(
    (await api.post("/refresh", { clientId: "a", refreshToken: "b", extra: 1 })).status,
    400,
  );
  assert.equal(
    (await api.post("/refresh", { clientId: "a", refreshToken: "x".repeat(16_385) })).status,
    400,
  );
  assert.equal(service.google.calls.length, 0);
});

test("starting is rate limited per address, and the legacy path shares the budget", async () => {
  const legacy = client(service, "/api/google-sign-in");
  for (let attempt = 0; attempt < 30; attempt++) {
    const started = await (attempt % 2 ? legacy : api).start();
    assert.equal(started.response.status, 200, `attempt ${attempt}`);
  }
  const limited = await api.start();
  assert.equal(limited.response.status, 429);
  assert.equal((await legacy.start()).response.status, 429);
});

test("only the configured number of proxies decides which address is limited", async () => {
  const startFrom = (forwardedFor: string) =>
    api.post(
      "/start",
      {
        codeChallenge: digest(random()),
        browserChallenge: digest(random()),
        installationOrigin: INSTALLATION,
      },
      { "x-forwarded-for": forwardedFor },
    );
  for (let attempt = 0; attempt < 30; attempt++) {
    assert.equal((await startFrom(`203.0.113.${attempt}`)).status, 200);
  }
  // Without trusted proxies a forged header changes nothing: one address.
  assert.equal((await startFrom("198.51.100.7")).status, 429);

  await service.close();
  service = await startTestService({ config: { trustedProxyHops: 1 } });
  api = client(service);
  for (let attempt = 0; attempt < 30; attempt++) {
    assert.equal((await startFrom("203.0.113.10")).status, 200);
  }
  assert.equal((await startFrom("203.0.113.10")).status, 429);
  assert.equal((await startFrom("203.0.113.11")).status, 200);
});

test("every response carries the security headers and no framework fingerprint", async () => {
  for (const path of ["/", "/healthz", "/api/connect", "/api/connect/google/status", "/missing"]) {
    const response = await fetch(`${service.base}${path}`);
    assert.equal(response.headers.get("x-powered-by"), null, path);
    assert.equal(response.headers.get("cache-control"), "no-store", path);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", path);
    assert.equal(response.headers.get("x-frame-options"), "DENY", path);
    assert.equal(
      response.headers.get("strict-transport-security"),
      "max-age=31536000; includeSubDomains",
      path,
    );
    assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/, path);
    assert.match(
      response.headers.get("content-security-policy") ?? "",
      /frame-ancestors 'none'/,
      path,
    );
    assert.equal(response.headers.get("etag"), null, path);
  }
  await service.close();
  service = await startTestService({ config: { publicUrl: "http://localhost:8473" } });
  const local = await fetch(`${service.base}/healthz`);
  assert.equal(local.headers.get("strict-transport-security"), null);
});

test("unknown routes answer 404 as JSON, or as a page for a browser", async () => {
  const json = await fetch(`${service.base}/api/connect/google/nope`);
  assert.equal(json.status, 404);
  assert.deepEqual(await json.json(), { error: "Sign-in endpoint not found" });
  assert.equal(
    (await fetch(`${service.base}/api/connect/google/status`, { method: "POST" })).status,
    404,
  );
  const page = await fetch(`${service.base}/admin`, { headers: { accept: "text/html,*/*" } });
  assert.equal(page.status, 404);
  assert.match(await page.text(), /Page not found/);
  const api404 = await fetch(`${service.base}/api/health`);
  assert.equal(api404.status, 404);
  assert.deepEqual(await api404.json(), { error: "Not found" });
});

test("the landing page, icon and health checks", async () => {
  const landing = await fetch(service.base);
  assert.equal(landing.status, 200);
  const html = await landing.text();
  assert.match(html, /<h1>Genosyn Connect<\/h1>/);
  assert.match(html, /<strong>Google<\/strong><span>Gmail, Calendar<\/span>/);
  assert.doesNotMatch(html, /<script/);
  const csp = landing.headers.get("content-security-policy")!;
  assert.match(html, new RegExp(`<style nonce="${/style-src 'nonce-([^']+)'/.exec(csp)![1]}">`));

  const icon = await fetch(`${service.base}/favicon.svg`);
  assert.equal(icon.headers.get("content-type"), "image/svg+xml; charset=utf-8");
  assert.equal(icon.headers.get("cache-control"), "public, max-age=86400");
  assert.deepEqual(await (await fetch(`${service.base}/healthz`)).json(), { ok: true });
  assert.deepEqual(await (await fetch(`${service.base}/readyz`)).json(), { ok: true });
});

test("configured privacy and terms links appear on every page", async () => {
  await service.close();
  service = await startTestService({
    config: {
      links: {
        privacy: "https://genosyn.example/privacy",
        terms: "https://genosyn.example/terms?x=<b>",
      },
    },
  });
  api = client(service);
  const html = await (await fetch(service.base)).text();
  assert.match(html, /<a href="https:\/\/genosyn\.example\/privacy">Privacy<\/a>/);
  assert.match(html, /<a href="https:\/\/genosyn\.example\/terms\?x=&lt;b&gt;">Terms<\/a>/);
  const started = await api.start();
  assert.match((await api.page(started.body.requestId)).html, /Privacy<\/a>/);
});
