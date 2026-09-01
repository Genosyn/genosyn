import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";

import express from "express";

import { isLoopbackAddress, loopbackOnly } from "./loopbackOnly.js";

/**
 * `/api/internal/*` may only be reached from this machine.
 *
 * Both internal routers mount above `requireTrustedOrigin` and above the
 * session middleware — correctly, because their callers are machines holding a
 * bearer token rather than browsers holding a cookie. What was missing is the
 * other half: nothing checked that the machine was one we spawned. The Helm
 * ingress publishes `/` with `pathType: Prefix`, so on a hosted install the
 * full AI-Employee tool surface (send mail, create and delete Routines, write
 * Bases) was reachable from the public internet behind a seven-hour in-memory
 * token with no throttling.
 *
 * Two independent conditions have to hold, and the second is the one that is
 * easy to miss: the socket must be loopback, AND the request must not carry
 * proxy headers. A reverse proxy sharing the host satisfies the first while
 * relaying something from anywhere, which is exactly the topology that would
 * otherwise smuggle a public request in as a local one.
 */

describe("isLoopbackAddress", () => {
  const loopback = [
    "127.0.0.1",
    "127.0.0.53",
    "127.255.255.254",
    "::1",
    "::ffff:127.0.0.1",
    "::FFFF:127.0.0.1",
    "::ffff:127.1.2.3",
    "::1%lo0",
  ];
  for (const address of loopback) {
    test(`accepts ${address}`, () => {
      assert.equal(isLoopbackAddress(address), true);
    });
  }

  const remote = [
    "10.0.0.1",
    "192.168.1.10",
    "172.16.5.4",
    "8.8.8.8",
    "169.254.169.254",
    "0.0.0.0",
    "::",
    "fe80::1",
    "2001:db8::1",
    "::ffff:10.0.0.1",
    "::ffff:169.254.169.254",
    "128.0.0.1",
    "27.0.0.1",
  ];
  for (const address of remote) {
    test(`rejects ${address}`, () => {
      assert.equal(isLoopbackAddress(address), false);
    });
  }

  const malformed = ["", "localhost", "not-an-ip", "127.0.0.1.1", "999.0.0.1", "127.0.0"];
  for (const address of malformed) {
    test(`rejects the unparseable ${JSON.stringify(address)}`, () => {
      assert.equal(isLoopbackAddress(address), false);
    });
  }

  test("rejects undefined rather than failing open", () => {
    assert.equal(isLoopbackAddress(undefined), false);
  });

  test("does not accept a hostname that merely starts with 127", () => {
    // "127.0.0.1.example.com" is a real DNS-rebinding trick; it is not an IP,
    // so `net.isIP` refuses it and the prefix check is never reached.
    assert.equal(isLoopbackAddress("127.0.0.1.example.com"), false);
  });
});

describe("loopbackOnly over a real socket", () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    const app = express();
    app.use("/api/internal/mcp", loopbackOnly, (_req, res) => {
      res.json({ reached: true });
    });
    // A control route with no guard, so a failing assertion below cannot be
    // explained by the test server simply being broken.
    app.use("/api/open", (_req, res) => res.json({ reached: true }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  test("a genuine loopback call passes through", async () => {
    const res = await fetch(`${baseUrl}/api/internal/mcp`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { reached: true });
  });

  test("the control route is reachable, proving the harness works", async () => {
    const res = await fetch(`${baseUrl}/api/open`);
    assert.equal(res.status, 200);
  });

  const forwardedHeaders = [
    ["x-forwarded-for", "203.0.113.9"],
    ["x-forwarded-host", "genosyn.example.com"],
    ["x-forwarded-proto", "https"],
    ["x-real-ip", "203.0.113.9"],
    ["forwarded", "for=203.0.113.9;proto=https"],
  ] as const;

  for (const [header, value] of forwardedHeaders) {
    test(`a loopback socket carrying ${header} is refused`, async () => {
      const res = await fetch(`${baseUrl}/api/internal/mcp`, {
        headers: { [header]: value },
      });
      assert.equal(res.status, 404);
    });
  }

  test("a forwarded header is refused even when it claims to come from loopback", async () => {
    // The header's *value* is never trusted — its presence is what decides.
    // Otherwise spoofing `X-Forwarded-For: 127.0.0.1` would be the bypass.
    const res = await fetch(`${baseUrl}/api/internal/mcp`, {
      headers: { "x-forwarded-for": "127.0.0.1" },
    });
    assert.equal(res.status, 404);
  });

  test("the refusal does not confirm the surface exists", async () => {
    const res = await fetch(`${baseUrl}/api/internal/mcp`, {
      headers: { "x-forwarded-for": "203.0.113.9" },
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Not found" });
  });

  test("refusal applies to every method, not just GET", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await fetch(`${baseUrl}/api/internal/mcp`, {
        method,
        headers: { "x-forwarded-for": "203.0.113.9" },
      });
      assert.equal(res.status, 404, `${method} should be refused`);
    }
  });
});

describe("loopbackOnly unit contract", () => {
  function call(remoteAddress: string | undefined, headers: Record<string, string> = {}) {
    let nexted = false;
    let status: number | null = null;
    let body: unknown = null;
    const req = { socket: { remoteAddress }, headers } as never;
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json(payload: unknown) {
        body = payload;
        return this;
      },
    } as never;
    loopbackOnly(req, res, () => {
      nexted = true;
    });
    return { nexted, status, body };
  }

  test("a remote socket is refused even with no headers at all", () => {
    const result = call("203.0.113.9");
    assert.equal(result.nexted, false);
    assert.equal(result.status, 404);
  });

  test("a missing socket address fails closed", () => {
    const result = call(undefined);
    assert.equal(result.nexted, false);
    assert.equal(result.status, 404);
  });

  test("a loopback socket with clean headers is allowed", () => {
    const result = call("127.0.0.1");
    assert.equal(result.nexted, true);
    assert.equal(result.status, null);
  });

  test("header matching is case-insensitive, as Node lowercases them", () => {
    // Express/Node normalise incoming header names to lowercase, so the guard
    // reads lowercase keys. This pins that assumption.
    const result = call("127.0.0.1", { "x-forwarded-for": "1.2.3.4" });
    assert.equal(result.nexted, false);
  });

  test("an empty forwarded header still counts as relayed", () => {
    // A proxy that sets the header to an empty string has still relayed.
    const result = call("127.0.0.1", { "x-forwarded-for": "" });
    assert.equal(result.nexted, false);
  });

  test("an unrelated header does not trip the guard", () => {
    const result = call("127.0.0.1", { authorization: "Bearer x", "user-agent": "genosyn" });
    assert.equal(result.nexted, true);
  });
});
