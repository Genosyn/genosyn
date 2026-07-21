import assert from "node:assert/strict";
import test from "node:test";
import { isTrustedBrowserOrigin } from "./httpSecurity.js";

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
