import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { config } from "../../config.js";
import {
  overrideRuntimeSettingsForTests,
  resetRuntimeSettingsCacheForTests,
} from "../services/runtimeSettings.js";
import {
  assertSafeOutboundUrl,
  isPublicIp,
  privateHostAllowed,
  safeFetchBuffer,
} from "./outboundUrl.js";

const originalFetch = globalThis.fetch;
// `config` is exported `as const`, so the shared-hosting switch is flipped
// through a cast — the same seam `runtimeSecurity.test.ts` and
// `companySso.test.ts` use.
const mutableSecurity = config.security as unknown as { multiTenant: boolean };
let originalPrivateHosts: string[];
let originalMultiTenant: boolean;

beforeEach(() => {
  originalPrivateHosts = [...config.security.outboundPrivateHostAllowlist];
  originalMultiTenant = mutableSecurity.multiTenant;
});

afterEach(() => {
  config.security.outboundPrivateHostAllowlist.splice(0, Infinity, ...originalPrivateHosts);
  mutableSecurity.multiTenant = originalMultiTenant;
  // The runtime half of the allowlist is a module-level cache shared by every
  // test in this process, so it is dropped here rather than per test.
  resetRuntimeSettingsCacheForTests();
  globalThis.fetch = originalFetch;
});

/** Put a host on the operator-editable list without a database round-trip. */
function runtimeAllowlist(...hosts: string[]): void {
  overrideRuntimeSettingsForTests({ network: { privateHostAllowlist: hosts } });
}

test("classifies non-public IPv4 and IPv6 ranges", () => {
  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "224.0.0.1",
    "::",
    "::1",
    "::ffff:192.168.1.1",
    "::ffff:c0a8:101",
    "::192.168.1.1",
    "64:ff9b::c0a8:101",
    "100::1",
    "fc00::1",
    "fe80::1",
    "fec0::1",
    "ff02::1",
    "2001::1",
    "2001:2::1",
    "2001:db8::1",
    "2002:c0a8:101::1",
    "3fff::1",
    "5f00::1",
  ]) {
    assert.equal(isPublicIp(address), false, address);
  }
  assert.equal(isPublicIp("8.8.8.8"), true);
  assert.equal(isPublicIp("2606:4700:4700::1111"), true);
});

test("rejects loopback URLs and embedded credentials", async () => {
  await assert.rejects(assertSafeOutboundUrl("http://127.0.0.1/admin"), /non-public/);
  await assert.rejects(assertSafeOutboundUrl("http://user:pass@example.com"), /credentials/);
});

test("accepts a literal public address without DNS", async () => {
  const url = await assertSafeOutboundUrl("https://8.8.8.8/example");
  assert.equal(url.hostname, "8.8.8.8");
});

test("the allowlist is the union of the config list and the runtime one", () => {
  // Boot configuration on its own. This is the half that still has to work:
  // the socket-level policy is installed before the database is open, so in
  // that window the runtime cache is still on its defaults.
  config.security.outboundPrivateHostAllowlist.splice(0, Infinity, "git.internal");
  assert.equal(privateHostAllowed("git.internal"), true);
  assert.equal(privateHostAllowed("ollama.lan"), false);

  // Admin → Runtime on its own, with nothing in config.ts at all.
  config.security.outboundPrivateHostAllowlist.splice(0, Infinity);
  runtimeAllowlist("ollama.lan");
  assert.equal(privateHostAllowed("ollama.lan"), true);
  assert.equal(privateHostAllowed("git.internal"), false);

  // Both, together, and a host on neither list is still refused.
  config.security.outboundPrivateHostAllowlist.splice(0, Infinity, "git.internal");
  assert.equal(privateHostAllowed("git.internal"), true);
  assert.equal(privateHostAllowed("ollama.lan"), true);
  assert.equal(privateHostAllowed("metadata.internal"), false);
});

test("a runtime-allowed private address is reachable, and an unlisted one is not", async () => {
  await assert.rejects(assertSafeOutboundUrl("http://10.0.0.5/api/v1"), /non-public/);

  runtimeAllowlist("10.0.0.5");

  const url = await assertSafeOutboundUrl("http://10.0.0.5/api/v1");
  assert.equal(url.hostname, "10.0.0.5");
});

test("both halves match on the normalized host, not the typed one", () => {
  config.security.outboundPrivateHostAllowlist.splice(0, Infinity, " Git.Internal. ");
  runtimeAllowlist("OLLAMA.Lan.");

  for (const host of ["git.internal", "GIT.INTERNAL", "Git.Internal."]) {
    assert.equal(privateHostAllowed(host), true, host);
  }
  for (const host of ["ollama.lan", "OLLAMA.LAN.", "Ollama.Lan"]) {
    assert.equal(privateHostAllowed(host), true, host);
  }
  assert.equal(privateHostAllowed("git.internal.example.com"), false);
});

test("a multi-tenant install ignores the runtime half entirely", () => {
  // A boot check cannot govern a value an operator can edit at any moment, so
  // the invariant lives here — the same shape as `memberBrowsersEnabled()`.
  // The config list keeps its own boot-time refusal in `runtimeSecurity.ts`.
  mutableSecurity.multiTenant = true;
  runtimeAllowlist("ollama.lan");

  assert.equal(privateHostAllowed("ollama.lan"), false);

  config.security.outboundPrivateHostAllowlist.splice(0, Infinity, "git.internal");
  assert.equal(privateHostAllowed("git.internal"), true);

  mutableSecurity.multiTenant = false;
  assert.equal(privateHostAllowed("ollama.lan"), true);
});

test("safe fetch can require HTTPS before issuing a request", async () => {
  config.security.outboundPrivateHostAllowlist.splice(0, Infinity, "unsubscribe.test");
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  await assert.rejects(
    safeFetchBuffer(
      "http://unsubscribe.test/one-click",
      {},
      {
        allowedProtocols: ["https:"],
      },
    ),
    /protocol http: is not allowed/,
  );
  assert.equal(calls, 0);
});

test("safe fetch revalidates and permits same-origin HTTPS redirects", async () => {
  config.security.outboundPrivateHostAllowlist.splice(0, Infinity, "unsubscribe.test");
  const seen: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    seen.push(url);
    return url.endsWith("/start")
      ? new Response(null, { status: 307, headers: { location: "/finish" } })
      : new Response("done", { status: 200 });
  }) as typeof fetch;

  const result = await safeFetchBuffer(
    "https://unsubscribe.test/start",
    { method: "POST", body: "fixed" },
    { allowedProtocols: ["https:"], sameOriginRedirectsOnly: true },
  );
  assert.deepEqual(seen, ["https://unsubscribe.test/start", "https://unsubscribe.test/finish"]);
  assert.equal(result.body.toString("utf8"), "done");
  assert.equal(result.url, "https://unsubscribe.test/finish");
});

test("safe fetch can refuse a cross-origin redirect before following it", async () => {
  config.security.outboundPrivateHostAllowlist.splice(
    0,
    Infinity,
    "unsubscribe.test",
    "other.test",
  );
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(null, {
      status: 307,
      headers: { location: "https://other.test/collect" },
    });
  }) as typeof fetch;

  await assert.rejects(
    safeFetchBuffer(
      "https://unsubscribe.test/start",
      { method: "POST" },
      {
        allowedProtocols: ["https:"],
        sameOriginRedirectsOnly: true,
      },
    ),
    /Cross-origin outbound redirects are not allowed/,
  );
  assert.equal(calls, 1);
});

test("safe fetch can refuse every redirect before replaying a POST", async () => {
  config.security.outboundPrivateHostAllowlist.splice(0, Infinity, "unsubscribe.test");
  for (const status of [301, 302, 303, 307, 308]) {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(null, {
        status,
        headers: { location: "/must-not-run" },
      });
    }) as typeof fetch;

    await assert.rejects(
      safeFetchBuffer(
        "https://unsubscribe.test/start",
        { method: "POST", body: "fixed" },
        { allowedProtocols: ["https:"], maxRedirects: 0 },
      ),
      /redirects are not allowed/,
    );
    assert.equal(calls, 1, String(status));
  }
});
