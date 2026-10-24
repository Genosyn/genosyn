import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { describeOauthApp } from "./oauthAppSummary.js";

describe("describeOauthApp", () => {
  test("says whether the installation registered its own app", () => {
    assert.equal(describeOauthApp({ configured: true }), "Registered");
    assert.equal(describeOauthApp({ configured: false }), "Not registered");
  });

  test("names an unsaved edit on a closed row", () => {
    assert.equal(describeOauthApp({ configured: false }, true), "Not registered · unsaved changes");
    assert.equal(describeOauthApp({ configured: true }, true), "Registered · unsaved changes");
    assert.equal(describeOauthApp({ configured: true }, false), "Registered");
  });
});
