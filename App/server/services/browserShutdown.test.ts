import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { releaseAllPages } from "./browserChromium.js";

/**
 * The shutdown flush is the only thing standing between `docker stop` and an
 * employee losing a sign-in they made two minutes earlier: browser storage is
 * written on teardown, and before this existed no teardown ran on a signal.
 *
 * The empty case is the one that runs on almost every real shutdown — most
 * containers stop with no browser open — so it is the one that must never
 * throw. A rejection here would turn every clean stop into a crash on the way
 * out, which is worse than the bug it replaced.
 */

describe("releaseAllPages", () => {
  test("resolves to zero when no browser session is live", async () => {
    assert.equal(await releaseAllPages("shutdown"), 0);
  });

  test("defaults to the shutdown reason", async () => {
    assert.equal(await releaseAllPages(), 0);
  });

  test("is safe to call twice, as a doubled signal would", async () => {
    await releaseAllPages("shutdown");
    assert.equal(await releaseAllPages("shutdown"), 0);
  });
});
