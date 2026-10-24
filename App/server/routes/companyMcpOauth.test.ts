import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import type { RequestListener, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";

import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  UnauthorizedError,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { CONNECT_APPS_ROLE_REQUIRED } from "../../shared/connectedApps.js";
import { createApp } from "../app.js";
import { AppDataSource } from "../db/datasource.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { AuthRateLimit } from "../db/entities/AuthRateLimit.js";
import { Company } from "../db/entities/Company.js";
import { ConnectedApp } from "../db/entities/ConnectedApp.js";
import { ConnectedAppToken } from "../db/entities/ConnectedAppToken.js";
import { Membership } from "../db/entities/Membership.js";
import { OAuthClient } from "../db/entities/OAuthClient.js";
import type { User } from "../db/entities/User.js";
import { requireBearerAuth } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error.js";
import {
  AI_BROWSER_REQUEST_HEADER,
  AI_BROWSER_REQUEST_VALUE,
} from "../services/browserRequestBoundary.js";
import { requestInProcess } from "../services/companyMcp/dispatch.js";
import { pruneUnusedClients } from "../services/mcpOauth/clients.js";
import {
  hashToken,
  REFRESH_REUSE_GRACE_MS,
  sweepExpiredConnectedAppTokens,
} from "../services/mcpOauth/tokens.js";
import { setPublicUrl } from "../services/publicUrl.js";
import {
  createMemberOfNewCompany,
  mintTestApiKey,
  sessionCookieFor,
  withTestInstanceSecrets,
} from "../test/apiAccess.js";
import { closeTestDb, initTestDb, insert } from "../test/dbHarness.js";

/**
 * Signing in to the Genosyn MCP server with OAuth, the way claude.ai and
 * ChatGPT do, against the real `createApp()` stack: discovery from a 401,
 * dynamic registration, the authorization endpoint and the consent API a
 * signed-in Member answers, the code exchange with PKCE, refresh, revocation —
 * and what the resulting token can and cannot reach. The headline test drives
 * all of it with the MCP SDK's own OAuth client; the rest speak raw HTTP so
 * every status and parameter is visible.
 */

let server: Server;
let baseUrl = "";
let restoreSecrets: () => void;
const app = createApp();
app.use(errorHandler);
const clients: Client[] = [];

before(async () => {
  restoreSecrets = withTestInstanceSecrets();
  await initTestDb();
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // A client checks that the metadata names the URL it connected to, so this
  // server's own address is the install's public URL — as it is in production.
  await setPublicUrl(baseUrl);
});

after(async () => {
  await Promise.allSettled(clients.map((client) => client.close()));
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
  restoreSecrets();
});

const REDIRECT_URI = "https://app.example.test/oauth/callback";

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "oauth-test", version: "1.0.0" },
  },
};
const WHOAMI = {
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: "whoami", arguments: {} },
};

type Member = { user: User; company: Company };
type Registered = { client_id: string; client_secret?: string; redirect_uris: string[] };
type TokenBody = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
};
type Json = Record<string, unknown>;

const mcpUrl = (companyId: string) => `${baseUrl}/api/companies/${companyId}/mcp`;

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function readJson(response: Response): Promise<Json> {
  const text = await response.text();
  return text ? (JSON.parse(text) as Json) : {};
}

async function register(metadata: Json = {}, options: { keepThrottle?: boolean } = {}) {
  // Registration is throttled per address; these tests all come from one.
  if (!options.keepThrottle) await AppDataSource.getRepository(AuthRateLimit).clear();
  const response = await fetch(`${baseUrl}/api/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Test app", redirect_uris: [REDIRECT_URI], ...metadata }),
  });
  return { status: response.status, headers: response.headers, body: await readJson(response) };
}

async function registerApp(metadata: Json = {}): Promise<Registered> {
  const registered = await register(metadata);
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  return registered.body as unknown as Registered;
}

function authorizeUrl(params: Record<string, string | undefined>): string {
  const url = new URL(`${baseUrl}/oauth/authorize`);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  return url.toString();
}

/** Follow one redirect the way a browser would, and say where it pointed. */
async function navigate(url: string): Promise<URL> {
  const response = await fetch(url, { redirect: "manual" });
  assert.equal(response.status, 302, await response.text());
  assert.equal(response.headers.get("cache-control"), "no-store");
  return new URL(response.headers.get("location")!, baseUrl);
}

function authorizationParams(
  registered: Registered,
  challenge: string,
  extra: Record<string, string | undefined> = {},
) {
  return {
    response_type: "code",
    client_id: registered.client_id,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "state-123",
    ...extra,
  };
}

async function consentDetails(cookie: string, request: string, headers: Json = {}) {
  const response = await fetch(
    `${baseUrl}/api/oauth/consent?request=${encodeURIComponent(request)}`,
    { headers: { cookie, ...(headers as Record<string, string>) } },
  );
  return { status: response.status, body: await readJson(response) };
}

async function answerConsent(
  cookie: string,
  request: string,
  answer: { decision: "allow" | "deny"; companyId?: string },
) {
  const response = await fetch(`${baseUrl}/api/oauth/consent`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ request, ...answer }),
  });
  return { status: response.status, body: await readJson(response) };
}

async function tokenRequest(params: Record<string, string>, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}/api/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(params),
  });
  return { status: response.status, headers: response.headers, body: await readJson(response) };
}

/** Register, send the browser to authorize, approve as `member`, and come back with a code. */
async function approvedCode(
  member: Member,
  options: { registered?: Registered; resource?: boolean; state?: string } = {},
) {
  const registered = options.registered ?? (await registerApp());
  const { verifier, challenge } = pkce();
  const consentUrl = await navigate(
    authorizeUrl(
      authorizationParams(registered, challenge, {
        state: options.state ?? "state-123",
        resource: options.resource === false ? undefined : mcpUrl(member.company.id),
      }),
    ),
  );
  assert.equal(consentUrl.pathname, "/oauth/consent");
  const request = consentUrl.searchParams.get("request");
  assert.ok(request, `no consent request in ${consentUrl}`);
  const cookie = await sessionCookieFor(member.user);
  const decided = await answerConsent(cookie, request, {
    decision: "allow",
    companyId: options.resource === false ? member.company.id : undefined,
  });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  const back = new URL(String(decided.body.redirectTo));
  return { registered, verifier, code: back.searchParams.get("code")!, back, cookie, request };
}

/** The whole dance: a connected app for `member`, with its tokens. */
async function connectApp(member: Member, options: { registered?: Registered } = {}) {
  const approved = await approvedCode(member, options);
  const issued = await tokenRequest({
    grant_type: "authorization_code",
    code: approved.code,
    code_verifier: approved.verifier,
    redirect_uri: REDIRECT_URI,
    client_id: approved.registered.client_id,
    resource: mcpUrl(member.company.id),
  });
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  const tokens = issued.body as unknown as TokenBody;
  const connected = await AppDataSource.getRepository(ConnectedAppToken).findOneByOrFail({
    tokenHash: hashToken(tokens.access_token),
  });
  return { ...approved, tokens, appId: connected.connectedAppId };
}

async function mcp(
  companyId: string,
  token: string | null,
  options: { body?: unknown; headers?: Record<string, string> } = {},
) {
  const response = await fetch(mcpUrl(companyId), {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
    body: JSON.stringify(options.body ?? INITIALIZE),
  });
  return { status: response.status, headers: response.headers, body: await readJson(response) };
}

async function whoami(companyId: string, token: string) {
  const answer = await mcp(companyId, token, { body: WHOAMI });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const result = answer.body.result as CallToolResult & { structuredContent?: Json };
  return result;
}

async function refresh(
  registered: Registered,
  refreshToken: string,
  extra: Record<string, string> = {},
) {
  return tokenRequest({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: registered.client_id,
    ...extra,
  });
}

async function appRow(id: string): Promise<ConnectedApp> {
  return AppDataSource.getRepository(ConnectedApp).findOneByOrFail({ id });
}

/** A Member of `company` with `role`, besides its owner. */
async function colleague(company: Company, role: "admin" | "member"): Promise<Member> {
  const { user } = await createMemberOfNewCompany("owner");
  await insert(Membership, { companyId: company.id, userId: user.id, role });
  return { user, company };
}

/**
 * The MCP SDK's own OAuth client, with a browser that is this test: it keeps
 * what the SDK asks it to keep, and records where it was told to send the
 * person instead of opening anything.
 */
class TestOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl = "http://localhost:8976/oauth/callback";
  authorizationUrl: URL | null = null;
  private information: OAuthClientInformationMixed | undefined;
  private saved: OAuthTokens | undefined;
  private verifier = "";

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "SDK test client",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  state() {
    return "sdk-state";
  }
  clientInformation() {
    return this.information;
  }
  saveClientInformation(information: OAuthClientInformationMixed) {
    this.information = information;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

describe("the MCP SDK's OAuth client, end to end", () => {
  test("discovers, registers, is approved by a signed-in owner, and works the server as them", async () => {
    const member = await createMemberOfNewCompany("owner");
    const provider = new TestOAuthProvider();
    const url = new URL(mcpUrl(member.company.id));

    // 1. No credential: the SDK reads the 401, discovers, registers and asks
    //    for the person's browser to be sent to the authorization endpoint.
    const first = new Client({ name: "sdk-oauth", version: "1.0.0" });
    await assert.rejects(
      first.connect(new StreamableHTTPClientTransport(url, { authProvider: provider })),
      UnauthorizedError,
    );
    const authorization = provider.authorizationUrl;
    assert.ok(authorization, "the SDK asked to open the authorization page");
    assert.equal(authorization.origin + authorization.pathname, `${baseUrl}/oauth/authorize`);
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    assert.equal(authorization.searchParams.get("resource"), url.toString());
    assert.equal(authorization.searchParams.get("scope"), "mcp");
    const information = provider.clientInformation() as { client_id: string };
    assert.match(information.client_id, /^gci_/);

    // 2. The browser lands on the consent page; the owner, signed in, sees
    //    the app and where it will be sent back to, and approves it.
    const consentPage = await navigate(authorization.toString());
    assert.equal(consentPage.pathname, "/oauth/consent");
    const request = consentPage.searchParams.get("request")!;
    const cookie = await sessionCookieFor(member.user);
    const details = await consentDetails(cookie, request);
    assert.equal(details.status, 200, JSON.stringify(details.body));
    assert.deepEqual(details.body.app, {
      name: "SDK test client",
      clientUri: null,
      redirectUri: provider.redirectUrl,
      redirectOrigin: "http://localhost:8976",
    });
    assert.equal(details.body.requestedCompanyId, member.company.id);
    assert.deepEqual(
      (details.body.companies as Json[]).map((company) => [company.id, company.canConnect]),
      [[member.company.id, true]],
    );
    const decided = await answerConsent(cookie, request, { decision: "allow" });
    assert.equal(decided.status, 200, JSON.stringify(decided.body));
    const back = new URL(String(decided.body.redirectTo));
    assert.equal(back.origin + back.pathname, provider.redirectUrl);
    assert.equal(back.searchParams.get("state"), "sdk-state");
    assert.equal(back.searchParams.get("iss"), baseUrl);

    // 3. The SDK exchanges the code (with its PKCE verifier) for tokens.
    const transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
    await transport.finishAuth(back.searchParams.get("code")!);
    const tokens = provider.tokens()!;
    assert.match(tokens.access_token, /^gat_[A-Za-z0-9_-]{43}$/);
    assert.match(String(tokens.refresh_token), /^grt_[A-Za-z0-9_-]{43}$/);
    assert.equal(tokens.token_type, "Bearer");
    assert.equal(tokens.expires_in, 3600);

    // 4. Connected: the server acts as the owner, through the app.
    const client = new Client({ name: "sdk-oauth", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url, { authProvider: provider }));
    clients.push(client);
    assert.match(
      client.getInstructions() ?? "",
      /through "SDK test client", an app they connected/,
    );
    const { tools } = await client.listTools();
    assert.equal(tools.length, 6);
    const me = (await client.callTool({ name: "whoami", arguments: {} })) as CallToolResult & {
      structuredContent: Json;
    };
    assert.equal(me.isError, undefined, textOf(me));
    assert.equal(me.structuredContent.authentication, "connected_app");
    assert.equal(me.structuredContent.role, "owner");
    assert.equal(me.structuredContent.apiKey, null);
    assert.equal((me.structuredContent.connectedApp as Json).name, "SDK test client");

    // A write lands in the audit log under the Member, like any API call.
    const created = (await client.callTool({
      name: "call_write_operation",
      arguments: {
        operationId: "createRevenueStage",
        body: { name: "Signed in", probability: 20 },
      },
    })) as CallToolResult & { structuredContent: Json };
    assert.equal(created.structuredContent.status, 201, textOf(created));
    const stage = created.structuredContent.data as { id: string };
    const events = await AppDataSource.getRepository(AuditEvent).find({
      where: { companyId: member.company.id },
      order: { createdAt: "ASC" },
    });
    const connect = events.find((event) => event.action === "connected_app.connect");
    assert.ok(connect, "connecting the app is audited");
    assert.equal(connect.actorUserId, member.user.id);
    assert.equal(connect.targetLabel, "SDK test client");
    const write = events.find((event) => event.targetId === stage.id);
    assert.equal(write?.action, "revenue.stage.create");
    assert.equal(write?.actorUserId, member.user.id);

    // 5. When the access token runs out the SDK refreshes on its own, and the
    //    refresh token it used is spent.
    const tokenRows = AppDataSource.getRepository(ConnectedAppToken);
    await tokenRows.update(
      { tokenHash: hashToken(tokens.access_token) },
      { expiresAt: new Date(Date.now() - 1000) },
    );
    const again = (await client.callTool({ name: "whoami", arguments: {} })) as CallToolResult;
    assert.equal(again.isError, undefined, textOf(again));
    const refreshed = provider.tokens()!;
    assert.notEqual(refreshed.access_token, tokens.access_token);
    assert.notEqual(refreshed.refresh_token, tokens.refresh_token);
    const spent = await tokenRows.findOneByOrFail({ tokenHash: hashToken(tokens.refresh_token!) });
    assert.ok(spent.usedAt, "the old refresh token was spent");
  });
});

describe("discovery", () => {
  test("a request without a credential is pointed at the protected-resource metadata", async () => {
    const member = await createMemberOfNewCompany("owner");
    const answer = await mcp(member.company.id, null);
    assert.equal(answer.status, 401);
    const metadataUrl = `${baseUrl}/.well-known/oauth-protected-resource/api/companies/${member.company.id}/mcp`;
    assert.equal(
      answer.headers.get("www-authenticate"),
      `Bearer realm="Genosyn", resource_metadata="${metadataUrl}"`,
    );

    const resource = await fetch(metadataUrl);
    assert.equal(resource.status, 200);
    assert.equal(resource.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual(await resource.json(), {
      resource: mcpUrl(member.company.id),
      authorization_servers: [baseUrl],
      scopes_supported: ["mcp"],
      bearer_methods_supported: ["header"],
      resource_name: "Genosyn",
      resource_documentation: "https://genosyn.com/docs/mcp-server",
    });
  });

  test("the authorization server says how to register, authorize and exchange — with S256 only", async () => {
    const response = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    assert.equal(response.status, 200);
    const metadata = (await response.json()) as Json;
    assert.equal(metadata.issuer, baseUrl);
    assert.equal(metadata.authorization_endpoint, `${baseUrl}/oauth/authorize`);
    assert.equal(metadata.token_endpoint, `${baseUrl}/api/oauth/token`);
    assert.equal(metadata.registration_endpoint, `${baseUrl}/api/oauth/register`);
    assert.equal(metadata.revocation_endpoint, `${baseUrl}/api/oauth/revoke`);
    assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
    assert.deepEqual(metadata.response_types_supported, ["code"]);
    assert.deepEqual(metadata.grant_types_supported, ["authorization_code", "refresh_token"]);
    assert.deepEqual(metadata.token_endpoint_auth_methods_supported, [
      "none",
      "client_secret_post",
      "client_secret_basic",
    ]);
    assert.equal(metadata.authorization_response_iss_parameter_supported, true);
  });

  test("other discovery URLs answer 404 JSON, not the App's HTML", async () => {
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/api/companies/not-a-company/mcp",
      "/.well-known/openid-configuration",
      "/.well-known/oauth-authorization-server/extra",
    ]) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 404, path);
      assert.deepEqual(await response.json(), { error: "not_found" }, path);
    }
  });
});

describe("registration", () => {
  test("a public client gets an id and no secret; a confidential one gets a secret", async () => {
    const open = await register({ token_endpoint_auth_method: "none" });
    assert.equal(open.status, 201);
    assert.equal(open.headers.get("cache-control"), "no-store");
    assert.match(String(open.body.client_id), /^gci_/);
    assert.equal(open.body.client_secret, undefined);
    assert.deepEqual(open.body.redirect_uris, [REDIRECT_URI]);
    assert.deepEqual(open.body.grant_types, ["authorization_code", "refresh_token"]);

    const confidential = await register({ token_endpoint_auth_method: "client_secret_post" });
    assert.equal(confidential.status, 201);
    assert.match(String(confidential.body.client_secret), /^gcs_/);
    assert.equal(confidential.body.client_secret_expires_at, 0);
    const row = await AppDataSource.getRepository(OAuthClient).findOneByOrFail({
      clientId: String(confidential.body.client_id),
    });
    assert.notEqual(row.clientSecretHash, confidential.body.client_secret, "only a hash is stored");
  });

  test("redirect URIs must be https, or http on this computer — nothing else", async () => {
    for (const uri of [
      "http://app.example.test/callback",
      "javascript:alert(1)",
      "cursor://anysphere.cursor-mcp/oauth/callback",
      "https://app.example.test/callback#fragment",
      "https://user:pass@app.example.test/callback",
      "not a url",
    ]) {
      const refused = await register({ redirect_uris: [uri] });
      assert.equal(refused.status, 400, uri);
      assert.equal(refused.body.error, "invalid_redirect_uri", uri);
    }
    for (const uri of [
      "http://localhost:3334/callback",
      "http://127.0.0.1:8080/cb",
      "http://[::1]:9/cb",
      "https://claude.ai/api/mcp/auth_callback",
      "https://chatgpt.com/connector_platform_oauth_redirect",
    ]) {
      assert.equal((await register({ redirect_uris: [uri] })).status, 201, uri);
    }
    assert.equal((await register({ redirect_uris: [] })).body.error, "invalid_redirect_uri");
  });

  test("unsupported methods, grants and response types are refused", async () => {
    for (const metadata of [
      { token_endpoint_auth_method: "private_key_jwt" },
      { grant_types: ["client_credentials"] },
      { grant_types: ["refresh_token"] },
      { response_types: ["token"] },
    ]) {
      const refused = await register(metadata);
      assert.equal(refused.status, 400, JSON.stringify(metadata));
      assert.equal(refused.body.error, "invalid_client_metadata", JSON.stringify(metadata));
    }
  });

  test("one address may register twenty times an hour", async () => {
    await AppDataSource.getRepository(AuthRateLimit).clear();
    for (let attempt = 1; attempt <= 20; attempt++) {
      assert.equal((await register({}, { keepThrottle: true })).status, 201, `attempt ${attempt}`);
    }
    const refused = await register({}, { keepThrottle: true });
    assert.equal(refused.status, 429);
    assert.equal(refused.body.error, "temporarily_unavailable");
    assert.ok(Number(refused.headers.get("retry-after")) > 0);
    await AppDataSource.getRepository(AuthRateLimit).clear();
  });
});

describe("the authorization endpoint", () => {
  test("a request it cannot trust is explained on the consent page, never sent back to the client", async () => {
    const registered = await registerApp();
    const { challenge } = pkce();
    const cases: Array<[Record<string, string | undefined>, string]> = [
      [authorizationParams(registered, challenge, { client_id: undefined }), "missing_client"],
      [authorizationParams(registered, challenge, { client_id: "gci_unknown" }), "unknown_client"],
      [
        authorizationParams(registered, challenge, {
          redirect_uri: "https://attacker.example.test/steal",
        }),
        "unregistered_redirect_uri",
      ],
    ];
    for (const [params, error] of cases) {
      const location = await navigate(authorizeUrl(params));
      assert.equal(location.origin, baseUrl, error);
      assert.equal(location.pathname, "/oauth/consent", error);
      assert.equal(location.searchParams.get("error"), error);
    }
    const many = await registerApp({
      redirect_uris: [REDIRECT_URI, "https://two.example.test/cb"],
    });
    const missing = await navigate(
      authorizeUrl(authorizationParams(many, challenge, { redirect_uri: undefined })),
    );
    assert.equal(missing.searchParams.get("error"), "missing_redirect_uri");
  });

  test("PKCE is required, S256 only: anything else goes back to the client as invalid_request", async () => {
    const registered = await registerApp();
    const { challenge } = pkce();
    for (const extra of [
      { code_challenge: undefined },
      { code_challenge: "too-short" },
      { code_challenge_method: "plain" },
      { code_challenge_method: undefined },
    ]) {
      const location = await navigate(
        authorizeUrl(authorizationParams(registered, challenge, extra)),
      );
      assert.equal(location.origin + location.pathname, REDIRECT_URI, JSON.stringify(extra));
      assert.equal(location.searchParams.get("error"), "invalid_request", JSON.stringify(extra));
      assert.equal(location.searchParams.get("state"), "state-123");
      assert.equal(location.searchParams.get("iss"), baseUrl);
    }
    const implicit = await navigate(
      authorizeUrl(authorizationParams(registered, challenge, { response_type: "token" })),
    );
    assert.equal(implicit.searchParams.get("error"), "unsupported_response_type");
  });

  test("resource must be one company's MCP endpoint on this install", async () => {
    const registered = await registerApp();
    const { challenge } = pkce();
    for (const resource of [
      "https://elsewhere.example.test/api/companies/3f2b7c1e-8a4d-4c6b-9e1f-0a2b3c4d5e6f/mcp",
      `${baseUrl}/api/companies/3f2b7c1e-8a4d-4c6b-9e1f-0a2b3c4d5e6f/routines`,
      `${baseUrl}/api/companies/not-an-id/mcp`,
    ]) {
      const location = await navigate(
        authorizeUrl(authorizationParams(registered, challenge, { resource })),
      );
      assert.equal(location.searchParams.get("error"), "invalid_target", resource);
    }
  });

  test("a desktop client's loopback redirect may come back on any port", async () => {
    const registered = await registerApp({ redirect_uris: ["http://127.0.0.1:1234/callback"] });
    const { challenge } = pkce();
    const location = await navigate(
      authorizeUrl(
        authorizationParams(registered, challenge, {
          redirect_uri: "http://127.0.0.1:61234/callback",
        }),
      ),
    );
    assert.equal(location.pathname, "/oauth/consent");
    assert.ok(location.searchParams.get("request"));
    const otherPath = await navigate(
      authorizeUrl(
        authorizationParams(registered, challenge, {
          redirect_uri: "http://127.0.0.1:61234/other",
        }),
      ),
    );
    assert.equal(otherPath.searchParams.get("error"), "unregistered_redirect_uri");
  });
});

describe("consent", () => {
  test("denied: the client hears access_denied with its state, and nothing is connected", async () => {
    const member = await createMemberOfNewCompany("owner");
    const registered = await registerApp();
    const { challenge } = pkce();
    const consentPage = await navigate(
      authorizeUrl(
        authorizationParams(registered, challenge, { resource: mcpUrl(member.company.id) }),
      ),
    );
    const cookie = await sessionCookieFor(member.user);
    const denied = await answerConsent(cookie, consentPage.searchParams.get("request")!, {
      decision: "deny",
    });
    assert.equal(denied.status, 200);
    const back = new URL(String(denied.body.redirectTo));
    assert.equal(back.origin + back.pathname, REDIRECT_URI);
    assert.equal(back.searchParams.get("error"), "access_denied");
    assert.equal(back.searchParams.get("state"), "state-123");
    assert.equal(back.searchParams.get("code"), null);
    assert.equal(
      await AppDataSource.getRepository(ConnectedApp).countBy({ companyId: member.company.id }),
      0,
    );
  });

  test("without a resource the Member chooses the company — among those they may connect", async () => {
    const owner = await createMemberOfNewCompany("owner");
    const other = await createMemberOfNewCompany("owner");
    await insert(Membership, {
      companyId: other.company.id,
      userId: owner.user.id,
      role: "member",
    });
    const registered = await registerApp();
    const { verifier, challenge } = pkce();
    const consentPage = await navigate(authorizeUrl(authorizationParams(registered, challenge)));
    const request = consentPage.searchParams.get("request")!;
    const cookie = await sessionCookieFor(owner.user);
    const details = await consentDetails(cookie, request);
    assert.equal(details.body.requestedCompanyId, null);
    const choices = new Map(
      (details.body.companies as Json[]).map((company) => [company.id, company]),
    );
    assert.equal(choices.get(owner.company.id)?.canConnect, true);
    assert.equal(choices.get(other.company.id)?.canConnect, false);
    assert.equal(choices.get(other.company.id)?.reason, CONNECT_APPS_ROLE_REQUIRED);

    const noChoice = await answerConsent(cookie, request, { decision: "allow" });
    assert.equal(noChoice.status, 400);
    const refused = await answerConsent(cookie, request, {
      decision: "allow",
      companyId: other.company.id,
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error, CONNECT_APPS_ROLE_REQUIRED);

    const allowed = await answerConsent(cookie, request, {
      decision: "allow",
      companyId: owner.company.id,
    });
    assert.equal(allowed.status, 200);
    const code = new URL(String(allowed.body.redirectTo)).searchParams.get("code")!;
    const issued = await tokenRequest({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      client_id: registered.client_id,
    });
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    const token = (issued.body as unknown as TokenBody).access_token;
    const me = await whoami(owner.company.id, token);
    assert.equal((me.structuredContent as Json).authentication, "connected_app");
  });

  test("only owners and admins may connect an app", async () => {
    const owner = await createMemberOfNewCompany("owner");
    const member = await colleague(owner.company, "member");
    const registered = await registerApp();
    const { challenge } = pkce();
    const consentPage = await navigate(
      authorizeUrl(
        authorizationParams(registered, challenge, { resource: mcpUrl(owner.company.id) }),
      ),
    );
    const request = consentPage.searchParams.get("request")!;
    const cookie = await sessionCookieFor(member.user);
    const details = await consentDetails(cookie, request);
    assert.deepEqual(
      (details.body.companies as Json[]).map((company) => [company.canConnect, company.reason]),
      [[false, CONNECT_APPS_ROLE_REQUIRED]],
    );
    const refused = await answerConsent(cookie, request, { decision: "allow" });
    assert.equal(refused.status, 403);

    const admin = await colleague(owner.company, "admin");
    const { tokens } = await connectApp(admin);
    assert.equal(
      (await whoami(owner.company.id, tokens.access_token)).structuredContent?.role,
      "admin",
    );
  });

  test("a company that requires two-factor authentication requires it to connect an app", async () => {
    const owner = await createMemberOfNewCompany("owner");
    await AppDataSource.getRepository(Company).update(
      { id: owner.company.id },
      { requireTwoFactor: true },
    );
    const registered = await registerApp();
    const { challenge } = pkce();
    const consentPage = await navigate(
      authorizeUrl(
        authorizationParams(registered, challenge, { resource: mcpUrl(owner.company.id) }),
      ),
    );
    const request = consentPage.searchParams.get("request")!;
    const cookie = await sessionCookieFor(owner.user);
    const refused = await answerConsent(cookie, request, { decision: "allow" });
    assert.equal(refused.status, 403);
    assert.match(String(refused.body.error), /two-factor/);
  });

  test("an app asking for another company's server cannot be connected by a non-member", async () => {
    const mine = await createMemberOfNewCompany("owner");
    const theirs = await createMemberOfNewCompany("owner");
    const registered = await registerApp();
    const { challenge } = pkce();
    const consentPage = await navigate(
      authorizeUrl(
        authorizationParams(registered, challenge, { resource: mcpUrl(theirs.company.id) }),
      ),
    );
    const request = consentPage.searchParams.get("request")!;
    const cookie = await sessionCookieFor(mine.user);
    const details = await consentDetails(cookie, request);
    assert.equal(details.body.requestedCompanyId, theirs.company.id);
    assert.deepEqual(details.body.companies, [], "nothing to choose: they are not a member");
    const refused = await answerConsent(cookie, request, { decision: "allow" });
    assert.equal(refused.status, 403);
    const switched = await answerConsent(cookie, request, {
      decision: "allow",
      companyId: mine.company.id,
    });
    assert.equal(switched.status, 400, "the company the app asked for cannot be swapped");
  });

  test("the consent API takes a signed-in browser and nothing else", async () => {
    const member = await createMemberOfNewCompany("owner");
    const { request, tokens } = await connectApp(member).then(async (connected) => ({
      ...connected,
      request: (await approvedCode(member)).request,
    }));
    const { token: apiKey } = await mintTestApiKey(member.user.id, member.company.id);
    for (const authorization of [`Bearer ${apiKey}`, `Bearer ${tokens.access_token}`]) {
      const response = await fetch(
        `${baseUrl}/api/oauth/consent?request=${encodeURIComponent(request)}`,
        { headers: { authorization } },
      );
      assert.equal(response.status, 401, authorization.slice(0, 11));
    }
    const cookie = await sessionCookieFor(member.user);
    const insideAiBrowser = await consentDetails(cookie, request, {
      [AI_BROWSER_REQUEST_HEADER]: AI_BROWSER_REQUEST_VALUE,
    });
    assert.equal(insideAiBrowser.status, 403, "an AI Employee's browser cannot approve an app");
    const crossSite = await fetch(`${baseUrl}/api/oauth/consent`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        origin: "https://attacker.example.test",
      },
      body: JSON.stringify({ request, decision: "allow" }),
    });
    assert.equal(crossSite.status, 403, "another site cannot answer for the Member");
  });

  test("an expired or altered request is refused", async () => {
    const member = await createMemberOfNewCompany("owner");
    const { request, cookie } = await approvedCode(member);
    const parts = request.split(".");
    parts[4] = `${parts[4].slice(0, -2)}AA`;
    const altered = await consentDetails(cookie, parts.join("."));
    assert.equal(altered.status, 410);

    const realNow = Date.now;
    Date.now = () => realNow() + 16 * 60_000;
    try {
      const expired = await consentDetails(cookie, request);
      assert.equal(expired.status, 410);
      assert.match(String(expired.body.error), /expired/);
    } finally {
      Date.now = realNow;
    }
  });
});

describe("the code exchange", () => {
  test("PKCE: a wrong or missing verifier is refused, and the code still works with the right one", async () => {
    const member = await createMemberOfNewCompany("owner");
    const { registered, code, verifier } = await approvedCode(member);
    const base = {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: registered.client_id,
    };
    const wrong = await tokenRequest({ ...base, code_verifier: pkce().verifier });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error, "invalid_grant");
    assert.match(String(wrong.body.error_description), /PKCE/);
    const missing = await tokenRequest(base);
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, "invalid_request");
    const right = await tokenRequest({ ...base, code_verifier: verifier });
    assert.equal(right.status, 200, JSON.stringify(right.body));
    assert.equal(right.headers.get("cache-control"), "no-store");
  });

  test("the code is bound to its client, redirect URI and company", async () => {
    const member = await createMemberOfNewCompany("owner");
    const other = await createMemberOfNewCompany("owner");
    const { registered, code, verifier } = await approvedCode(member);
    const thief = await registerApp();
    const base = {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      client_id: registered.client_id,
    };
    const otherClient = await tokenRequest({ ...base, client_id: thief.client_id });
    assert.equal(otherClient.body.error, "invalid_grant");
    const otherRedirect = await tokenRequest({
      ...base,
      redirect_uri: "https://app.example.test/elsewhere",
    });
    assert.equal(otherRedirect.body.error, "invalid_grant");
    const otherCompany = await tokenRequest({ ...base, resource: mcpUrl(other.company.id) });
    assert.equal(otherCompany.body.error, "invalid_target");
    assert.equal((await tokenRequest(base)).status, 200);
  });

  test("a code used twice withdraws the app the first use created", async () => {
    const member = await createMemberOfNewCompany("owner");
    const { registered, code, verifier } = await approvedCode(member);
    const params = {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      client_id: registered.client_id,
    };
    const first = await tokenRequest(params);
    assert.equal(first.status, 200);
    const firstToken = (first.body as unknown as TokenBody).access_token;
    assert.equal((await mcp(member.company.id, firstToken)).status, 200);
    const replay = await tokenRequest(params);
    assert.equal(replay.status, 400);
    assert.equal(replay.body.error, "invalid_grant");
    assert.equal((await mcp(member.company.id, firstToken)).status, 401);
    const apps = await AppDataSource.getRepository(ConnectedApp).findBy({
      companyId: member.company.id,
    });
    assert.deepEqual(
      apps.map((row) => row.revokedReason),
      ["reuse"],
    );
  });

  test("client authentication: a confidential client must present its secret", async () => {
    const member = await createMemberOfNewCompany("owner");
    const registered = await registerApp({ token_endpoint_auth_method: "client_secret_basic" });
    const { code, verifier } = await approvedCode(member, { registered });
    const params = {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    };
    const unknown = await tokenRequest({ ...params, client_id: "gci_nobody" });
    assert.equal(unknown.status, 401);
    assert.equal(unknown.body.error, "invalid_client");
    const basic = (secret: string) =>
      `Basic ${Buffer.from(`${registered.client_id}:${secret}`).toString("base64")}`;
    const wrongSecret = await tokenRequest(params, { authorization: basic("gcs_wrong") });
    assert.equal(wrongSecret.status, 401);
    assert.equal(wrongSecret.headers.get("www-authenticate"), 'Basic realm="Genosyn"');
    const noSecret = await tokenRequest({ ...params, client_id: registered.client_id });
    assert.equal(noSecret.status, 401);
    const right = await tokenRequest(params, { authorization: basic(registered.client_secret!) });
    assert.equal(right.status, 200, JSON.stringify(right.body));
  });

  test("other grants are not offered", async () => {
    const registered = await registerApp();
    const answer = await tokenRequest({
      grant_type: "client_credentials",
      client_id: registered.client_id,
    });
    assert.equal(answer.status, 400);
    assert.equal(answer.body.error, "unsupported_grant_type");
  });
});

describe("what the token reaches", () => {
  test("its company's MCP server, and not another company's — even one the Member owns", async () => {
    const member = await createMemberOfNewCompany("owner");
    const other = await createMemberOfNewCompany("owner");
    await insert(Membership, {
      companyId: other.company.id,
      userId: member.user.id,
      role: "owner",
    });
    const { tokens } = await connectApp(member);
    assert.equal((await mcp(member.company.id, tokens.access_token)).status, 200);
    const elsewhere = await mcp(other.company.id, tokens.access_token);
    assert.equal(elsewhere.status, 401);
    assert.match(String(elsewhere.headers.get("www-authenticate")), /error="invalid_token"/);
  });

  test("never the REST API directly: the token's audience is the MCP endpoint", async () => {
    const member = await createMemberOfNewCompany("owner");
    const { tokens } = await connectApp(member);
    for (const path of [
      `/api/companies/${member.company.id}/me`,
      `/api/companies/${member.company.id}/revenue/stages`,
      "/api/auth/me",
      "/api/companies",
    ]) {
      const response = await fetch(`${baseUrl}${path}`, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      });
      assert.equal(response.status, 401, path);
    }
    // Through the server, the same operation answers: the tool's call is the
    // App's own, in memory.
    assert.equal(
      ((await whoami(member.company.id, tokens.access_token)).structuredContent as Json).role,
      "owner",
    );
  });

  test("a bearer-only guard on any other path still refuses it: its audience is /mcp", async () => {
    const member = await createMemberOfNewCompany("owner");
    const { tokens } = await connectApp(member);
    const { token: apiKey } = await mintTestApiKey(member.user.id, member.company.id);
    const elsewhere = express();
    elsewhere.use("/api/companies/:cid/elsewhere", requireBearerAuth, (_req, res) => {
      res.json({ ok: true });
    });
    const listener = elsewhere.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/api/companies/${member.company.id}/elsewhere`;
    try {
      const byApp = await fetch(url, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      });
      assert.equal(byApp.status, 401);
      const byKey = await fetch(url, { headers: { authorization: `Bearer ${apiKey}` } });
      assert.equal(byKey.status, 200);
    } finally {
      listener.close();
    }
  });

  test("the guards an API key meets apply: session-only routes refuse it even in memory", async () => {
    const member = await createMemberOfNewCompany("owner");
    const { tokens } = await connectApp(member);
    const inMemory = (path: string, method = "GET") =>
      requestInProcess(app as unknown as RequestListener, {
        method,
        path,
        headers: { authorization: `Bearer ${tokens.access_token}`, host: "127.0.0.1" },
        timeoutMs: 10_000,
        maxResponseBytes: 100_000,
      });
    const keys = await inMemory(`/api/companies/${member.company.id}/api-keys`);
    assert.equal(keys.status, 403);
    assert.match(keys.body.toString(), /requires a logged-in browser session/);
    const apps = await inMemory(`/api/companies/${member.company.id}/connected-apps`);
    assert.equal(apps.status, 403);
    const vault = await inMemory(`/api/companies/${member.company.id}/vault/items`);
    assert.equal(vault.status, 403);
    assert.match(vault.body.toString(), /Vault access requires a logged-in browser session/);
    const account = await inMemory("/api/auth/me");
    assert.equal(account.status, 401, "account routes take no bearer credential");
    const stages = await inMemory(`/api/companies/${member.company.id}/revenue/stages`);
    assert.equal(stages.status, 200, "an ordinary operation answers");

    // And the MCP server does not offer what needs a person at a browser.
    const described = await mcp(member.company.id, tokens.access_token, {
      body: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "describe_operation", arguments: { operationId: "createApiKey" } },
      },
    });
    const result = described.body.result as CallToolResult;
    assert.equal(result.isError, true);
    assert.match(textOf(result), /signed-in browser|browser session/);
  });

  test("a browser page from another site is still refused, and a cookie alone never opens it", async () => {
    const member = await createMemberOfNewCompany("owner");
    const { tokens, cookie } = await connectApp(member);
    const foreign = await mcp(member.company.id, tokens.access_token, {
      headers: { origin: "https://attacker.example.test" },
    });
    assert.equal(foreign.status, 403);
    const cookieOnly = await mcp(member.company.id, null, { headers: { cookie } });
    assert.equal(cookieOnly.status, 401);
  });

  test("demoted below admin, or removed, the Member's app stops", async () => {
    const owner = await createMemberOfNewCompany("owner");
    const admin = await colleague(owner.company, "admin");
    const { tokens, registered } = await connectApp(admin);
    assert.equal((await mcp(owner.company.id, tokens.access_token)).status, 200);
    const memberships = AppDataSource.getRepository(Membership);
    await memberships.update(
      { companyId: owner.company.id, userId: admin.user.id },
      { role: "member" },
    );
    const demoted = await mcp(owner.company.id, tokens.access_token);
    assert.equal(demoted.status, 403);
    assert.equal(demoted.body.error, CONNECT_APPS_ROLE_REQUIRED);
    const refused = await refresh(registered, tokens.refresh_token);
    assert.equal(refused.body.error, "invalid_grant");
    await memberships.update(
      { companyId: owner.company.id, userId: admin.user.id },
      { role: "admin" },
    );
    assert.equal((await mcp(owner.company.id, tokens.access_token)).status, 200);
    await memberships.delete({ companyId: owner.company.id, userId: admin.user.id });
    assert.equal((await mcp(owner.company.id, tokens.access_token)).status, 403);
  });
});

describe("refresh, expiry and revocation", () => {
  test("a refresh rotates both tokens; the old access token lasts until it expires", async () => {
    const member = await createMemberOfNewCompany("owner");
    const { tokens, registered, appId } = await connectApp(member);
    const before = await appRow(appId);
    const refreshed = await refresh(registered, tokens.refresh_token, {
      resource: mcpUrl(member.company.id),
      scope: "mcp",
    });
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
    const next = refreshed.body as unknown as TokenBody;
    assert.notEqual(next.access_token, tokens.access_token);
    assert.notEqual(next.refresh_token, tokens.refresh_token);
    assert.equal(next.scope, "mcp");
    assert.equal((await mcp(member.company.id, next.access_token)).status, 200);
    assert.equal((await mcp(member.company.id, tokens.access_token)).status, 200);
    assert.ok((await appRow(appId)).expiresAt >= before.expiresAt, "its 30 days start again");

    // Asking for more than `mcp` gets `mcp`: there is nothing else to grant.
    const wider = await refresh(registered, next.refresh_token, { scope: "mcp offline_access" });
    assert.equal(wider.status, 200, JSON.stringify(wider.body));
    assert.equal(wider.body.scope, "mcp");
    const latest = wider.body as unknown as TokenBody;
    const otherCompany = await refresh(registered, latest.refresh_token, {
      resource: mcpUrl((await createMemberOfNewCompany("owner")).company.id),
    });
    assert.equal(otherCompany.body.error, "invalid_target");
    const otherClient = await refresh(await registerApp(), latest.refresh_token);
    assert.equal(otherClient.body.error, "invalid_grant");
  });

  test("a spent refresh token used again later disconnects the app", async () => {
    const member = await createMemberOfNewCompany("owner");
    const { tokens, registered, appId } = await connectApp(member);
    const rotated = (await refresh(registered, tokens.refresh_token)).body as unknown as TokenBody;
    // Past the grace a concurrent refresh gets, a second use means a copy leaked.
    await AppDataSource.getRepository(ConnectedAppToken).update(
      { tokenHash: hashToken(tokens.refresh_token) },
      { usedAt: new Date(Date.now() - REFRESH_REUSE_GRACE_MS - 5_000) },
    );
    const reused = await refresh(registered, tokens.refresh_token);
    assert.equal(reused.status, 400);
    assert.equal(reused.body.error, "invalid_grant");
    assert.match(String(reused.body.error_description), /already used/);
    const row = await appRow(appId);
    assert.equal(row.revokedReason, "reuse");
    assert.equal((await mcp(member.company.id, rotated.access_token)).status, 401);
    assert.equal((await refresh(registered, rotated.refresh_token)).body.error, "invalid_grant");
    const audit = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({
      targetId: appId,
      action: "connected_app.revoke",
    });
    assert.equal(audit.actorKind, "system");
    assert.equal(JSON.parse(audit.metadataJson).reason, "reuse");
  });

  test("two refreshes at once both succeed: a client racing itself is not a thief", async () => {
    const member = await createMemberOfNewCompany("owner");
    const { tokens, registered, appId } = await connectApp(member);
    const [a, b] = await Promise.all([
      refresh(registered, tokens.refresh_token),
      refresh(registered, tokens.refresh_token),
    ]);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal((await appRow(appId)).revokedAt, null);
  });

  test("an expired access token is refused, and so is an expired refresh token", async () => {
    const member = await createMemberOfNewCompany("owner");
    const { tokens, registered } = await connectApp(member);
    const rows = AppDataSource.getRepository(ConnectedAppToken);
    await rows.update(
      { tokenHash: hashToken(tokens.access_token) },
      { expiresAt: new Date(Date.now() - 1_000) },
    );
    const expired = await mcp(member.company.id, tokens.access_token);
    assert.equal(expired.status, 401);
    assert.match(String(expired.headers.get("www-authenticate")), /error="invalid_token"/);
    await rows.update(
      { tokenHash: hashToken(tokens.refresh_token) },
      { expiresAt: new Date(Date.now() - 1_000) },
    );
    const stale = await refresh(registered, tokens.refresh_token);
    assert.equal(stale.body.error, "invalid_grant");
    assert.match(String(stale.body.error_description), /expired/);
    assert.ok((await sweepExpiredConnectedAppTokens()) >= 2, "expired rows are swept");
  });

  test("disconnected at Settings → API keys: the tokens stop at once, and it is audited", async () => {
    const member = await createMemberOfNewCompany("owner");
    const { tokens, registered, appId, cookie } = await connectApp(member);
    await mcp(member.company.id, tokens.access_token);
    const listed = await fetch(`${baseUrl}/api/companies/${member.company.id}/connected-apps`, {
      headers: { cookie },
    });
    assert.equal(listed.status, 200);
    const [row] = (await listed.json()) as Json[];
    assert.equal(row.id, appId);
    assert.equal(row.name, "Test app");
    assert.equal(row.redirectOrigin, "https://app.example.test");
    assert.equal(row.revokedAt, null);
    assert.ok(row.lastUsedAt, "it records when it was last used");

    const { token: apiKey } = await mintTestApiKey(member.user.id, member.company.id);
    const byKey = await fetch(`${baseUrl}/api/companies/${member.company.id}/connected-apps`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    assert.equal(byKey.status, 403, "listing needs a signed-in browser");

    const stranger = await createMemberOfNewCompany("owner");
    await insert(Membership, {
      companyId: member.company.id,
      userId: stranger.user.id,
      role: "owner",
    });
    const notTheirs = await fetch(
      `${baseUrl}/api/companies/${member.company.id}/connected-apps/${appId}`,
      { method: "DELETE", headers: { cookie: await sessionCookieFor(stranger.user) } },
    );
    assert.equal(notTheirs.status, 404, "a Member disconnects only their own apps");

    const disconnected = await fetch(
      `${baseUrl}/api/companies/${member.company.id}/connected-apps/${appId}`,
      { method: "DELETE", headers: { cookie } },
    );
    assert.equal(disconnected.status, 200);
    assert.equal(((await disconnected.json()) as Json).revokedReason, "member");
    assert.equal((await mcp(member.company.id, tokens.access_token)).status, 401);
    assert.equal((await refresh(registered, tokens.refresh_token)).body.error, "invalid_grant");
    const audit = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({
      targetId: appId,
      action: "connected_app.revoke",
    });
    assert.equal(audit.actorUserId, member.user.id);
    assert.equal(audit.actorKind, "user");
  });

  test("the app can revoke its own tokens (RFC 7009), and only its own", async () => {
    const member = await createMemberOfNewCompany("owner");
    const { tokens, registered, appId } = await connectApp(member);
    const revoke = (token: string, clientId: string) =>
      fetch(`${baseUrl}/api/oauth/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token, client_id: clientId }),
      });
    const other = await registerApp();
    assert.equal((await revoke(tokens.refresh_token, other.client_id)).status, 200);
    assert.equal((await appRow(appId)).revokedAt, null, "another client's request changes nothing");
    assert.equal((await revoke("grt_unknown", registered.client_id)).status, 200);
    assert.equal((await revoke(tokens.refresh_token, registered.client_id)).status, 200);
    assert.equal((await appRow(appId)).revokedReason, "app");
    assert.equal((await mcp(member.company.id, tokens.access_token)).status, 401);
  });

  test("tokens are stored only as hashes", async () => {
    const member = await createMemberOfNewCompany("owner");
    const { tokens, appId } = await connectApp(member);
    const rows = await AppDataSource.getRepository(ConnectedAppToken).findBy({
      connectedAppId: appId,
    });
    assert.deepEqual(rows.map((row) => row.kind).sort(), ["access", "refresh"]);
    const stored = JSON.stringify(rows) + JSON.stringify(await appRow(appId));
    assert.ok(!stored.includes(tokens.access_token));
    assert.ok(!stored.includes(tokens.refresh_token));
    assert.ok(rows.some((row) => row.tokenHash === hashToken(tokens.access_token)));
  });
});

describe("housekeeping", () => {
  test("registrations nobody connected are pruned after a month; connected ones stay", async () => {
    const member = await createMemberOfNewCompany("owner");
    const unused = await registerApp();
    const used = await registerApp();
    await connectApp(member, { registered: used });
    const clientsRepo = AppDataSource.getRepository(OAuthClient);
    const old = new Date(Date.now() - 31 * 86_400_000);
    for (const clientId of [unused.client_id, used.client_id]) {
      await clientsRepo.update({ clientId }, { createdAt: old, lastUsedAt: old });
    }
    await pruneUnusedClients();
    assert.equal(await clientsRepo.countBy({ clientId: unused.client_id }), 0);
    assert.equal(await clientsRepo.countBy({ clientId: used.client_id }), 1);
  });
});
