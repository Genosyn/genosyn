import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { config } from "../../config.js";
import { outboundAgent } from "./outboundNetworkPolicy.js";

/**
 * Which requests an operator's HTTP proxy carries. The fake proxy answers
 * absolute-form requests itself and refuses every CONNECT, so each test sees
 * exactly what reached it without touching the network. `example.test` never
 * resolves, so a request that succeeds for it cannot have been looked up here.
 */

const PROXY_ENV = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];
// `config` is exported `as const`; flipped through a cast as in outboundUrl.test.ts.
const mutableSecurity = config.security as unknown as { multiTenant: boolean };

let proxy: Server;
let loopback: Server;
let proxyUrl: string;
let loopbackPort: number;
let seen: string[] = [];
let savedEnv: Record<string, string | undefined> = {};
let originalMultiTenant: boolean;

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

async function get(url: string): Promise<string> {
  const dispatcher = outboundAgent();
  try {
    const response = await fetch(url, { dispatcher } as RequestInit);
    return await response.text();
  } finally {
    await dispatcher.close();
  }
}

before(async () => {
  proxy = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.end("via proxy");
  });
  proxy.on("connect", (req, socket) => {
    seen.push(`CONNECT ${req.url}`);
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  loopback = createServer((_req, res) => res.end("direct"));
  await Promise.all([listen(proxy), listen(loopback)]);
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  loopbackPort = (loopback.address() as AddressInfo).port;
});

after(async () => {
  await Promise.all([close(proxy), close(loopback)]);
});

beforeEach(() => {
  seen = [];
  savedEnv = Object.fromEntries(PROXY_ENV.map((key) => [key, process.env[key]]));
  for (const key of PROXY_ENV) delete process.env[key];
  process.env.HTTP_PROXY = proxyUrl;
  process.env.HTTPS_PROXY = proxyUrl;
  originalMultiTenant = mutableSecurity.multiTenant;
});

afterEach(() => {
  for (const key of PROXY_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  mutableSecurity.multiTenant = originalMultiTenant;
});

test("sends plain http to the proxy in absolute form and https through CONNECT", async () => {
  assert.equal(await get("http://example.test/page"), "via proxy");
  await assert.rejects(get("https://example.test/"));
  assert.deepEqual(seen, ["GET http://example.test/page", "CONNECT example.test:443"]);
});

test("never proxies loopback, and loopback names still meet the lookup policy", async () => {
  process.env.NO_PROXY = "git.internal";
  // The tool bridge's literal loopback call stays on this host.
  assert.equal(await get(`http://127.0.0.1:${loopbackPort}/api/internal/mcp`), "direct");
  await assert.rejects(
    get(`http://localhost:${loopbackPort}/`),
    (error: Error & { cause?: { code?: string } }) => error.cause?.code === "EACCES",
  );
  assert.deepEqual(seen, []);
});

test("honours NO_PROXY=* as no proxy at all", async () => {
  process.env.NO_PROXY = "*";
  await get("http://example.test/").catch(() => undefined);
  assert.deepEqual(seen, []);
});

test("keeps a multi-tenant install off the proxy", async () => {
  mutableSecurity.multiTenant = true;
  await get("http://example.test/").catch(() => undefined);
  assert.deepEqual(seen, []);
});
