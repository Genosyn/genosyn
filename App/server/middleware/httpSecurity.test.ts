import assert from "node:assert/strict";
import test from "node:test";
import { contentSecurityPolicy, isTrustedBrowserOrigin, securityHeaders } from "./httpSecurity.js";
import type { Request, Response } from "express";

test("keeps initiated OAuth popups connected for origin verification", () => {
  const headers = new Map<string, string>();
  securityHeaders(
    { secure: false, path: "/", originalUrl: "/" } as Request,
    { setHeader: (name: string, value: string) => headers.set(name, value) } as unknown as Response,
    () => {},
  );
  assert.equal(headers.get("Cross-Origin-Opener-Policy"), "same-origin-allow-popups");
});

test("accepts same-host browser mutations independently of stored settings", () => {
  assert.equal(
    isTrustedBrowserOrigin({
      method: "POST",
      origin: "https://genosyn.example.com",
      fetchSite: "same-origin",
      host: "genosyn.example.com",
    }),
    true,
  );
});

test("rejects cross-site and mismatched-host browser mutations", () => {
  assert.equal(
    isTrustedBrowserOrigin({
      method: "POST",
      origin: "https://attacker.example",
      fetchSite: "cross-site",
      host: "genosyn.example.com",
    }),
    false,
  );
  assert.equal(
    isTrustedBrowserOrigin({
      method: "POST",
      origin: "https://attacker.example",
      fetchSite: "same-origin",
      host: "genosyn.example.com",
    }),
    false,
  );
});

test("keeps safe methods and bearer API requests compatible", () => {
  assert.equal(isTrustedBrowserOrigin({ method: "GET", fetchSite: "cross-site" }), true);
  assert.equal(
    isTrustedBrowserOrigin({
      method: "POST",
      authorization: "Bearer gen_example",
      fetchSite: "cross-site",
    }),
    true,
  );
});

test("keeps third-party scripts blocked when custom JavaScript is disabled", () => {
  const policy = contentSecurityPolicy();
  assert.match(policy, /script-src 'self';/);
  assert.match(policy, /frame-src 'self'$/);
  assert.doesNotMatch(policy.match(/script-src [^;]+/)?.[0] ?? "", /https:|unsafe/);
});

test("allows HTTPS vendor bundles without allowing inline or evaluated scripts", () => {
  const policy = contentSecurityPolicy(true);
  const scriptDirective = policy.match(/script-src [^;]+/)?.[0] ?? "";
  assert.equal(scriptDirective, "script-src 'self' https:");
  assert.doesNotMatch(scriptDirective, /unsafe-inline|unsafe-eval/);
  assert.match(policy, /frame-src 'self' https:$/);
});
