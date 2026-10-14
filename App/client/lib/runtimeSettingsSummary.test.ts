import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  customizedPaths,
  describeCustomized,
  readPath,
  RUNTIME_DEFAULTS,
  sameValue,
} from "./runtimeSettingsSummary";

const webPaths = [
  "enabled",
  "searchProvider",
  "searxngUrl",
  "maxSearchResults",
  "maxDocumentBytes",
  "maxTextChars",
];

describe("describeCustomized", () => {
  test("says Defaults, or how many fields were changed", () => {
    assert.equal(describeCustomized(0), "Defaults");
    assert.equal(describeCustomized(1), "1 customized");
    assert.equal(describeCustomized(3), "3 customized");
  });
});

describe("customizedPaths", () => {
  test("finds nothing in a group still on its shipped values", () => {
    for (const group of Object.keys(RUNTIME_DEFAULTS) as Array<keyof typeof RUNTIME_DEFAULTS>) {
      const paths = Object.keys(RUNTIME_DEFAULTS[group]);
      assert.ok(paths.length > 0);
      assert.deepEqual(customizedPaths(group, structuredClone(RUNTIME_DEFAULTS[group]), paths), []);
    }
    assert.deepEqual(customizedPaths("web", { ...RUNTIME_DEFAULTS.web }, webPaths), []);
  });

  test("names each changed field, in the order asked for", () => {
    const value = { ...RUNTIME_DEFAULTS.web, maxSearchResults: 20, enabled: false };
    assert.deepEqual(customizedPaths("web", value, webPaths), ["enabled", "maxSearchResults"]);
  });

  test("reads a nested field by its dotted path", () => {
    const paths = [
      "maxConcurrentTurnsPerCompany",
      "toolDiscovery.enabled",
      "toolDiscovery.minCatalogueSize",
    ];
    const value = {
      ...RUNTIME_DEFAULTS.agent,
      toolDiscovery: { enabled: true, minCatalogueSize: 10 },
    };
    assert.deepEqual(customizedPaths("agent", value, paths), ["toolDiscovery.minCatalogueSize"]);
  });

  test("compares lists by what they hold", () => {
    assert.deepEqual(
      customizedPaths("network", { privateHostAllowlist: [] }, ["privateHostAllowlist"]),
      [],
    );
    assert.deepEqual(
      customizedPaths("network", { privateHostAllowlist: ["git.internal"] }, [
        "privateHostAllowlist",
      ]),
      ["privateHostAllowlist"],
    );
  });

  test("treats a choice that is not a string like any other value", () => {
    const paths = ["headless"];
    assert.deepEqual(
      customizedPaths("browser", { ...RUNTIME_DEFAULTS.browser, headless: true }, paths),
      ["headless"],
    );
    assert.deepEqual(
      customizedPaths("browser", { ...RUNTIME_DEFAULTS.browser, headless: "auto" }, paths),
      [],
    );
  });

  test("only looks at the paths it is given", () => {
    const value = { ...RUNTIME_DEFAULTS.oauth, hostedSignInUrl: "https://connect.example.com" };
    assert.deepEqual(customizedPaths("oauth", value, ["hostedSignInEnabled"]), []);
    assert.deepEqual(customizedPaths("oauth", value, ["hostedSignInUrl"]), ["hostedSignInUrl"]);
  });
});

describe("readPath and sameValue", () => {
  test("readPath walks dotted paths and tolerates a missing branch", () => {
    assert.equal(readPath({ a: { b: 2 } }, "a.b"), 2);
    assert.equal(readPath({ a: 1 }, "a.b"), undefined);
    assert.equal(readPath(null, "a"), undefined);
  });

  test("sameValue is structural", () => {
    assert.equal(sameValue([1, 2], [1, 2]), true);
    assert.equal(sameValue([1, 2], [1]), false);
    assert.equal(sameValue({ a: { b: 1 } }, { a: { b: 1 } }), true);
    assert.equal(sameValue({ a: { b: 1 } }, { a: { b: 2 } }), false);
    assert.equal(sameValue("a", "b"), false);
    assert.equal(sameValue(null, undefined), false);
  });
});
