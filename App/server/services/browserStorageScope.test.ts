import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  asStorageState,
  filterStorageState,
  mergeStorageState,
  type StorageState,
} from "./browserStorage.js";

/**
 * Clipping an employee's cookie jar to one site is what makes it safe to
 * move a session in or out of it: unscoped, a read carries the employee's
 * Gmail session along with the site that was asked for, and a write
 * replaces the whole jar with the one site that produced it, signing them
 * out of everything else. The scoping rules are subtle enough (domain
 * suffixes, leading dots, case) to be worth pinning down on their own.
 */

const X_DOMAINS = ["x.com", "twitter.com"];

function cookie(name: string, domain: string): Record<string, string> {
  return { name, domain, path: "/", value: `${name}-value` };
}

function state(
  cookies: Array<Record<string, string>>,
  origins: string[] = [],
): StorageState {
  return {
    cookies,
    origins: origins.map((origin) => ({
      origin,
      localStorage: [{ name: "k", value: "v" }],
    })),
  };
}

describe("filterStorageState", () => {
  test("keeps the named site and drops everything else", () => {
    const jar = state(
      [
        cookie("auth_token", ".x.com"),
        cookie("ct0", "x.com"),
        cookie("legacy", ".twitter.com"),
        cookie("SID", ".google.com"),
        cookie("notion_session", "www.notion.so"),
      ],
      ["https://x.com", "https://mail.google.com", "https://www.notion.so"],
    );

    const scoped = filterStorageState(jar, X_DOMAINS);

    assert.deepEqual(
      scoped.cookies.map((c) => (c as { name: string }).name).sort(),
      ["auth_token", "ct0", "legacy"],
    );
    assert.deepEqual(
      scoped.origins.map((o) => o.origin),
      ["https://x.com"],
    );
  });

  test("subdomains belong to the site; lookalike domains do not", () => {
    const jar = state(
      [
        cookie("sub", "api.x.com"),
        cookie("deep", ".mobile.api.x.com"),
        cookie("impostor", "evil-x.com"),
        cookie("suffix-trick", "notx.com"),
        cookie("prefix-trick", "x.com.attacker.net"),
      ],
      ["https://api.x.com", "https://evil-x.com", "https://x.com.attacker.net"],
    );

    const scoped = filterStorageState(jar, X_DOMAINS);

    assert.deepEqual(
      scoped.cookies.map((c) => (c as { name: string }).name).sort(),
      ["deep", "sub"],
    );
    assert.deepEqual(
      scoped.origins.map((o) => o.origin),
      ["https://api.x.com"],
    );
  });

  test("case differences do not smuggle a domain through", () => {
    const scoped = filterStorageState(state([cookie("a", ".X.CoM")]), X_DOMAINS);
    assert.equal(scoped.cookies.length, 1);
  });

  test("malformed cookies and origins are dropped, not thrown on", () => {
    const jar: StorageState = {
      cookies: [null, "nope", 7, {}, { domain: 42 }, cookie("ok", "x.com")],
      origins: [
        { origin: "not a url", localStorage: [] },
        { origin: "https://x.com", localStorage: [] },
      ],
    };
    const scoped = filterStorageState(jar, X_DOMAINS);
    assert.equal(scoped.cookies.length, 1);
    assert.equal(scoped.origins.length, 1);
  });

  test("an empty domain list keeps nothing", () => {
    assert.deepEqual(filterStorageState(state([cookie("a", "x.com")]), []), {
      cookies: [],
      origins: [],
    });
  });
});

describe("mergeStorageState", () => {
  /** The regression that matters: writing back must not sign the employee
   *  out of every other site. */
  test("replaces the named site and leaves the rest of the jar alone", () => {
    const jar = state(
      [
        cookie("auth_token", ".x.com"),
        cookie("SID", ".google.com"),
        cookie("notion_session", "www.notion.so"),
      ],
      ["https://x.com", "https://mail.google.com"],
    );
    const incoming = state([cookie("auth_token", ".x.com")], ["https://x.com"]);
    // Simulate a rotated X token.
    (incoming.cookies[0] as Record<string, string>).value = "rotated";

    const merged = mergeStorageState(jar, incoming, X_DOMAINS);

    const byName = new Map(
      merged.cookies.map((c) => [(c as { name: string }).name, c as Record<string, string>]),
    );
    assert.equal(byName.get("auth_token")!.value, "rotated");
    assert.ok(byName.has("SID"), "the employee's Google session must survive");
    assert.ok(byName.has("notion_session"), "the employee's Notion session must survive");
    assert.equal(merged.origins.length, 2);
  });

  test("a sign-out on the named site removes its cookies rather than resurrecting them", () => {
    const jar = state([cookie("auth_token", ".x.com"), cookie("SID", ".google.com")]);
    const merged = mergeStorageState(jar, state([]), X_DOMAINS);
    assert.deepEqual(
      merged.cookies.map((c) => (c as { name: string }).name),
      ["SID"],
    );
  });

  test("incoming cookies for other sites are ignored — a provider owns only its own", () => {
    const jar = state([cookie("SID", ".google.com")]);
    const merged = mergeStorageState(
      jar,
      state([cookie("auth_token", "x.com"), cookie("stolen", ".google.com")]),
      X_DOMAINS,
    );
    const names = merged.cookies.map((c) => (c as { name: string }).name).sort();
    assert.deepEqual(names, ["SID", "auth_token"]);
    const sid = merged.cookies.find((c) => (c as { name: string }).name === "SID") as Record<
      string,
      string
    >;
    assert.equal(sid.value, "SID-value", "the existing Google cookie must not be overwritten");
  });

  test("no existing jar yields just the scoped incoming state", () => {
    const merged = mergeStorageState(
      undefined,
      state([cookie("auth_token", "x.com"), cookie("SID", ".google.com")]),
      X_DOMAINS,
    );
    assert.deepEqual(
      merged.cookies.map((c) => (c as { name: string }).name),
      ["auth_token"],
    );
  });
});

describe("asStorageState", () => {
  test("accepts a real state and rejects anything else", () => {
    assert.ok(asStorageState({ cookies: [], origins: [] }));
    for (const junk of [null, undefined, "x", 5, [], {}, { cookies: [] }, { origins: [] }]) {
      assert.equal(asStorageState(junk), undefined);
    }
  });
});
