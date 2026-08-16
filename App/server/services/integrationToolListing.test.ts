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
   * the driver cannot do at all. An employee that sees them concludes it
   * has API access.
   */
  describe("auth-mode honesty", () => {
    test("a browser-login connection hides the tools it cannot run", () => {
      const tools = buildIntegrationToolListing([conn({ provider: "x", authMode: "browser" })]);
      const names = tools.map((t) => t.providerToolName).sort();
      assert.deepEqual(names, [
        "delete_tweet",
        "follow_user",
        "get_me",
        "like_tweet",
        "post_tweet",
        "retweet",
        "unfollow_user",
        "unlike_tweet",
      ]);
      for (const hidden of ["search_recent", "send_dm", "get_home_timeline", "unretweet"]) {
        assert.ok(
          !tools.some((t) => t.providerToolName === hidden),
          `${hidden} must not be advertised on a browser connection`,
        );
      }
    });

    test("the same integration over OAuth still gets everything", () => {
      const browser = buildIntegrationToolListing([
        conn({ provider: "x", authMode: "browser" }),
      ]);
      const oauth = buildIntegrationToolListing([conn({ provider: "x", authMode: "oauth2" })]);
      assert.ok(oauth.length > browser.length);
      assert.ok(oauth.some((t) => t.providerToolName === "send_dm"));
    });

    test("every browser-connection tool description carries the mode caveat", () => {
      const tools = buildIntegrationToolListing([
        conn({ provider: "x", authMode: "browser", label: "Brand" }),
      ]);
      assert.ok(tools.length > 0);
      for (const tool of tools) {
        assert.match(tool.description, /^\[X \(Twitter\) · Brand\]/);
        assert.match(tool.description, /not the X API/);
        assert.match(tool.description, /never promise this path avoids a login page/);
      }
    });

    test("OAuth descriptions stay clean — no caveat where none applies", () => {
      const tools = buildIntegrationToolListing([conn({ provider: "x", authMode: "oauth2" })]);
      for (const tool of tools) {
        assert.doesNotMatch(tool.description, /not the X API/);
      }
    });

    test("mixed-mode connections for one provider are described independently", () => {
      const tools = buildIntegrationToolListing([
        conn({ provider: "x", id: "api", label: "API", authMode: "oauth2" }),
        conn({ provider: "x", id: "web", label: "Web", authMode: "browser" }),
      ]);
      const apiPost = tools.find((t) => t.name === "x_api_post_tweet")!;
      const webPost = tools.find((t) => t.name === "x_web_post_tweet")!;
      assert.doesNotMatch(apiPost.description, /not the X API/);
      assert.match(webPost.description, /not the X API/);
      // The API-only tools exist for the OAuth connection only.
      assert.ok(tools.some((t) => t.name === "x_api_send_dm"));
      assert.ok(!tools.some((t) => t.name === "x_web_send_dm"));
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
    const tools = buildIntegrationToolListing([conn({ provider: "x", authMode: "browser" })]);
    const post = tools.find((t) => t.providerToolName === "post_tweet")!;
    assert.equal(post.inputSchema, getProvider("x")!.tools.find((t) => t.name === "post_tweet")!.inputSchema);
  });
});
