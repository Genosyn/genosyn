import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createConnectApp } from "../src/app.js";
import type { ConnectConfig } from "../src/config.js";
import { createFlowStates } from "../src/flowState.js";
import { silentLogger } from "../src/log.js";
import { createProviders } from "../src/providers/index.js";
import { createSealer } from "../src/secrets.js";
import { createMemoryStore } from "../src/store/memory.js";
import type { FlowStore } from "../src/store/types.js";
import { Throttle } from "../src/throttle.js";

export const PUBLIC_URL = "https://connect.example.test";
export const INSTALLATION = "http://nas.local:3000";
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.settings.basic",
];
export const IDENTITY_SCOPES = ["https://www.googleapis.com/auth/userinfo.email", "openid"];
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

export const digest = (value: string) =>
  crypto.createHash("sha256").update(value).digest("base64url");
export const random = () => crypto.randomBytes(32).toString("base64url");

export function testConfig(overrides: Partial<ConnectConfig> = {}): ConnectConfig {
  return {
    port: 0,
    listenHost: "127.0.0.1",
    publicUrl: PUBLIC_URL,
    secret: "s".repeat(48),
    secretIsEphemeral: false,
    trustedProxyHops: 0,
    databaseUrl: null,
    accessLog: false,
    links: { privacy: null, terms: null },
    google: {
      clientId: "connect-client.apps.googleusercontent.com",
      clientSecret: "connect-client-secret",
      scopeGroups: ["gmail", "calendar"],
    },
    ...overrides,
  };
}

type GoogleCall = { url: string; body: URLSearchParams; headers: Headers };

/**
 * A stand-in for Google's token and userinfo endpoints. Anything else is an
 * unexpected outbound request and fails the test.
 */
export function fakeGoogle() {
  const calls: GoogleCall[] = [];
  const state = {
    tokenStatus: 200,
    tokenBody: {} as Record<string, unknown>,
    refreshStatus: 200,
    refreshBody: {} as Record<string, unknown>,
    profileStatus: 200,
    profile: { email: "member@gmail.com", email_verified: true } as Record<string, unknown>,
    grantedScope: [...IDENTITY_SCOPES, ...GMAIL_SCOPES].join(" "),
    tokenDelayMs: 0,
  };
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    const body = new URLSearchParams(
      typeof init.body === "string" ? init.body : String(init.body ?? ""),
    );
    calls.push({ url, body, headers });
    assert.equal(init.redirect, "error", "upstream calls never follow redirects");
    if (url === "https://oauth2.googleapis.com/token") {
      if (state.tokenDelayMs)
        await new Promise((resolve) => setTimeout(resolve, state.tokenDelayMs));
      if (body.get("grant_type") === "refresh_token") {
        return Response.json(
          Object.keys(state.refreshBody).length
            ? state.refreshBody
            : { access_token: "refreshed-access", expires_in: 3599, token_type: "Bearer" },
          { status: state.refreshStatus },
        );
      }
      return Response.json(
        Object.keys(state.tokenBody).length
          ? state.tokenBody
          : {
              access_token: "google-access-token",
              refresh_token: "google-refresh-token",
              expires_in: 3599,
              scope: state.grantedScope,
              token_type: "Bearer",
            },
        { status: state.tokenStatus },
      );
    }
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
      return Response.json(state.profile, { status: state.profileStatus });
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  };
  return { fetch: fetchImpl, calls, state };
}

export type TestService = Awaited<ReturnType<typeof startTestService>>;

/** The real app on an ephemeral port, with an in-memory store and a fake Google. */
export async function startTestService(
  options: {
    config?: Partial<ConnectConfig>;
    store?: FlowStore;
    now?: () => number;
    throttle?: Throttle;
  } = {},
) {
  const config = testConfig(options.config);
  const google = fakeGoogle();
  const store = options.store ?? createMemoryStore({ now: options.now });
  const throttle = options.throttle ?? new Throttle();
  const app = createConnectApp({
    config,
    flows: createFlowStates(store, createSealer(config.secret)),
    providers: createProviders(config, { fetch: google.fetch }),
    throttle,
    log: silentLogger,
  });
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    config,
    google,
    store,
    throttle,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/** Drives one sign-in the way an installation and a person's browser would. */
export function client(service: { base: string }, basePath = "/api/connect/google") {
  const url = (path: string) => `${service.base}${basePath}${path}`;
  return {
    url,
    async post(path: string, body: unknown, headers: Record<string, string> = {}) {
      return fetch(url(path), {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    },
    async start(extra: Record<string, unknown> = {}) {
      const codeVerifier = random();
      const browserProof = random();
      const response = await this.post("/start", {
        codeChallenge: digest(codeVerifier),
        browserChallenge: digest(browserProof),
        installationOrigin: INSTALLATION,
        ...extra,
      });
      const body = (await response.json()) as {
        requestId: string;
        authorizeUrl: string;
        expiresAt: number;
        error?: string;
      };
      return { response, body, codeVerifier, browserProof };
    },
    async page(requestId: string) {
      const response = await fetch(url(`/authorize?requestId=${requestId}`), {
        headers: { accept: "text/html" },
      });
      const html = await response.text();
      const nonce = /name="csrfToken" value="([A-Za-z0-9_-]+)"/.exec(html)?.[1] ?? "";
      const setCookie = response.headers.getSetCookie()[0] ?? "";
      const cookie = setCookie.split(";")[0];
      return { response, html, nonce, cookie, setCookie };
    },
    async consent(
      requestId: string,
      browserProof: string,
      overrides: { origin?: string | null; cookie?: string; csrfToken?: string } = {},
    ) {
      const page = await this.page(requestId);
      const headers: Record<string, string> = {
        "content-type": "application/x-www-form-urlencoded",
        accept: "text/html",
        cookie: overrides.cookie ?? page.cookie,
      };
      if (overrides.origin !== null) headers.origin = overrides.origin ?? PUBLIC_URL;
      const response = await fetch(url("/authorize"), {
        method: "POST",
        redirect: "manual",
        headers,
        body: new URLSearchParams({
          requestId,
          csrfToken: overrides.csrfToken ?? page.nonce,
          browserProof,
        }),
      });
      const location = response.headers.get("location");
      const upstream = location ? new URL(location) : null;
      const state = upstream?.searchParams.get("state") ?? "";
      const callbackCookie = response.headers
        .getSetCookie()
        .map((part) => part.split(";")[0])
        .find((part) => page.nonce !== "" && part.endsWith(`=${page.nonce}`));
      return { response, upstream, state, page, callbackCookie: callbackCookie ?? "" };
    },
    async callback(state: string, cookie: string, query = "code=google-auth-code") {
      return fetch(url(`/callback?state=${state}&${query}`), {
        headers: { cookie, accept: "text/html" },
      });
    },
    async poll(requestId: string, codeVerifier: string) {
      const response = await this.post("/poll", { requestId, codeVerifier });
      return { response, body: (await response.json()) as Record<string, unknown> };
    },
    /** Start → consent page → Continue → provider → callback, returning what the poll needs. */
    async signIn(extra: Record<string, unknown> = {}, callbackQuery?: string) {
      const started = await this.start(extra);
      assert.equal(started.response.status, 200, started.body.error);
      const consent = await this.consent(started.body.requestId, started.browserProof);
      assert.equal(consent.response.status, 303);
      const returned = await this.callback(consent.state, consent.callbackCookie, callbackQuery);
      return { started, consent, returned };
    },
  };
}
