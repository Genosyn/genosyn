import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  analyseFingerprint,
  FINGERPRINT_PROBE,
  type FingerprintReport,
} from "./browserFingerprint.js";

/**
 * The regression these tests exist for is the profile this repo used to ship:
 * an Alpine Chromium, headless, claiming to be Chrome 134 on macOS. Every
 * assertion below is a probe a real bot detector runs, and the "old profile"
 * case is the exact fingerprint that got AI Employees blocked.
 */

/** A real, headed Google Chrome on Debian — the shipped configuration. */
function healthy(overrides: Partial<FingerprintReport> = {}): FingerprintReport {
  return {
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    platform: "Linux x86_64",
    webdriver: "false",
    brands: ["Chromium", "Google Chrome", "Not;A=Brand"],
    uaDataPlatform: "Linux",
    languages: ["en-US", "en"],
    webglRenderer: "ANGLE (Intel, Mesa Intel(R) UHD Graphics, OpenGL 4.6)",
    fontsMatched: 8,
    fontsProbed: 10,
    pluginCount: 5,
    pluginsAreNative: true,
    mimeTypeCount: 2,
    notificationPermission: "default",
    notificationQueryState: "prompt",
    patchesLookNative: true,
    timezone: "UTC",
    screen: { width: 1920, height: 1080 },
    hardwareConcurrency: 8,
    ...overrides,
  };
}

/** What the pre-Debian profile actually looked like from a page's point of view. */
function oldGenosynProfile(): FingerprintReport {
  return {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.6998.166 Safari/537.36",
    // Never patched — the costume claimed macOS, this still said Linux.
    platform: "Linux x86_64",
    // Forced to undefined, which no shipping browser reports.
    webdriver: "undefined",
    brands: ["Chromium", "Google Chrome", "Not.A/Brand"],
    uaDataPlatform: "macOS",
    languages: ["en-US", "en"],
    // A container has no GPU.
    webglRenderer: "Google SwiftShader",
    // ttf-freefont only.
    fontsMatched: 1,
    fontsProbed: 10,
    // Plain object literals, not a PluginArray; mimeTypes left empty.
    pluginCount: 5,
    pluginsAreNative: false,
    mimeTypeCount: 0,
    // The patch that created the mismatch it was written to hide.
    notificationPermission: "denied",
    notificationQueryState: "prompt",
    // Arrow functions all the way down.
    patchesLookNative: false,
    timezone: "America/Los_Angeles",
    screen: { width: 1280, height: 800 },
    hardwareConcurrency: 4,
  };
}

function ids(report: FingerprintReport): string[] {
  return analyseFingerprint(report).map((f) => f.id);
}

describe("analyseFingerprint", () => {
  test("a real headed Chrome has nothing blocking", () => {
    const findings = analyseFingerprint(healthy());
    assert.deepEqual(
      findings.filter((f) => f.severity === "blocking"),
      [],
    );
  });

  test("catches every contradiction in the profile this replaced", () => {
    const found = ids(oldGenosynProfile());
    for (const expected of [
      "platform-mismatch",
      "webdriver-not-boolean",
      "patched-function-source",
      "notification-pairing",
      "plugins-not-native",
      "mimetypes-contradict-plugins",
      "software-webgl",
      "font-desert",
    ]) {
      assert.ok(found.includes(expected), `expected finding ${expected}, got ${found.join(", ")}`);
    }
  });

  test("a macOS claim on a Linux browser is blocking", () => {
    const found = ids(
      healthy({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      }),
    );
    assert.ok(found.includes("platform-mismatch"));
  });

  test("a HeadlessChrome user agent is blocking", () => {
    const found = ids(healthy({ userAgent: healthy().userAgent.replace("Chrome/", "HeadlessChrome/") }));
    assert.ok(found.includes("headless-user-agent"));
  });

  test("navigator.webdriver true is blocking", () => {
    assert.ok(ids(healthy({ webdriver: "true" })).includes("webdriver-true"));
  });

  test("navigator.webdriver undefined is blocking too", () => {
    // Real Chrome always exposes the property and answers false; the old mask
    // removed a weak signal and left a stronger one.
    assert.ok(ids(healthy({ webdriver: "undefined" })).includes("webdriver-not-boolean"));
  });

  test("a patch that prints its own source is blocking", () => {
    assert.ok(ids(healthy({ patchesLookNative: false })).includes("patched-function-source"));
  });

  test("client hints disagreeing with the user agent are blocking", () => {
    // The old profile got this pair right — it patched `userAgentData.platform`
    // to match its macOS claim — and got caught on `navigator.platform`
    // instead. Both pairings need a rule; neither is covered by the other.
    const found = ids(healthy({ uaDataPlatform: "Windows" }));
    assert.ok(found.includes("client-hint-mismatch"));
  });

  test("client hints with no Google Chrome brand are blocking", () => {
    const found = ids(healthy({ brands: ["Chromium", "Not;A=Brand"] }));
    assert.ok(found.includes("missing-chrome-brand"));
  });

  test("plugins and mimeTypes must agree", () => {
    assert.ok(ids(healthy({ mimeTypeCount: 0 })).includes("mimetypes-contradict-plugins"));
    assert.ok(ids(healthy({ pluginsAreNative: false })).includes("plugins-not-native"));
  });

  test("a font desert is blocking", () => {
    assert.ok(ids(healthy({ fontsMatched: 1 })).includes("font-desert"));
    assert.ok(!ids(healthy({ fontsMatched: 8 })).includes("font-desert"));
  });

  test("software WebGL is advisory on Linux but blocking under a macOS claim", () => {
    const onLinux = analyseFingerprint(healthy({ webglRenderer: "SwiftShader" })).find(
      (f) => f.id === "software-webgl",
    );
    // A headless Linux server legitimately has no GPU; it is only damning when
    // the profile has also claimed hardware it cannot have.
    assert.equal(onLinux?.severity, "advisory");

    const onMac = analyseFingerprint(
      healthy({
        webglRenderer: "SwiftShader",
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
        platform: "MacIntel",
        uaDataPlatform: "macOS",
      }),
    ).find((f) => f.id === "software-webgl");
    assert.equal(onMac?.severity, "blocking");
  });

  test("empty languages and a tiny screen are advisory, not blocking", () => {
    const findings = analyseFingerprint(
      healthy({ languages: [], screen: { width: 800, height: 600 } }),
    );
    const byId = new Map(findings.map((f) => [f.id, f.severity]));
    assert.equal(byId.get("no-languages"), "advisory");
    assert.equal(byId.get("implausible-screen"), "advisory");
  });

  test("an unrecognisable user agent does not invent a mismatch", () => {
    const found = ids(healthy({ userAgent: "something/1.0", platform: "" }));
    assert.ok(!found.includes("platform-mismatch"));
  });
});

describe("FINGERPRINT_PROBE", () => {
  test("is a single self-contained expression", () => {
    // It crosses into the page through `evaluate`, where it can reference
    // nothing from this module.
    assert.match(FINGERPRINT_PROBE.trim(), /^\(\(\) => \{/);
    assert.match(FINGERPRINT_PROBE.trim(), /\}\)\(\)$/);
  });

  test("stays synchronous so one hung promise cannot swallow the report", () => {
    assert.doesNotMatch(FINGERPRINT_PROBE, /\bawait\b/);
  });

  test("probes the getters a detector would probe", () => {
    for (const probe of ["webdriver", "userAgentData", "plugins", "languages"]) {
      assert.ok(FINGERPRINT_PROBE.includes(probe), `probe is missing ${probe}`);
    }
  });
});
