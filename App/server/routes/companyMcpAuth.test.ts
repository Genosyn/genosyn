import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createApp } from "../app.js";
import { AppDataSource } from "../db/datasource.js";
import { Membership } from "../db/entities/Membership.js";
import { errorHandler } from "../middleware/error.js";
import {
  AI_BROWSER_REQUEST_HEADER,
  AI_BROWSER_REQUEST_VALUE,
} from "../services/browserRequestBoundary.js";
import { setPublicUrl } from "../services/publicUrl.js";
import {
  createMemberOfNewCompany,
  mintTestApiKey,
  sessionCookieFor,
  withTestInstanceSecrets,
} from "../test/apiAccess.js";
import { closeTestDb, initTestDb, insert } from "../test/dbHarness.js";

/**
 * Who may reach the Genosyn MCP server, and how the endpoint speaks HTTP.
 *
 * The rules: an API key and nothing else — never the session cookie — for the
 * company the path names, live, held by a Member still in that company; no
 * browser page from another site; POST only, with JSON in and JSON out. These
 * requests are raw HTTP so every status, header and body the endpoint answers
 * with is visible, not just what an SDK makes of it.
 */

const PUBLIC_URL = "http://genosyn.example.test";
let server: Server;
let baseUrl = "";
let restoreSecrets: () => void;
const app = createApp();
app.use(errorHandler);

before(async () => {
  restoreSecrets = withTestInstanceSecrets();
  await initTestDb();
  await setPublicUrl(PUBLIC_URL);
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
  restoreSecrets();
});

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "raw-http-test", version: "1.0.0" },
  },
};
const LIST_TOOLS = { jsonrpc: "2.0", id: 2, method: "tools/list" };
const WHOAMI = {
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: { name: "whoami", arguments: {} },
};

type Answer = { status: number; headers: Headers; text: string; json: unknown };

async function send(
  companyId: string,
  options: {
    method?: string;
    body?: unknown;
    rawBody?: string;
    token?: string;
    headers?: Record<string, string>;
    accept?: string | null;
  } = {},
): Promise<Answer> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.accept !== null)
    headers.accept = options.accept ?? "application/json, text/event-stream";
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const hasBody = options.body !== undefined || options.rawBody !== undefined;
  if (hasBody && !headers["content-type"]) headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}/api/companies/${companyId}/mcp`, {
    method: options.method ?? "POST",
    headers,
    body:
      options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, text, json };
}

async function ownerWithKey() {
  const member = await createMemberOfNewCompany("owner");
  const { key, token } = await mintTestApiKey(member.user.id, member.company.id);
  return { ...member, key, token };
}

describe("an API key is the one credential", () => {
  test("a live key for the company opens the server", async () => {
    const { company, token } = await ownerWithKey();
    const initialized = await send(company.id, { token, body: INITIALIZE });
    assert.equal(initialized.status, 200, initialized.text);
    const result = (
      initialized.json as { result: { serverInfo: { name: string }; protocolVersion: string } }
    ).result;
    assert.equal(result.serverInfo.name, "genosyn");
    assert.equal(result.protocolVersion, "2025-06-18");
    assert.equal(initialized.headers.get("mcp-session-id"), null, "stateless: no session");
    const tools = await send(company.id, { token, body: LIST_TOOLS });
    assert.equal(tools.status, 200);
    assert.equal((tools.json as { result: { tools: unknown[] } }).result.tools.length, 6);
  });

  test("no key: 401, asking for a Bearer token", async () => {
    const { company } = await ownerWithKey();
    const answer = await send(company.id, { body: INITIALIZE });
    assert.equal(answer.status, 401);
    assert.equal(answer.headers.get("www-authenticate"), 'Bearer realm="Genosyn"');
    assert.match((answer.json as { error: string }).error, /An API key is required/);
  });

  test("malformed, unknown, revoked and expired keys are all refused", async () => {
    const { user, company } = await ownerWithKey();
    const revoked = await mintTestApiKey(user.id, company.id, { revokedAt: new Date() });
    const expired = await mintTestApiKey(user.id, company.id, {
      expiresAt: new Date(Date.now() - 1_000),
    });
    const future = await mintTestApiKey(user.id, company.id, {
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    for (const [label, authorization] of [
      ["garbage", "Bearer nope"],
      ["short", "Bearer gen_short"],
      ["wrong prefix", `Bearer xyz_${"A".repeat(43)}`],
      ["bad alphabet", `Bearer gen_${"*".repeat(43)}`],
      ["unknown", `Bearer gen_${"B".repeat(43)}`],
      ["basic", `Basic ${future.token}`],
      ["revoked", `Bearer ${revoked.token}`],
      ["expired", `Bearer ${expired.token}`],
    ] as const) {
      const answer = await send(company.id, { body: INITIALIZE, headers: { authorization } });
      assert.equal(answer.status, 401, label);
      assert.match((answer.json as { error: string }).error, /not accepted/, label);
      assert.equal(answer.headers.get("www-authenticate"), 'Bearer realm="Genosyn"', label);
    }
    assert.equal((await send(company.id, { token: future.token, body: INITIALIZE })).status, 200);
  });

  test("a key works only at its own company's endpoint, even for a Member of both", async () => {
    const { user, company, token } = await ownerWithKey();
    const other = await createMemberOfNewCompany("owner");
    await insert(Membership, { companyId: other.company.id, userId: user.id, role: "owner" });
    assert.equal((await send(company.id, { token, body: INITIALIZE })).status, 200);
    const elsewhere = await send(other.company.id, { token, body: INITIALIZE });
    assert.equal(elsewhere.status, 401, "the key is not recognized at another company");
  });

  test("a key whose Member left the company is refused", async () => {
    const { user, company, token } = await ownerWithKey();
    await AppDataSource.getRepository(Membership).delete({
      companyId: company.id,
      userId: user.id,
    });
    const answer = await send(company.id, { token, body: INITIALIZE });
    assert.equal(answer.status, 403);
  });

  test("a browser session alone never opens it", async () => {
    const { user, company } = await ownerWithKey();
    const cookie = await sessionCookieFor(user);
    const answer = await send(company.id, { body: INITIALIZE, headers: { cookie } });
    assert.equal(answer.status, 401, "the cookie is not a credential here");
  });

  test("with a cookie and a key, the key decides — and the cookie is left alone", async () => {
    const owner = await ownerWithKey();
    const colleague = await insert(Membership, {
      companyId: owner.company.id,
      userId: (await createMemberOfNewCompany("owner")).user.id,
      role: "member",
      financeAccess: "none",
    });
    const { token } = await mintTestApiKey(colleague.userId, owner.company.id);
    const cookie = await sessionCookieFor(owner.user);
    const answer = await send(owner.company.id, { token, body: WHOAMI, headers: { cookie } });
    assert.equal(answer.status, 200, answer.text);
    const structured = (
      answer.json as { result: { structuredContent: { user: { id: string }; role: string } } }
    ).result.structuredContent;
    assert.equal(
      structured.user.id,
      colleague.userId,
      "acts as the key's Member, not the cookie's",
    );
    assert.equal(structured.role, "member");
    assert.equal(answer.headers.get("set-cookie"), null, "the session is never touched");
  });

  test("an AI Employee's browser cannot reach it, key or not", async () => {
    const { company, token } = await ownerWithKey();
    const answer = await send(company.id, {
      token,
      body: INITIALIZE,
      headers: { [AI_BROWSER_REQUEST_HEADER]: AI_BROWSER_REQUEST_VALUE },
    });
    assert.equal(answer.status, 403);
    assert.match(answer.text, /AI Browser/);
  });
});

describe("browser origins", () => {
  test("a page on another site is refused before anything else", async () => {
    const { company, token } = await ownerWithKey();
    for (const origin of ["https://evil.example", "null", PUBLIC_URL.replace("http:", "https:")]) {
      const answer = await send(company.id, { token, body: INITIALIZE, headers: { origin } });
      assert.equal(answer.status, 403, origin);
      const error = (answer.json as { jsonrpc: string; error: { code: number; message: string } })
        .error;
      assert.equal((answer.json as { jsonrpc: string }).jsonrpc, "2.0");
      assert.equal(error.code, -32000);
      assert.match(error.message, /Origin not allowed/);
      assert.equal(answer.headers.get("access-control-allow-origin"), null);
    }
  });

  test("an origin matching only the request's own Host is still refused (DNS rebinding)", async () => {
    const { company, token } = await ownerWithKey();
    const answer = await send(company.id, {
      token,
      body: INITIALIZE,
      headers: { origin: baseUrl },
    });
    assert.equal(answer.status, 403);
  });

  test("a CORS preflight from another site gets no permission", async () => {
    const { company } = await ownerWithKey();
    const answer = await send(company.id, {
      method: "OPTIONS",
      accept: null,
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type",
      },
    });
    assert.equal(answer.status, 403);
    assert.equal(answer.headers.get("access-control-allow-origin"), null);
  });

  test("no Origin (an MCP client) and this install's own origin are both fine", async () => {
    const { company, token } = await ownerWithKey();
    assert.equal((await send(company.id, { token, body: INITIALIZE })).status, 200);
    const own = await send(company.id, {
      token,
      body: INITIALIZE,
      headers: { origin: PUBLIC_URL },
    });
    assert.equal(own.status, 200, own.text);
  });
});

describe("the transport", () => {
  test("GET and DELETE answer 405: stateless, no stream, no session", async () => {
    const { company, token } = await ownerWithKey();
    for (const method of ["GET", "DELETE"]) {
      const answer = await send(company.id, { method, token, accept: "text/event-stream" });
      assert.equal(answer.status, 405, method);
      assert.equal(answer.headers.get("allow"), "POST", method);
      assert.match(
        (answer.json as { error: { message: string } }).error.message,
        /stateless and accepts POST only/,
      );
    }
    assert.equal((await send(company.id, { method: "GET" })).status, 401, "still needs a key");
  });

  test("Accept: none, a wildcard or plain JSON are fine; ruling JSON out is 406", async () => {
    const { company, token } = await ownerWithKey();
    for (const accept of [
      null,
      "*/*",
      "application/json",
      "application/*",
      "application/json, text/plain",
    ]) {
      const answer = await send(company.id, { token, body: INITIALIZE, accept });
      assert.equal(answer.status, 200, `Accept: ${accept} → ${answer.text}`);
      assert.match(answer.headers.get("content-type") ?? "", /application\/json/);
    }
    const refused = await send(company.id, { token, body: INITIALIZE, accept: "text/html" });
    assert.equal(refused.status, 406);
  });

  test("a body that is not JSON-RPC is refused with a JSON-RPC error", async () => {
    const { company, token } = await ownerWithKey();
    const broken = await send(company.id, { token, rawBody: "{not json" });
    assert.equal(broken.status, 400);
    assert.equal((broken.json as { error: { code: number } }).error.code, -32700);
    const wrongShape = await send(company.id, { token, body: { hello: "world" } });
    assert.equal(wrongShape.status, 400);
    assert.equal((wrongShape.json as { error: { code: number } }).error.code, -32700);
    const wrongType = await send(company.id, {
      token,
      rawBody: JSON.stringify(INITIALIZE),
      headers: { "content-type": "text/plain" },
    });
    assert.equal(wrongType.status, 415);
  });

  test("past 1 MB a body may only carry one base64 string, up to 10 MB in all", async () => {
    const { company, token } = await ownerWithKey();
    const base64 = { ...LIST_TOOLS, params: { _meta: { file: "QUJD".repeat(1024 * 1024) } } };
    assert.equal(
      (await send(company.id, { token, body: base64 })).status,
      200,
      "4 MB of base64 is fine",
    );
    // The same size in many small values would block the process to parse.
    const manyValues = {
      ...LIST_TOOLS,
      params: { _meta: { values: Array.from({ length: 400_000 }, () => ({})) } },
    };
    const refused = await send(company.id, { token, body: manyValues });
    assert.equal(refused.status, 413);
    assert.match(
      (refused.json as { error: { message: string } }).error.message,
      /past 1 MB, a request may carry only a file, as one base64 string/,
    );
    // Text with quotes and escapes is not base64 either.
    const prose = { ...LIST_TOOLS, params: { _meta: { text: 'say "hi"\n'.repeat(200_000) } } };
    assert.equal((await send(company.id, { token, body: prose })).status, 413);
    const huge = await send(company.id, {
      token,
      body: { ...LIST_TOOLS, params: { _meta: { file: "QUJD".repeat(3 * 1024 * 1024) } } },
    });
    assert.equal(huge.status, 413);
    assert.match((huge.json as { error: { message: string } }).error.message, /10mb/);
  });

  test("a compressed body is refused rather than inflated", async () => {
    const { company, token } = await ownerWithKey();
    const { gzipSync } = await import("node:zlib");
    const answer = await send(company.id, {
      token,
      rawBody: gzipSync(JSON.stringify(LIST_TOOLS)) as unknown as string,
      headers: { "content-encoding": "gzip" },
    });
    assert.equal(answer.status, 415);
    assert.match((answer.json as { error: { message: string } }).error.message, /uncompressed/);
  });

  test("nothing else is served at or below the endpoint, and nothing falls through", async () => {
    const { company, token } = await ownerWithKey();
    for (const method of ["PUT", "PATCH"]) {
      const answer = await send(company.id, { method, token, body: LIST_TOOLS });
      assert.equal(answer.status, 405, method);
      assert.equal(answer.headers.get("allow"), "POST", method);
      assert.equal((answer.json as { jsonrpc: string }).jsonrpc, "2.0", method);
    }
    const below = await fetch(`${baseUrl}/api/companies/${company.id}/mcp/anything`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(LIST_TOOLS),
    });
    assert.equal(below.status, 404);
    assert.equal(((await below.json()) as { jsonrpc: string }).jsonrpc, "2.0");
  });

  test("a batch with a repeated request id is refused", async () => {
    const { company, token } = await ownerWithKey();
    const answer = await send(company.id, {
      token,
      body: [
        { jsonrpc: "2.0", id: 7, method: "ping" },
        { jsonrpc: "2.0", id: 7, method: "tools/list" },
      ],
    });
    assert.equal(answer.status, 400);
    assert.match(
      (answer.json as { error: { message: string } }).error.message,
      /own id; 7 is repeated/,
    );
  });

  test("a body is read only once the key checks out", async () => {
    const { company } = await ownerWithKey();
    // Were the body parsed first, this would be a 400 parse error.
    const broken = await send(company.id, { rawBody: "{not json" });
    assert.equal(broken.status, 401);
    // An oversized one is never read either: the server answers 401 (or hangs
    // up while the client is still sending) rather than buffering it for a 413.
    try {
      const huge = await send(company.id, { rawBody: "x".repeat(11 * 1024 * 1024) });
      assert.equal(huge.status, 401);
    } catch (error) {
      assert.match(
        String((error as { cause?: unknown }).cause ?? error),
        /ECONNRESET|EPIPE|socket/,
      );
    }
  });

  test("a small batch is answered as a batch; a big one is refused", async () => {
    const { company, token } = await ownerWithKey();
    const batch = await send(company.id, {
      token,
      body: [LIST_TOOLS, { jsonrpc: "2.0", id: 9, method: "ping" }],
    });
    assert.equal(batch.status, 200, batch.text);
    const replies = batch.json as Array<{ id: number }>;
    assert.deepEqual(replies.map((reply) => reply.id).sort(), [2, 9]);
    const big = await send(company.id, {
      token,
      body: Array.from({ length: 21 }, (_, index) => ({
        jsonrpc: "2.0",
        id: index,
        method: "ping",
      })),
    });
    assert.equal(big.status, 400);
    assert.match((big.json as { error: { message: string } }).error.message, /at most 20/);
  });

  test("notifications alone get 202 and no body", async () => {
    const { company, token } = await ownerWithKey();
    const answer = await send(company.id, {
      token,
      body: { jsonrpc: "2.0", method: "notifications/initialized" },
    });
    assert.equal(answer.status, 202);
    assert.equal(answer.text, "");
  });

  test("an unsupported protocol version header is refused", async () => {
    const { company, token } = await ownerWithKey();
    const answer = await send(company.id, {
      token,
      body: LIST_TOOLS,
      headers: { "mcp-protocol-version": "1999-01-01" },
    });
    assert.equal(answer.status, 400);
  });

  test("the SDK client tolerates the stateless GET refusal and works end to end", async () => {
    const { company, token } = await ownerWithKey();
    const client = new Client({ name: "sdk", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/api/companies/${company.id}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    try {
      const { tools } = await client.listTools();
      assert.equal(tools.length, 6);
    } finally {
      await client.close();
    }
  });

  test("a wrong key surfaces in the SDK client as an HTTP 401 with the reason", async () => {
    const { company } = await ownerWithKey();
    const client = new Client({ name: "sdk", version: "1.0.0" });
    await assert.rejects(
      client.connect(
        new StreamableHTTPClientTransport(new URL(`${baseUrl}/api/companies/${company.id}/mcp`), {
          requestInit: { headers: { authorization: `Bearer gen_${"C".repeat(43)}` } },
        }),
      ),
      (error: Error & { code?: number }) => {
        assert.equal(error.code, 401);
        assert.match(error.message, /The API key was not accepted/);
        return true;
      },
    );
  });
});
