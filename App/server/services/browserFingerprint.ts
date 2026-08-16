/**
 * Does our browser contradict itself?
 *
 * Sites rarely block "automation" as such — they block browsers whose claims
 * disagree with each other. A user agent saying macOS while `navigator.platform`
 * says Linux, a Chrome that enumerates no Chrome fonts, a GPU string reading
 * SwiftShader under a claim of Apple hardware: each pair is a cheap, reliable
 * bot signal, and each was true of Genosyn's old headless-Chromium-in-a-costume
 * profile.
 *
 * The fix (real Chrome, headed, nothing spoofed — see `browserProfile.ts`)
 * removes those contradictions, but nothing keeps them removed. A Chrome
 * release, an image rebuild that silently falls back to Chromium, a well-meant
 * "let's pin the timezone" — any of them can reintroduce a mismatch, and the
 * only way we would find out today is a Routine failing at 3am against a login
 * page.
 *
 * So this module states the invariants as code:
 *
 *   * {@link FINGERPRINT_PROBE} runs in the page and reports what the browser
 *     actually says about itself.
 *   * {@link analyseFingerprint} is a pure function from that report to a list
 *     of contradictions, so the interesting half is unit-testable without
 *     launching anything.
 *   * {@link runBrowserSelfTest} wires the two together against the real
 *     profile, for `systemHealth` and for a human debugging a block.
 *
 * It reports; it does not fix. A finding here is a bug in the profile, and the
 * profile is where it gets fixed.
 */

import {
  browserIdentity,
  chromeContextOptions,
  chromeMaskInitScript,
  chromiumLaunchOptions,
  loadChromiumLauncher,
} from "./browserProfile.js";

/** What the page tells us about itself. Every field is best-effort. */
export type FingerprintReport = {
  userAgent: string;
  /** `navigator.platform`. */
  platform: string;
  /** `navigator.webdriver`, as a string so `undefined` survives the trip. */
  webdriver: string;
  /** Brand names from `navigator.userAgentData.brands`. */
  brands: string[];
  /** `navigator.userAgentData.platform`. */
  uaDataPlatform: string;
  languages: string[];
  /** `WEBGL_debug_renderer_info`'s UNMASKED_RENDERER_WEBGL, when readable. */
  webglRenderer: string;
  /** How many of a probe list of common desktop fonts are installed. */
  fontsMatched: number;
  fontsProbed: number;
  /** `navigator.plugins.length`. */
  pluginCount: number;
  /** True when `navigator.plugins` is a real `PluginArray`. */
  pluginsAreNative: boolean;
  /** `navigator.mimeTypes.length`. */
  mimeTypeCount: number;
  /** `Notification.permission`. */
  notificationPermission: string;
  /** `navigator.permissions.query({name:'notifications'})`'s state. */
  notificationQueryState: string;
  /** True when every function we may have patched still reads as native. */
  patchesLookNative: boolean;
  /** `Intl.DateTimeFormat().resolvedOptions().timeZone`. */
  timezone: string;
  screen: { width: number; height: number };
  hardwareConcurrency: number;
};

export type FingerprintFinding = {
  /** Stable key, so a caller can suppress one without string-matching. */
  id: string;
  /**
   * `blocking` means this pairing does not occur in a real browser and will
   * be read as automation. `advisory` is a weaker smell worth knowing about.
   */
  severity: "blocking" | "advisory";
  /** What disagrees with what, in one sentence. */
  detail: string;
};

/**
 * Runs in the page. Written as a self-contained expression string because it
 * crosses into the browser through `page.evaluate`, where it has no access to
 * anything in this module.
 */
export const FINGERPRINT_PROBE = `(() => {
  const out = {
    userAgent: '', platform: '', webdriver: 'missing', brands: [], uaDataPlatform: '',
    languages: [], webglRenderer: '', fontsMatched: 0, fontsProbed: 0, pluginCount: 0,
    pluginsAreNative: false, mimeTypeCount: 0, notificationPermission: '',
    notificationQueryState: '', patchesLookNative: true, timezone: '',
    screen: { width: 0, height: 0 }, hardwareConcurrency: 0,
  };
  try { out.userAgent = navigator.userAgent || ''; } catch {}
  try { out.platform = navigator.platform || ''; } catch {}
  try { out.webdriver = String(navigator.webdriver); } catch {}
  try { out.languages = Array.from(navigator.languages || []); } catch {}
  try { out.hardwareConcurrency = navigator.hardwareConcurrency || 0; } catch {}
  try { out.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch {}
  try { out.screen = { width: screen.width || 0, height: screen.height || 0 }; } catch {}
  try {
    const uaData = navigator.userAgentData;
    if (uaData) {
      out.brands = (uaData.brands || []).map((b) => b.brand);
      out.uaDataPlatform = uaData.platform || '';
    }
  } catch {}
  try {
    out.pluginCount = navigator.plugins ? navigator.plugins.length : 0;
    out.mimeTypeCount = navigator.mimeTypes ? navigator.mimeTypes.length : 0;
    out.pluginsAreNative =
      typeof PluginArray !== 'undefined' && navigator.plugins instanceof PluginArray;
  } catch {}
  try {
    out.notificationPermission =
      typeof Notification !== 'undefined' ? Notification.permission : '';
  } catch {}
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (gl) {
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      if (info) out.webglRenderer = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) || '');
    }
  } catch {}
  try {
    // Font detection by width comparison against the generic fallbacks. A
    // desktop browser matches most of these; a bare container matches none.
    const probes = [
      'Arial', 'Verdana', 'Times New Roman', 'Courier New', 'Georgia',
      'Trebuchet MS', 'Tahoma', 'Helvetica', 'DejaVu Sans', 'Liberation Sans',
    ];
    out.fontsProbed = probes.length;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const sample = 'mmmmmmmmmmlli';
    const baselines = {};
    for (const generic of ['monospace', 'sans-serif', 'serif']) {
      ctx.font = '72px ' + generic;
      baselines[generic] = ctx.measureText(sample).width;
    }
    for (const font of probes) {
      let matched = false;
      for (const generic of ['monospace', 'sans-serif', 'serif']) {
        ctx.font = '72px "' + font + '", ' + generic;
        if (ctx.measureText(sample).width !== baselines[generic]) matched = true;
      }
      if (matched) out.fontsMatched += 1;
    }
  } catch {}
  try {
    // Anything the compatibility mask installed must still print as native
    // code. This is the probe a detector runs, so it is the probe we run.
    const suspects = [
      Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver'),
      Object.getOwnPropertyDescriptor(Navigator.prototype, 'plugins'),
      Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgentData'),
      Object.getOwnPropertyDescriptor(Navigator.prototype, 'languages'),
    ];
    for (const descriptor of suspects) {
      if (descriptor && descriptor.get && !/\\[native code\\]/.test(descriptor.get.toString())) {
        out.patchesLookNative = false;
      }
    }
    if (navigator.permissions && navigator.permissions.query
        && !/\\[native code\\]/.test(navigator.permissions.query.toString())) {
      out.patchesLookNative = false;
    }
    if (!/\\[native code\\]/.test(Function.prototype.toString.toString())) {
      out.patchesLookNative = false;
    }
  } catch {}
  return out;
})()`;

/** Which OS a user agent claims, by the frozen token Chrome sends. */
function claimedPlatform(userAgent: string): "linux" | "macos" | "windows" | "unknown" {
  if (/Macintosh|Mac OS X/.test(userAgent)) return "macos";
  if (/Windows NT/.test(userAgent)) return "windows";
  if (/X11|Linux/.test(userAgent)) return "linux";
  return "unknown";
}

/** Which OS `navigator.platform` reports. */
function actualPlatform(platform: string): "linux" | "macos" | "windows" | "unknown" {
  if (/^Mac/i.test(platform)) return "macos";
  if (/^Win/i.test(platform)) return "windows";
  if (/Linux|X11/i.test(platform)) return "linux";
  return "unknown";
}

/**
 * Turn a report into findings. Pure, so the rules are testable against
 * hand-written reports — including the exact profile this codebase used to
 * ship, which is the regression worth guarding.
 */
export function analyseFingerprint(report: FingerprintReport): FingerprintFinding[] {
  const findings: FingerprintFinding[] = [];
  const claimed = claimedPlatform(report.userAgent);
  const actual = actualPlatform(report.platform);

  if (claimed !== "unknown" && actual !== "unknown" && claimed !== actual) {
    findings.push({
      id: "platform-mismatch",
      severity: "blocking",
      detail: `User agent claims ${claimed} but navigator.platform reports ${actual} ("${report.platform}").`,
    });
  }

  if (report.uaDataPlatform) {
    const hinted = actualPlatform(
      report.uaDataPlatform === "macOS" ? "MacIntel" : report.uaDataPlatform,
    );
    if (claimed !== "unknown" && hinted !== "unknown" && hinted !== claimed) {
      findings.push({
        id: "client-hint-mismatch",
        severity: "blocking",
        detail: `User agent claims ${claimed} but userAgentData.platform reports "${report.uaDataPlatform}".`,
      });
    }
  }

  if (/HeadlessChrome/i.test(report.userAgent)) {
    findings.push({
      id: "headless-user-agent",
      severity: "blocking",
      detail: "User agent contains HeadlessChrome, which announces automation outright.",
    });
  }

  if (report.webdriver === "true") {
    findings.push({
      id: "webdriver-true",
      severity: "blocking",
      detail: "navigator.webdriver is true — the canonical automation flag.",
    });
  } else if (report.webdriver !== "false") {
    // Real Chrome always exposes the property and always answers false when it
    // is not being driven. `undefined` is the shape the old mask produced, and
    // it belongs to no shipping browser.
    findings.push({
      id: "webdriver-not-boolean",
      severity: "blocking",
      detail: `navigator.webdriver is ${report.webdriver}; every real Chrome reports false.`,
    });
  }

  if (!report.patchesLookNative) {
    findings.push({
      id: "patched-function-source",
      severity: "blocking",
      detail:
        "A patched function's toString() does not read as [native code], which identifies the profile as instrumented.",
    });
  }

  if (report.brands.length > 0 && !report.brands.some((b) => /Google Chrome/i.test(b))) {
    findings.push({
      id: "missing-chrome-brand",
      severity: "blocking",
      detail:
        'userAgentData.brands has no "Google Chrome" entry while the user agent claims Chrome.',
    });
  }

  if (report.notificationPermission === "denied" && report.notificationQueryState === "prompt") {
    findings.push({
      id: "notification-pairing",
      severity: "blocking",
      detail:
        "Notification.permission is denied while permissions.query answers prompt — a pairing no real browser produces.",
    });
  }

  if (report.pluginCount > 0 && !report.pluginsAreNative) {
    findings.push({
      id: "plugins-not-native",
      severity: "blocking",
      detail: "navigator.plugins is populated but is not a PluginArray.",
    });
  }

  if (report.pluginCount > 0 && report.mimeTypeCount === 0) {
    findings.push({
      id: "mimetypes-contradict-plugins",
      severity: "blocking",
      detail: `navigator.plugins reports ${report.pluginCount} entries but navigator.mimeTypes is empty.`,
    });
  }

  if (/SwiftShader|llvmpipe|Mesa OffScreen/i.test(report.webglRenderer)) {
    findings.push({
      id: "software-webgl",
      severity: claimed === "linux" ? "advisory" : "blocking",
      detail: `WebGL renderer is "${report.webglRenderer}", a software rasteriser${
        claimed !== "linux" ? ` under a ${claimed} claim` : ""
      }.`,
    });
  }

  // Half the probe list is the threshold: a desktop with real font packages
  // clears it comfortably, a container with one bitmap family does not.
  if (report.fontsProbed > 0 && report.fontsMatched * 2 < report.fontsProbed) {
    findings.push({
      id: "font-desert",
      severity: "blocking",
      detail: `Only ${report.fontsMatched} of ${report.fontsProbed} common desktop fonts are installed; font enumeration will not look like a desktop.`,
    });
  }

  if (report.languages.length === 0) {
    findings.push({
      id: "no-languages",
      severity: "advisory",
      detail: "navigator.languages is empty, which no interactive browser reports.",
    });
  }

  if (report.hardwareConcurrency === 0) {
    findings.push({
      id: "no-hardware-concurrency",
      severity: "advisory",
      detail: "navigator.hardwareConcurrency is 0.",
    });
  }

  if (report.screen.width < 1024 || report.screen.height < 768) {
    findings.push({
      id: "implausible-screen",
      severity: "advisory",
      detail: `screen is ${report.screen.width}x${report.screen.height}, smaller than any common desktop.`,
    });
  }

  return findings;
}

export type BrowserSelfTest = {
  /** What we launched. */
  browser: string;
  /** True when the binary is real Google Chrome. */
  isRealChrome: boolean;
  headed: boolean;
  report: FingerprintReport;
  findings: FingerprintFinding[];
  /** True when nothing blocking was found. */
  ok: boolean;
};

/**
 * Launch the real profile, probe it, and report. Costs a browser start, so
 * this is a diagnostic a human or a health check asks for — never something on
 * a request path.
 */
export async function runBrowserSelfTest(): Promise<BrowserSelfTest> {
  const identity = await browserIdentity();
  const chromium = await loadChromiumLauncher(
    "The browser self-test needs playwright-core and a Chrome or Chromium binary.",
  );
  const browser = (await chromium.launch(await chromiumLaunchOptions())) as {
    newContext: (opts: unknown) => Promise<unknown>;
    close: () => Promise<void>;
  };
  try {
    const context = (await browser.newContext(await chromeContextOptions())) as {
      addInitScript?: (script: { content: string }) => Promise<void>;
      newPage: () => Promise<unknown>;
    };
    const maskScript = await chromeMaskInitScript();
    if (maskScript) await context.addInitScript?.({ content: maskScript });
    const page = (await context.newPage()) as {
      goto: (url: string, opts?: unknown) => Promise<unknown>;
      evaluate: (script: string) => Promise<unknown>;
    };
    // A real origin, not about:blank: permissions, WebGL and fonts all behave
    // differently on an opaque origin, so probing one would measure nothing.
    await page.goto("data:text/html,<html><body>genosyn-selftest</body></html>");
    const report = (await page.evaluate(FINGERPRINT_PROBE)) as FingerprintReport;
    report.notificationQueryState = await queryNotificationState(page);
    const findings = analyseFingerprint(report);
    return {
      browser: identity.versionString || "unknown",
      isRealChrome: identity.isRealChrome,
      headed: identity.headed,
      report,
      findings,
      ok: !findings.some((f) => f.severity === "blocking"),
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Separate round trip because it is async in the page and the main probe is
 * deliberately synchronous — one `await` inside that probe would swallow every
 * other field if the promise never settled.
 */
async function queryNotificationState(page: {
  evaluate: (script: string) => Promise<unknown>;
}): Promise<string> {
  try {
    const state = await page.evaluate(
      `navigator.permissions.query({ name: 'notifications' }).then((r) => r.state).catch(() => '')`,
    );
    return typeof state === "string" ? state : "";
  } catch {
    return "";
  }
}
