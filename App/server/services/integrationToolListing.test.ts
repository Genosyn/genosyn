import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildIntegrationToolListing,
  integrationToolDescription,
  toolNameSegment,
  type ListableConnection,
} from "./integrationToolListing.js";
import { getProvider, listProviderIds } from "../integrations/index.js";

/**
 * This is the surface an AI employee actually plans against. Everything it
 * believes about what a Connection can do comes from here, so the rules it
 * encodes — hide what the auth mode can't run, say which mode it is — are
 * worth pinning down.
 */

function conn(partial: Partial<ListableConnection> & { provider: string }): ListableConnection {
  return {
    id: `conn-${partial.provider}`,
    label: partial.label ?? "Main",
    authMode: partial.authMode ?? "oauth2",
    ...partial,
  };
}

describe("toolNameSegment", () => {
  test("slugs a label into something tool-name safe", () => {
    assert.equal(toolNameSegment("Stripe US"), "stripe_us");
    assert.equal(toolNameSegment("  Marketing — X  "), "marketing_x");
    assert.equal(toolNameSegment("2024/Q1"), "2024_q1");
  });

  test("falls back rather than producing an empty segment", () => {
    assert.equal(toolNameSegment(""), "conn");
    assert.equal(toolNameSegment("!!!"), "conn");
  });
});

describe("integrationToolDescription", () => {
  test("prefixes with the provider and connection so the model can tell them apart", () => {
    assert.equal(
      integrationToolDescription("Stripe", "Stripe EU", "List customers."),
      "[Stripe · Stripe EU] List customers.",
    );
  });
});

describe("buildIntegrationToolListing", () => {
  test("a single connection gets unprefixed tool names", () => {
    const tools = buildIntegrationToolListing([conn({ provider: "x", authMode: "oauth2" })]);
    assert.ok(tools.some((t) => t.name === "x_post_tweet"));
    assert.ok(tools.some((t) => t.name === "x_search_recent"));
    for (const tool of tools) {
      assert.equal(tool.connectionId, "conn-x");
      assert.ok(tool.name.startsWith("x_"));
    }
  });

  test("two connections for one provider are disambiguated by label", () => {
    const tools = buildIntegrationToolListing([
      conn({ provider: "x", id: "a", label: "Brand account" }),
      conn({ provider: "x", id: "b", label: "Support" }),
    ]);
    assert.ok(tools.some((t) => t.name === "x_brand_account_post_tweet"));
    assert.ok(tools.some((t) => t.name === "x_support_post_tweet"));
    assert.equal(
      tools.filter((t) => t.providerToolName === "post_tweet").length,
      2,
      "each connection needs its own post_tweet",
    );
  });

  test("an unknown provider is skipped rather than crashing the listing", () => {
    const tools = buildIntegrationToolListing([
      conn({ provider: "not-a-real-provider" }),
      conn({ provider: "x" }),
    ]);
    assert.ok(tools.length > 0);
    assert.ok(tools.every((t) => t.name.startsWith("x_")));
  });

  test("no connections means no tools", () => {
    assert.deepEqual(buildIntegrationToolListing([]), []);
  });

  /**
   * The regression this whole change exists for: a browser-login X
   * connection used to advertise `x_search_recent` and `x_send_dm`, which
   * the driver could not do at all. An employee that sees them concludes it
   * has API access.
   *
   * Browser login is retired now, but the Connections it created outlived
   * it, so the rule has more work to do rather than less: a row whose mode
   * has no implementation left must advertise nothing whatsoever.
   */
  describe("auth-mode honesty", () => {
    test("a Connection left behind by browser login lists no tools at all", () => {
      const tools = buildIntegrationToolListing([conn({ provider: "x", authMode: "browser" })]);
      assert.deepEqual(tools, []);
    });

    test("the same integration over OAuth still gets everything", () => {
      const oauth = buildIntegrationToolListing([conn({ provider: "x", authMode: "oauth2" })]);
      assert.equal(oauth.length, getProvider("x")!.tools.length);
      assert.ok(oauth.some((t) => t.providerToolName === "send_dm"));
    });

    test("a description is the tool's own, prefixed — no caveat where none applies", () => {
      const tools = buildIntegrationToolListing([
        conn({ provider: "x", authMode: "oauth2", label: "Brand" }),
      ]);
      assert.ok(tools.length > 0);
      for (const tool of tools) {
        const inner = getProvider("x")!.tools.find((t) => t.name === tool.providerToolName)!;
        assert.equal(tool.description, `[X (Twitter) · Brand] ${inner.description}`);
      }
    });

    test("a retired connection alongside a live one does not cost the live one its tools", () => {
      const tools = buildIntegrationToolListing([
        conn({ provider: "x", id: "api", label: "API", authMode: "oauth2" }),
        conn({ provider: "x", id: "web", label: "Web", authMode: "browser" }),
      ]);
      // Two connections for one provider, so names stay disambiguated even
      // though only one of them contributes anything.
      assert.ok(tools.some((t) => t.name === "x_api_post_tweet"));
      assert.ok(tools.some((t) => t.name === "x_api_send_dm"));
      assert.ok(!tools.some((t) => t.name.startsWith("x_web_")));
      assert.ok(tools.every((t) => t.connectionId === "api"));
    });

    test("providers with no supportsTool hook are unaffected", () => {
      // Most providers have exactly one auth mode and no reason to filter.
      const unfiltered = listProviderIds().filter((id) => !getProvider(id)!.supportsTool);
      assert.ok(unfiltered.length > 5, "expected most providers to opt out of filtering");
      const sample = unfiltered.find((id) => getProvider(id)!.tools.length > 0)!;
      const tools = buildIntegrationToolListing([conn({ provider: sample, authMode: "apikey" })]);
      assert.equal(tools.length, getProvider(sample)!.tools.length);
    });
  });

  test("schemas are passed through untouched", () => {
    const tools = buildIntegrationToolListing([conn({ provider: "x", authMode: "oauth2" })]);
    const post = tools.find((t) => t.providerToolName === "post_tweet")!;
    assert.equal(post.inputSchema, getProvider("x")!.tools.find((t) => t.name === "post_tweet")!.inputSchema);
  });
});
