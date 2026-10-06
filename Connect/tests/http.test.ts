import assert from "node:assert/strict";
import crypto from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { GOOGLE_SCOPE_GROUPS } from "../src/providers/google.js";
import { createSealer } from "../src/secrets.js";
import { createTokens } from "../src/tokens.js";
import {
  CALENDAR_SCOPE,
  client,
  digest,
  DRIVE_SCOPE,
  GMAIL_SCOPES,
  IDENTITY_SCOPES,
  INSTALLATION,
  PUBLIC_URL,
  random,
  readReturn,
  RETURN_URL,
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

test("discovery reports protocol version 2 and only the scopes the operator offers", async () => {
  const index = (await (await fetch(`${service.base}/api/connect`)).json()) as {
    version: number;
    providers: Array<{
      id: string;
      available: boolean;
      scopes: string[];
      groups: Array<{ key: string }>;
    }>;
  };
  assert.equal(index.version, 2);
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
  assert.deepEqual(await (await fetch(api.url("/status"))).json(), {
    version: 2,
    available: true,
    scopes: [...GMAIL_SCOPES, CALENDAR_SCOPE],
  });
  assert.equal((await fetch(api.url("/status?probe=1"))).status, 400);
  assert.equal((await fetch(`${service.base}/api/connect/github/status`)).status, 404);
  assert.equal((await fetch(`${service.base}/api/connect/Google/status`)).status, 404);
});

test("an unconfigured provider reports unavailable and refuses every operation", async () => {
  await service.close();
  service = await startTestService({ config: { google: null } });
  api = client(service);
  assert.deepEqual(await (await fetch(api.url("/status"))).json(), {
    version: 2,
    available: false,
    scopes: [],
  });
  const started = await api.start();
  assert.equal(started.response.status, 503);
  assert.equal((await api.post("/refresh", { clientId: "x", refreshToken: "y" })).status, 503);
  assert.equal(service.google.calls.length, 0);
});

test("a sign-in keeps nothing on the service and returns the credential encrypted to the installation", async () => {
  const { started, consent, returned, delivered } = await api.signIn();
  assert.match(started.body.requestId, /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
  assert.equal(
    started.body.authorizeUrl,
    `${PUBLIC_URL}/api/connect/google/authorize?requestId=${started.body.requestId}`,
  );
  assert.ok(started.body.expiresAt <= Date.now() + 10 * 60_000);
  for (const secret of [started.resultKey, started.state, started.browserProof]) {
    assert.equal(started.body.requestId.includes(secret), false, "the request id is sealed");
  }

  const upstream = consent.upstream!;
  assert.equal(upstream.origin + upstream.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  const params = Object.fromEntries(upstream.searchParams);
  assert.equal(params.client_id, service.config.google!.clientId);
  assert.equal(params.redirect_uri, `${PUBLIC_URL}/api/connect/google/callback`);
  assert.equal(params.scope, [...IDENTITY_SCOPES, ...GMAIL_SCOPES].join(" "));
  assert.equal(params.access_type, "offline");
  assert.equal(params.prompt, "consent");
  assert.equal(params.include_granted_scopes, "false");
  assert.equal(params.code_challenge_method, "S256");
  assert.match(params.state, /^v1\./, "the provider's state is a sealed token too");
  for (const secret of [started.resultKey, started.state]) {
    assert.equal(params.state.includes(secret), false);
  }

  const exchange = service.google.calls.find(
    (call) => call.body.get("grant_type") === "authorization_code",
  )!;
  assert.equal(exchange.body.get("client_secret"), service.config.google!.clientSecret);
  assert.equal(digest(exchange.body.get("code_verifier")!), params.code_challenge);

  assert.equal(returned.headers.get("referrer-policy"), "no-referrer");
  assert.deepEqual(delivered.keys, ["state", "result"]);
  assert.equal(delivered.state, started.state, "the installation's correlation value comes back");
  assert.equal(delivered.error, null);
  const location = returned.headers.get("location")!;
  for (const secret of ["google-access-token", "google-refresh-token", "member@gmail.com"]) {
    assert.equal(location.includes(secret), false, "the browser sees only ciphertext");
  }
  assert.deepEqual(delivered.credential, {
    clientId: service.config.google!.clientId,
    accessToken: "google-access-token",
    refreshToken: "google-refresh-token",
    expiresAt: delivered.credential!.expiresAt,
    scope: [...IDENTITY_SCOPES, ...GMAIL_SCOPES].join(" "),
    email: "member@gmail.com",
    account: "member@gmail.com",
  });
  assert.ok((delivered.credential!.expiresAt as number) > Date.now());
  assert.equal(
    JSON.stringify(delivered.credential).includes(service.config.google!.clientSecret),
    false,
  );

  // Cleared on the way out: the same browser cannot run the callback again.
  const cleared = returned.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(consent.callbackCookie.split("=")[0]));
  assert.match(cleared ?? "", /Max-Age=0/);
});

test("the result opens only with the installation's key and only for its own sign-in", async () => {
  const { started, delivered } = await api.signIn();
  assert.ok(delivered.result);
  assert.equal(
    readReturn(`${RETURN_URL}#state=${started.state}&result=${delivered.result}`, {
      resultKey: random(),
      state: started.state,
    }).credential,
    null,
    "another key",
  );
  assert.equal(
    readReturn(`${RETURN_URL}#state=${random()}&result=${delivered.result}`, started).credential,
    null,
    "another sign-in's state",
  );
  const [iv, payload] = delivered.result!.split(".");
  const tampered = `${iv}.${payload.slice(0, -3)}${payload.at(-3) === "A" ? "B" : "A"}${payload.slice(-2)}`;
  assert.equal(
    readReturn(`${RETURN_URL}#state=${started.state}&result=${tampered}`, started).credential,
    null,
  );
});

test("named scopes are requested with the identity scopes, and a partial grant is returned as granted", async () => {
  service.google.state.grantedScope = [...IDENTITY_SCOPES, CALENDAR_SCOPE].join(" ");
  const calendar = await api.signIn({ scopes: [CALENDAR_SCOPE, CALENDAR_SCOPE] });
  assert.equal(
    calendar.consent.upstream!.searchParams.get("scope"),
    [...IDENTITY_SCOPES, CALENDAR_SCOPE].join(" "),
  );
  assert.match(calendar.consent.page.html, /Connect Calendar/);
  assert.doesNotMatch(calendar.consent.page.html, /Gmail/);
  assert.equal(
    calendar.delivered.credential!.scope,
    [...IDENTITY_SCOPES, CALENDAR_SCOPE].join(" "),
  );

  // Granular consent: the person kept Gmail and unticked Calendar. The
  // installation, which decrypts the result, decides whether that is enough.
  service.google.state.grantedScope = [...IDENTITY_SCOPES, ...GMAIL_SCOPES].join(" ");
  const partial = await api.signIn({ scopes: [...GMAIL_SCOPES, CALENDAR_SCOPE] });
  assert.match(partial.consent.page.html, /Connect Google/);
  assert.match(partial.consent.page.html, /<strong>Gmail<\/strong>/);
  assert.match(partial.consent.page.html, /<strong>Calendar<\/strong>/);
  assert.equal(
    partial.delivered.credential!.scope,
    [...IDENTITY_SCOPES, ...GMAIL_SCOPES].join(" "),
  );
});

test("scopes the operator does not offer are refused before anyone reaches a consent screen", async () => {
  const drive = await api.start({ scopes: [DRIVE_SCOPE] });
  assert.equal(drive.response.status, 400);
  assert.match(drive.body.error ?? "", /does not offer Drive/);
  const unknown = await api.start({ scopes: ["https://example.com/auth/everything"] });
  assert.equal(unknown.response.status, 400);
  assert.match(unknown.body.error ?? "", /https:\/\/example\.com\/auth\/everything/);
  const identityOnly = await api.start({ scopes: IDENTITY_SCOPES });
  assert.equal(identityOnly.response.status, 400);
  assert.match(identityOnly.body.error ?? "", /at least one product/);
  for (const scopes of [
    undefined,
    [],
    ["has space"],
    Array(33).fill(CALENDAR_SCOPE),
    ["x".repeat(257)],
    "openid",
  ]) {
    assert.equal((await api.start({ scopes })).response.status, 400, JSON.stringify(scopes));
  }
  assert.equal(service.google.calls.length, 0);
});

test("a sign-in for every product the catalog knows still fits in a URL", async () => {
  await service.close();
  service = await startTestService({
    config: {
      google: {
        ...service.config.google!,
        scopeGroups: GOOGLE_SCOPE_GROUPS.map((group) => group.key),
      },
    },
  });
  api = client(service);
  const every = GOOGLE_SCOPE_GROUPS.flatMap((group) => group.scopes);
  service.google.state.grantedScope = [...IDENTITY_SCOPES, ...every].join(" ");
  const longest = `${INSTALLATION}/${"r".repeat(512 - INSTALLATION.length - 1)}`;
  const { started, consent, returned } = await api.signIn({ scopes: every, returnUrl: longest });
  assert.ok(started.body.authorizeUrl.length < 4096, `${started.body.authorizeUrl.length}`);
  assert.ok(consent.upstream!.toString().length < 8192);
  assert.equal(returned.status, 303);
  const location = new URL(returned.headers.get("location")!);
  assert.equal(`${location.origin}${location.pathname}`, longest);
});

test("the browser is only ever sent back to a page of the installation that started", async () => {
  for (const returnUrl of [
    "https://evil.example/steal",
    "http://nas.local:3001/return",
    "https://nas.local:3000/return",
    "http://user:pass@nas.local:3000/return",
    "http://nas.local:3000/return#fragment",
    "javascript:alert(1)",
    `${INSTALLATION}/${"x".repeat(520)}`,
    "/relative/path",
  ]) {
    const started = await api.start({ returnUrl });
    assert.equal(started.response.status, 400, returnUrl.slice(0, 60));
  }
  const started = await api.start({ returnUrl: `${RETURN_URL}?company=c1` });
  const consent = await api.consent(started.body.requestId, started.browserProof);
  const returned = await api.callback(consent.state, consent.callbackCookie);
  const location = new URL(returned.headers.get("location")!);
  assert.equal(`${location.origin}${location.pathname}`, RETURN_URL);
  assert.equal(location.search, "?company=c1", "the installation's own query survives");
  assert.equal(new URLSearchParams(location.hash.slice(1)).get("state"), started.state);
});

test("the start request must carry a well-formed state and a 256-bit result key", async () => {
  for (const extra of [
    { state: "short" },
    { state: "has spaces in it, sixteen+" },
    { state: "x".repeat(129) },
    { resultKey: "short" },
    { resultKey: "A".repeat(42) + "B" },
    { resultKey: undefined },
    { state: undefined },
    { codeChallenge: random() },
  ]) {
    const started = await api.start(extra);
    assert.equal(started.response.status, 400, JSON.stringify(extra));
  }
});

test("the consent page names the installation and its access, behind strict headers and a private cookie", async () => {
  const started = await api.start({ scopes: [...GMAIL_SCOPES, CALENDAR_SCOPE] });
  const page = await api.page(started.body.requestId);
  assert.equal(page.response.status, 200);
  assert.match(page.html, /http:\/\/nas\.local:3000/);
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
  assert.match(page.html, new RegExp(`<script nonce="${scriptNonce}">`));
  assert.equal(page.response.headers.get("cross-origin-opener-policy"), "unsafe-none");
  assert.equal(page.response.headers.get("referrer-policy"), "same-origin");
  assert.equal(page.response.headers.get("cache-control"), "no-store");
  assert.match(page.setCookie, /^genosyn_connect_google_[0-9a-f]{24}=[A-Za-z0-9_-]{43};/);
  assert.match(page.setCookie, /Path=\/api\/connect\/google/);
  assert.match(page.setCookie, /HttpOnly/);
  assert.match(page.setCookie, /Secure/);
  assert.match(page.setCookie, /SameSite=Lax/);
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

  const page = await api.page(requestId);
  const crossSite = await fetch(api.url("/authorize"), {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: PUBLIC_URL,
      "sec-fetch-site": "cross-site",
      cookie: page.cookie,
    },
    body: new URLSearchParams({
      requestId,
      csrfToken: page.nonce,
      browserProof: started.browserProof,
    }),
  });
  assert.equal(crossSite.status, 403);

  const genuine = await api.consent(requestId, started.browserProof);
  assert.equal(genuine.response.status, 303);
  assert.equal(service.google.calls.length, 0);
});

test("reloading the consent page retires the page that was open before", async () => {
  const started = await api.start();
  const first = await api.page(started.body.requestId);
  const second = await api.page(started.body.requestId);
  assert.notEqual(first.nonce, second.nonce);
  // The browser now holds the second page's cookie; the first page's form is stale.
  const stale = await fetch(api.url("/authorize"), {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: PUBLIC_URL,
      cookie: second.cookie,
    },
    body: new URLSearchParams({
      requestId: started.body.requestId,
      csrfToken: first.nonce,
      browserProof: started.browserProof,
    }),
  });
  assert.equal(stale.status, 403);
  assert.equal(
    (await api.consent(started.body.requestId, started.browserProof)).response.status,
    303,
  );
});

test("a malformed or tampered request id gets a page, not a stack trace", async () => {
  const started = await api.start();
  const [version, iv, payload] = started.body.requestId.split(".");
  const flipped = `${version}.${iv}.${payload.slice(0, -2)}${payload.at(-2) === "A" ? "B" : "A"}${payload.at(-1)}`;
  for (const requestId of [flipped, "short", `${version}.${iv}`, random()]) {
    const page = await api.page(requestId);
    assert.equal(page.response.status, 400, requestId.slice(0, 20));
    assert.match(page.html, /expired or is no longer valid|not valid/);
    assert.equal(page.setCookie, "", "no cookie for a request that cannot be read");
  }
});

test("a request sealed under another secret, for another provider, or expired cannot continue", async () => {
  const other = await startTestService({ config: { secret: "o".repeat(48) } });
  try {
    const foreign = await client(other).start();
    const page = await api.page(foreign.body.requestId);
    assert.equal(page.response.status, 400);
    assert.match(page.html, /expired or is no longer valid/);
  } finally {
    await other.close();
  }

  const context = {
    browserChallenge: digest(random()),
    installationOrigin: INSTALLATION,
    returnUrl: RETURN_URL,
    state: random(),
    resultKey: random(),
    scopes: [...IDENTITY_SCOPES, ...GMAIL_SCOPES],
    clientId: service.config.google!.clientId,
  };
  const sealer = createSealer(service.config.secret);
  const google = createTokens(sealer, "google");
  const live = google.sealRequest({ ...context, expiresAt: Date.now() + 60_000 });
  assert.equal(
    (await api.page(live)).response.status,
    200,
    "the same secret seals a usable request",
  );
  const expired = google.sealRequest({ ...context, expiresAt: Date.now() - 1 });
  assert.equal((await api.page(expired)).response.status, 400);
  const elsewhere = createTokens(sealer, "github").sealRequest({
    ...context,
    expiresAt: Date.now() + 60_000,
  });
  assert.equal((await api.page(elsewhere)).response.status, 400, "sealed for another provider");

  // A request id and a provider state are different kinds of token.
  const started = await api.start();
  const consent = await api.consent(started.body.requestId, started.browserProof);
  assert.equal((await api.page(consent.state)).response.status, 400);
  assert.equal((await api.callback(started.body.requestId, consent.callbackCookie)).status, 400);
  assert.equal(service.google.calls.length, 0);
});

test("a provider state that expired while the person was away cannot be redeemed", async () => {
  const started = await api.start();
  const consent = await api.consent(started.body.requestId, started.browserProof);
  const nonce = consent.callbackCookie.split("=")[1];
  const expired = createTokens(createSealer(service.config.secret), "google").sealCallback({
    expiresAt: Date.now() - 1,
    nonceHash: digest(nonce),
    codeVerifier: random(),
    clientId: service.config.google!.clientId,
    returnUrl: RETURN_URL,
    state: started.state,
    resultKey: started.resultKey,
  });
  // The cookie this browser would hold for that state: only the expiry is wrong.
  const name = crypto.createHash("sha256").update(expired).digest("hex").slice(0, 24);
  const cookie = `genosyn_connect_google_${name}=${nonce}`;
  const response = await api.callback(expired, cookie);
  assert.equal(response.status, 400);
  assert.match(await response.text(), /expired or is no longer valid/);
  assert.equal(service.google.calls.length, 0, "the code is never redeemed");
});

test("the provider must return to the browser that consented", async () => {
  const started = await api.start();
  const consent = await api.consent(started.body.requestId, started.browserProof);
  const otherBrowser = await api.callback(
    consent.state,
    `${consent.callbackCookie.split("=")[0]}=${random()}`,
  );
  assert.equal(otherBrowser.status, 403);
  assert.match(await otherBrowser.text(), /browser where you started it/);
  assert.equal((await api.callback(consent.state, "")).status, 403);
  assert.equal(service.google.calls.length, 0, "a foreign browser cannot redeem the code");
  const genuine = await api.callback(consent.state, consent.callbackCookie);
  assert.equal(genuine.status, 303);
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

test("replaying a callback cannot mint a second credential", async () => {
  const { started, consent, delivered } = await api.signIn();
  assert.ok(delivered.credential);
  const replay = await api.callback(consent.state, consent.callbackCookie);
  assert.equal(replay.status, 303, "same browser, same sealed state");
  const again = readReturn(replay.headers.get("location"), started);
  assert.equal(again.error, "exchange_failed", "Google refuses a code it already redeemed");
  assert.equal(again.credential, null);
});

test("providers may add their own callback parameters", async () => {
  const { delivered } = await api.signIn(
    {},
    "code=google-auth-code&scope=openid&authuser=0&prompt=consent&iss=https%3A%2F%2Faccounts.google.com",
  );
  assert.ok(delivered.credential);
});

test("a sign-in that ends without a credential tells the installation why, with a code and nothing else", async () => {
  const cancelled = await api.signIn({}, "error=access_denied&error_description=user+said+no");
  assert.deepEqual(cancelled.delivered.keys, ["state", "error"]);
  assert.equal(cancelled.delivered.error, "access_denied");

  service.google.state.tokenStatus = 500;
  service.google.state.tokenBody = {
    error: "internal",
    error_description: "secret upstream detail",
  };
  const failed = await api.signIn();
  assert.equal(failed.delivered.error, "exchange_failed");
  assert.doesNotMatch(failed.returned.headers.get("location")!, /secret|internal/);

  service.google.state.tokenStatus = 200;
  service.google.state.tokenBody = {};
  service.google.state.profile = { email: "member@gmail.com", email_verified: false };
  assert.equal((await api.signIn()).delivered.error, "account_unverified");

  service.google.state.profile = { email: "member@gmail.com", email_verified: true };
  service.google.state.tokenBody = {
    access_token: "a",
    expires_in: 3600,
    token_type: "Bearer",
    scope: "openid",
  };
  assert.equal(
    (await api.signIn({ scopes: [CALENDAR_SCOPE] })).delivered.error,
    "offline_access_missing",
  );
});

test("renewal uses only this service's client, keeps nothing, and hides upstream detail", async () => {
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
  const call = service.google.calls.at(-1)!;
  assert.equal(call.body.get("grant_type"), "refresh_token");
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
  const browserHeaders: Array<Record<string, string>> = [
    { origin: INSTALLATION },
    { origin: "null" },
    { "sec-fetch-site": "same-origin" },
  ];
  for (const headers of browserHeaders) {
    const response = await fetch(api.url("/start"), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: "{}",
    });
    assert.equal(response.status, 403);
  }
  const textPlain = await fetch(api.url("/start"), {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "{}",
  });
  assert.equal(textPlain.status, 415);
  const malformed = await fetch(api.url("/start"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(malformed.status, 400);
  assert.equal(
    (await api.start({ installationOrigin: `https://${"a".repeat(30_000)}.example` })).response
      .status,
    413,
  );
  for (const installationOrigin of [
    "",
    "javascript:alert(1)",
    "https://user:pass@nas.example",
    "https://nas.example/path",
    "file:///etc/passwd",
  ]) {
    assert.equal(
      (await api.start({ installationOrigin })).response.status,
      400,
      installationOrigin,
    );
  }
  assert.equal((await api.start({ extra: true })).response.status, 400);
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

test("starting is rate limited per address", async () => {
  for (let attempt = 0; attempt < 30; attempt++) {
    assert.equal((await api.start()).response.status, 200, `attempt ${attempt}`);
  }
  assert.equal((await api.start()).response.status, 429);
});

test("only the configured number of proxies decides which address is limited", async () => {
  const startFrom = (forwardedFor: string) =>
    api.post(
      "/start",
      {
        browserChallenge: digest(random()),
        installationOrigin: INSTALLATION,
        returnUrl: RETURN_URL,
        state: random(),
        resultKey: random(),
        scopes: GMAIL_SCOPES,
      },
      { "x-forwarded-for": forwardedFor },
    );
  for (let attempt = 0; attempt < 30; attempt++) {
    assert.equal((await startFrom(`203.0.113.${attempt}`)).status, 200);
  }
  assert.equal((await startFrom("198.51.100.7")).status, 429, "a forged header changes nothing");
  await service.close();
  service = await startTestService({ config: { trustedProxyHops: 1 } });
  api = client(service);
  for (let attempt = 0; attempt < 30; attempt++) {
    assert.equal((await startFrom("203.0.113.10")).status, 200);
  }
  assert.equal((await startFrom("203.0.113.10")).status, 429);
  assert.equal((await startFrom("203.0.113.11")).status, 200);
});

test("the stateful protocol is gone: no polling and no Gmail-only path", async () => {
  for (const path of [
    "/api/connect/google/poll",
    "/api/google-sign-in/start",
    "/api/google-sign-in/status",
  ]) {
    const response = await fetch(`${service.base}${path}`, {
      method: path.endsWith("status") ? "GET" : "POST",
    });
    assert.equal(response.status, 404, path);
  }
});

test("every response carries the security headers and no framework fingerprint", async () => {
  for (const path of [
    "/",
    "/healthz",
    "/readyz",
    "/api/connect",
    "/api/connect/google/status",
    "/missing",
  ]) {
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
    assert.equal(response.headers.get("etag"), null, path);
  }
});

test("the landing page, icon and health checks; readiness needs nothing", async () => {
  const html = await (await fetch(service.base)).text();
  assert.match(html, /<h1>Genosyn Connect<\/h1>/);
  assert.match(html, /<strong>Google<\/strong><span>Gmail, Calendar<\/span>/);
  assert.match(html, /This service keeps nothing/);
  assert.doesNotMatch(html, /<script/);
  const icon = await fetch(`${service.base}/favicon.svg`);
  assert.equal(icon.headers.get("content-type"), "image/svg+xml; charset=utf-8");
  assert.deepEqual(await (await fetch(`${service.base}/healthz`)).json(), { ok: true });
  assert.deepEqual(await (await fetch(`${service.base}/readyz`)).json(), { ok: true });
});

test("unknown routes answer 404 as JSON, or as a page for a browser", async () => {
  const json = await fetch(`${service.base}/api/connect/google/nope`);
  assert.equal(json.status, 404);
  assert.deepEqual(await json.json(), { error: "Sign-in endpoint not found" });
  const page = await fetch(`${service.base}/admin`, { headers: { accept: "text/html,*/*" } });
  assert.equal(page.status, 404);
  assert.match(await page.text(), /Page not found/);
});
