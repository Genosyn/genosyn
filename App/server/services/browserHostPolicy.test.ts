import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  hostMatches,
  normalizeViewerNavigationUrl,
  parseAllowList,
  urlAllowed,
} from "./browserHostPolicy.js";

/**
 * These rules used to live inside `routes/browserRpc.ts`, reachable only by the
 * model's `browser_open`. They now also gate the live viewer's address bar, so
 * a human who has taken control cannot walk the employee's browser past the
 * company's host policy. Both callers depend on exactly these answers.
 */

describe("parseAllowList", () => {
  test("drops blanks and comments, trims the rest", () => {
    assert.deepEqual(parseAllowList("  mail.google.com \n\n# a note\n*.example.com\n"), [
      "mail.google.com",
      "*.example.com",
    ]);
  });

  test("an unset list is empty, which means unrestricted", () => {
    assert.deepEqual(parseAllowList(null), []);
    assert.equal(urlAllowed("https://anywhere.test/", parseAllowList(null)).ok, true);
  });
});

describe("hostMatches", () => {
  test("a bare host is exact", () => {
    assert.equal(hostMatches("mail.google.com", "mail.google.com"), true);
    assert.equal(hostMatches("evil.mail.google.com", "mail.google.com"), false);
  });

  test("`*.` covers the apex and every subdomain, and nothing that merely ends the same", () => {
    assert.equal(hostMatches("example.com", "*.example.com"), true);
    assert.equal(hostMatches("a.b.example.com", "*.example.com"), true);
    assert.equal(hostMatches("notexample.com", "*.example.com"), false);
    assert.equal(hostMatches("example.com.attacker.test", "*.example.com"), false);
  });

  test("a general glob never spans a dot", () => {
    assert.equal(hostMatches("app.eu.example.com", "app.*.example.com"), true);
    assert.equal(hostMatches("app.eu.west.example.com", "app.*.example.com"), false);
    assert.equal(hostMatches("example.attacker.com", "example.*"), false);
  });
});

describe("urlAllowed", () => {
  test("names the host and the list when it refuses", () => {
    const verdict = urlAllowed("https://elsewhere.test/x", ["*.example.com"]);
    assert.equal(verdict.ok, false);
    assert.match(verdict.ok === false ? verdict.reason : "", /elsewhere\.test/);
    assert.match(verdict.ok === false ? verdict.reason : "", /\*\.example\.com/);
  });

  test("an unparseable URL fails closed", () => {
    assert.equal(urlAllowed("not a url", ["example.com"]).ok, false);
  });
});

describe("normalizeViewerNavigationUrl", () => {
  test("assumes https for a bare host, the way an address bar does", () => {
    const verdict = normalizeViewerNavigationUrl("  example.com/pricing  ");
    assert.equal(verdict.ok, true);
    assert.equal(verdict.ok && verdict.url, "https://example.com/pricing");
  });

  test("keeps an explicit http scheme", () => {
    const verdict = normalizeViewerNavigationUrl("http://localhost.example.com:3000/a?b=c");
    assert.equal(verdict.ok, true);
    assert.equal(verdict.ok && verdict.url, "http://localhost.example.com:3000/a?b=c");
  });

  test("refuses schemes that reach past every check that follows", () => {
    for (const raw of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,<h1>x</h1>",
      "about:blank",
      "chrome://settings",
      "view-source:https://example.com",
    ]) {
      assert.equal(normalizeViewerNavigationUrl(raw).ok, false, raw);
    }
  });

  test("is an address bar, not a search box", () => {
    // A bare word is a typo far more often than an intent to search, and
    // guessing would hand the employee's signed-in browser to a search engine.
    assert.equal(normalizeViewerNavigationUrl("how do i reset my password").ok, false);
    assert.equal(normalizeViewerNavigationUrl("localhost").ok, false);
    assert.equal(normalizeViewerNavigationUrl("").ok, false);
  });

  test("refuses a URL longer than the model's own open budget", () => {
    assert.equal(normalizeViewerNavigationUrl(`https://example.com/${"a".repeat(2100)}`).ok, false);
  });
});
