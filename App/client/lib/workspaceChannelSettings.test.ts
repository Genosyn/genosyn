import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { channelWebhookSummary } from "./workspace";

/**
 * A channel's incoming webhook sits under its settings' Advanced disclosure;
 * the closed line must always say whether it is on.
 */
describe("channelWebhookSummary", () => {
  test("says whether the incoming webhook is on", () => {
    assert.equal(channelWebhookSummary({ enabled: true }, false, null), "Incoming webhook on");
    assert.equal(channelWebhookSummary({ enabled: false }, false, null), "Incoming webhook off");
  });

  test("a loaded state wins over a stale flag or error", () => {
    assert.equal(channelWebhookSummary({ enabled: true }, true, "boom"), "Incoming webhook on");
  });

  test("says when it is still checking, or could not find out", () => {
    assert.equal(channelWebhookSummary(null, true, null), "Incoming webhook · checking…");
    assert.equal(
      channelWebhookSummary(null, false, "Could not load webhook settings"),
      "Incoming webhook couldn’t load",
    );
  });

  test("still names what is inside before anything has loaded", () => {
    assert.equal(channelWebhookSummary(null, false, null), "Incoming webhook");
  });
});
