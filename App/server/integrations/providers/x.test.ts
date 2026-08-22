import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { xProvider } from "./x.js";
import type { IntegrationRuntimeContext } from "../types.js";

/**
 * X used to offer a browser-driven auth mode beside its API, and the gap
 * between the two produced the bug this file was written for: an employee
 * saw the full OAuth tool list on a browser-login Connection, concluded it
 * had a "direct integration", and promised there would be no login page.
 *
 * The mode is now retired — a site password belongs in the Vault, where the
 * built-in Browser can use it under a Grant — but the Connections it created
 * are still in the database. So what these tests guard has moved: a leftover
 * `authMode: "browser"` row must advertise nothing, run nothing, and say
 * why, rather than fall back onto an API it has no token for.
 */

function ctxFor(authMode: IntegrationRuntimeContext["authMode"]): IntegrationRuntimeContext {
  return {
    authMode,
    config: { username: "oneuptimehq", password: "hunter2" },
    setConfig() {
      /* not used by the paths under test */
    },
  };
}

describe("supportsTool", () => {
  test("OAuth connections get the full list", () => {
    for (const tool of xProvider.tools) {
      assert.equal(xProvider.supportsTool!(tool.name, "oauth2"), true, tool.name);
    }
  });

  /**
   * `buildIntegrationToolListing` drops every tool a Connection cannot run,
   * so answering `false` here is what makes a retired row list nothing at
   * all. Seventeen tools that each fail on the first call would be worse
   * than none: the model plans around what it is shown.
   */
  test("a Connection left behind by browser login advertises nothing", () => {
    for (const tool of xProvider.tools) {
      assert.equal(xProvider.supportsTool!(tool.name, "browser"), false, tool.name);
    }
  });
});

describe("catalog", () => {
  test("offers OAuth and nothing else", () => {
    // Browser login is gone from the type itself, so its absence here is a
    // compile-time fact rather than something a runtime assertion can add to.
    assert.equal(xProvider.catalog.authMode, "oauth2");
    assert.ok(xProvider.catalog.oauth);
  });

  test("the connect copy does not still sell a browser login", () => {
    const copy = `${xProvider.catalog.tagline} ${xProvider.catalog.description ?? ""}`;
    assert.doesNotMatch(copy, /browser/i);
    assert.doesNotMatch(copy, /password/i);
  });

  /** No mode-specific caveat is left to append to a tool description. */
  test("no per-auth-mode caveat survives", () => {
    assert.equal(xProvider.describeAuthMode, undefined);
  });
});

describe("a Connection left behind by browser login", () => {
  test("checkStatus names the retirement instead of claiming Connected", async () => {
    const result = await xProvider.checkStatus!(ctxFor("browser"));
    assert.equal(result.ok, false);
    assert.equal(result.status, "error");
    assert.match(result.message!, /retired/i);
    assert.match(result.message!, /OAuth/);
    assert.match(result.message!, /Vault/);
  });

  test("invoking a tool on one refuses before any network call", async () => {
    const err = await xProvider
      .invokeTool("post_tweet", { text: "Shipping today." }, ctxFor("browser"))
      .then(
        () => null,
        (e: unknown) => e,
      );
    assert.ok(err instanceof Error);
    assert.match(err.message, /does not support authMode "browser"/);
  });
});

describe("follow_user", () => {
  test("the schema accepts either a userId or a handle", () => {
    for (const name of ["follow_user", "unfollow_user"]) {
      const tool = xProvider.tools.find((t) => t.name === name)!;
      assert.ok(tool.inputSchema.properties.handle, `${name} must accept a handle`);
      assert.ok(tool.inputSchema.properties.userId, `${name} must accept a userId`);
      // Neither is individually required: callers routinely hold only the
      // @name, and `resolveTargetUserId` looks the numeric id up for them.
      assert.equal(tool.inputSchema.required, undefined);
    }
  });
});
