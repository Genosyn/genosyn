import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  AUTHORIZATION_PAGE_ERRORS,
  appHost,
  authorizationPageError,
  consentGrants,
  consentLoginPath,
  consentPath,
  consentRequestFromLoginSearch,
  consentRequestFromSearch,
  safeAppRedirect,
} from "./appConsent";

const SEALED = "v2.bWNwLW9hdXRo.aXY.dGFn.Y2lwaGVy-text_1";

describe("the request a consent URL carries", () => {
  test("survives sign-in as a request, never as a URL", () => {
    const login = new URL(consentLoginPath(SEALED), "https://genosyn.example.test");
    assert.equal(login.pathname, "/login");
    const carried = consentRequestFromLoginSearch(login.search);
    assert.equal(carried, SEALED);
    const back = new URL(consentPath(carried!), "https://genosyn.example.test");
    assert.equal(back.pathname, "/oauth/consent");
    assert.equal(consentRequestFromSearch(back.search), SEALED);
  });

  test("anything else in its place is ignored", () => {
    for (const value of [
      "https://attacker.example.test/",
      "/c/acme",
      "javascript:alert(1)",
      "x".repeat(8001),
      "",
    ]) {
      const search = `?oauth=${encodeURIComponent(value)}&request=${encodeURIComponent(value)}`;
      assert.equal(consentRequestFromLoginSearch(search), null, value.slice(0, 30));
      assert.equal(consentRequestFromSearch(search), null, value.slice(0, 30));
    }
    assert.equal(consentRequestFromLoginSearch("?invitation=abc"), null);
  });
});

describe("leaving for the app", () => {
  test("only ever to an http(s) address", () => {
    assert.equal(
      safeAppRedirect("https://claude.ai/api/mcp/auth_callback?code=c&state=s"),
      "https://claude.ai/api/mcp/auth_callback?code=c&state=s",
    );
    assert.equal(
      safeAppRedirect("http://localhost:3334/callback?code=c"),
      "http://localhost:3334/callback?code=c",
    );
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,hi",
      "cursor://x/y",
      "/relative",
      42,
      null,
    ]) {
      assert.equal(safeAppRedirect(bad), null, String(bad));
    }
  });

  test("names the app by the host it returns to", () => {
    assert.equal(appHost("https://chatgpt.com"), "chatgpt.com");
    assert.equal(appHost("http://localhost:8976"), "localhost:8976");
  });
});

describe("what the page says", () => {
  test("every error the authorization endpoint sends has words, and an unknown one falls back", () => {
    for (const code of [
      "missing_client",
      "unknown_client",
      "missing_redirect_uri",
      "unregistered_redirect_uri",
      "invalid_request",
    ]) {
      assert.ok(AUTHORIZATION_PAGE_ERRORS[code].message.length > 20, code);
    }
    assert.deepEqual(authorizationPageError("made_up"), AUTHORIZATION_PAGE_ERRORS.invalid_request);
    assert.deepEqual(authorizationPageError(null), AUTHORIZATION_PAGE_ERRORS.invalid_request);
  });

  test("what approving grants, with the Member's own role and Finance access", () => {
    const [grant, limits, lasts] = consentGrants(
      { name: "Sunwise", role: "admin", financeAccess: "full" },
      "Claude",
    );
    assert.match(
      grant,
      /^Claude can use Genosyn as you in Sunwise — as an admin, with full Finance access/,
    );
    assert.match(limits, /API keys, the Vault, Member roles or Approvals/);
    assert.match(lasts, /Settings → API keys, or after 30 days without use/);
    assert.match(
      consentGrants({ name: "Sunwise", role: "owner", financeAccess: "full" }, "ChatGPT")[0],
      /as the owner/,
    );
  });
});
