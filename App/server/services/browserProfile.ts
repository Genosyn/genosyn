/**
 * The shared browser profile: which binary we launch, how we launch it, and
 * what — if anything — we have to pretend about.
 *
 * Three different parts of the App drive this browser:
 *
 *   * `browserChromium.ts` — the App-owned browser behind an employee's
 *     `browser_*` tools, which humans can watch live and take over.
 *   * the browser-login Integration drivers (`providers/x-browser.ts`),
 *     which replay a stored username/password against a site that has no
 *     usable API.
 *   * `browserFingerprint.ts`, which loads the profile and checks it for
 *     self-contradictions.
 *
 * All of them talk to the same hostile login pages, so the profile lives in
 * one place and a bump for one caller is a bump for all.
 *
 * ## Why this file shrank
 *
 * It used to be a costume shop. The image could only ship Alpine's `chromium`
 * (Playwright's build is glibc, Alpine is musl), so the profile claimed to be
 * Chrome 134 on macOS and patched a dozen `navigator` internals to back the
 * claim up. That is the wrong shape of solution, and it did not work: sites do
 * not detect automation so much as they detect *contradictions*, and every
 * layer the costume did not reach — fonts, WebGL renderer,
 * `navigator.platform`, codec support, the shape of the patched getters
 * themselves — contradicted the layers it did. A browser insisting it is
 * macOS Chrome while enumerating zero macOS fonts is more suspicious than one
 * that never claimed anything.
 *
 * The image is now Debian and ships **real Google Chrome**, headed, on a
 * virtual display. So the answer to "how do we look like Chrome" is: be
 * Chrome. `chromeMaskInitScript()` returns an empty string on that path and
 * `chromeContextOptions()` overrides nothing — Chrome's own user agent,
 * client hints, fonts and GPU strings all agree with each other for free,
 * because they are all true.
 *
 * What remains is a **compatibility fallback** for a source-managed install on
 * a host with no Chrome, where the best available binary is a bare Chromium.
 * That path still needs camouflage, so the mask is still here — rewritten so
 * that it does not leak the fact that it is a mask (see
 * `chromeMaskInitScript`).
 *
 * This is camouflage, not evasion of a decision: we never solve a captcha or
 * defeat a challenge. When a site does challenge us, the browser-login drivers
 * stop and hand the page to a human (see `browserConnectionHealth.ts`).
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import { config } from "../../config.js";

const execFileAsync = promisify(execFile);

/** The window Chrome opens. The virtual display behind it is larger. */
export const BROWSER_WINDOW_WIDTH = 1280;
export const BROWSER_WINDOW_HEIGHT = 800;

/**
 * Fallback major version, used only when the binary would not tell us its own.
 * The detected version is always preferred — this exists so a browser that
 * refuses `--version` still claims something plausible rather than something
 * years old. A stale version claim is itself a signal, which is how the
 * previous hardcoded `134` ended up being part of the problem, so bump this
 * when it drifts far from current stable.
 */
const FALLBACK_CHROME_MAJOR = 151;

/** Where Chrome usually lives, per platform, in preference order. */
const CHROME_CANDIDATES: Record<string, readonly string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  linux: [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/opt/google/chrome/chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
};

/**
 * Chrome freezes the platform token in its user agent — every Linux build
 * says `X11; Linux x86_64`, including arm64 — so these are the only three
 * strings a real Chrome ever sends.
 */
const UA_PLATFORM_TOKEN: Record<BrowserPlatform, string> = {
  linux: "X11; Linux x86_64",
  macos: "Macintosh; Intel Mac OS X 10_15_7",
  windows: "Windows NT 10.0; Win64; x64",
};

/** The matching `Sec-CH-UA-Platform` value for each of the above. */
const CH_PLATFORM: Record<BrowserPlatform, string> = {
  linux: "Linux",
  macos: "macOS",
  windows: "Windows",
};

export type BrowserPlatform = "linux" | "macos" | "windows";

export type BrowserIdentity = {
  /** Absolute path we hand Playwright, or undefined to use its own download. */
  executablePath: string | undefined;
  /** True when the binary introduced itself as Google Chrome. */
  isRealChrome: boolean;
  /** Major version, detected where possible. */
  major: number;
  /** Raw `--version` output, kept for diagnostics and the self-test. */
  versionString: string;
  /** The OS this browser actually runs on. */
  platform: BrowserPlatform;
  /** True when we will launch with a window rather than headless. */
  headed: boolean;
};

function currentPlatform(): BrowserPlatform {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}

/**
 * Where to find a browser. `config.browser.executablePath` wins, then the env
 * vars (the Docker image sets `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to real
 * Chrome), then the usual install locations, then nothing — which leaves
 * Playwright to use the Chromium it downloaded.
 */
export function resolveBrowserExecutable(): string | undefined {
  const configured =
    config.browser.executablePath ||
    process.env.GENOSYN_CHROME_PATH ||
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
    "";
  if (configured) return configured;

  for (const candidate of CHROME_CANDIDATES[process.platform] ?? CHROME_CANDIDATES.linux) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Headed or headless. Headless is the loudest automation signal a browser
 * emits — real people do not browse without a window — so "auto" runs headed
 * whenever there is a display to run on. The container's entrypoint starts
 * Xvfb and exports `DISPLAY`, so the shipped deployment is always headed; a
 * developer's laptop has no `DISPLAY` and stays headless, which is what you
 * want when a test suite would otherwise open windows at you.
 */
export function resolveHeaded(): boolean {
  const configured = config.browser.headless;
  if (configured === true) return false;
  if (configured === false) return true;
  return Boolean(process.env.DISPLAY);
}

const VERSION_PATTERN = /(Google Chrome|Chromium|Chrome)\s+([0-9]+)(?:\.[0-9]+)*/i;

let identityPromise: Promise<BrowserIdentity> | null = null;
let identityForTests: BrowserIdentity | null = null;

/**
 * Swap in a known identity for tests, so a suite can exercise both the
 * real-Chrome path and the compatibility path on a machine that only has one
 * of them. Pass `null` to restore detection.
 */
export function injectBrowserIdentityForTests(identity: BrowserIdentity | null): void {
  identityForTests = identity;
  identityPromise = null;
}

/**
 * Parse `--version` output. Split out from {@link browserIdentity} so the
 * interesting half — "is this Chrome or is it Chromium" — is testable without
 * a browser on the box.
 */
export function parseBrowserVersion(versionString: string): {
  isRealChrome: boolean;
  major: number;
} {
  const match = VERSION_PATTERN.exec(versionString);
  if (!match) return { isRealChrome: false, major: FALLBACK_CHROME_MAJOR };
  // "Chromium 120.0.6099.109" is not Chrome; "Google Chrome 141.0.7390.54" is.
  // A bare "Chrome" prefix appears on some repackaged builds — treat it as
  // Chromium, because assuming less is the safe direction here: the cost of a
  // needless mask is small, the cost of a missing one is a block.
  const isRealChrome = /google chrome/i.test(match[1]);
  const major = Number.parseInt(match[2], 10);
  return {
    isRealChrome,
    major: Number.isFinite(major) && major > 0 ? major : FALLBACK_CHROME_MAJOR,
  };
}

/**
 * Ask the binary what it is, once per process. Everything downstream keys off
 * this: a real Chrome gets no disguise at all, anything else gets the
 * compatibility mask.
 *
 * Detection failure is not fatal — we fall back to "assume Chromium", which
 * only means we apply a mask that a real Chrome would not have needed.
 */
export async function browserIdentity(): Promise<BrowserIdentity> {
  if (identityForTests) return identityForTests;
  if (!identityPromise) {
    identityPromise = (async (): Promise<BrowserIdentity> => {
      const executablePath = resolveBrowserExecutable();
      const platform = currentPlatform();
      const headed = resolveHeaded();
      if (!executablePath) {
        // Playwright's own Chromium download. Definitely not Chrome.
        return {
          executablePath: undefined,
          isRealChrome: false,
          major: FALLBACK_CHROME_MAJOR,
          versionString: "",
          platform,
          headed,
        };
      }
      let versionString = "";
      try {
        const { stdout } = await execFileAsync(executablePath, ["--version"], {
          timeout: 10_000,
        });
        versionString = stdout.trim();
      } catch {
        // Missing binary, or one that refuses to introduce itself. The launch
        // path will produce the real, actionable error a moment later.
        versionString = "";
      }
      const { isRealChrome, major } = parseBrowserVersion(versionString);
      return { executablePath, isRealChrome, major, versionString, platform, headed };
    })();
  }
  return identityPromise;
}

/** The bits of Playwright the launch paths actually need. */
export type ChromiumLauncher = {
  launch(options: Record<string, unknown>): Promise<unknown>;
  /**
   * Attach to a Chrome we did not start. Optional so an injected test double
   * only has to implement the half it exercises — the member-browser path is
   * the only caller.
   */
  connectOverCDP?(endpointURL: string, options?: Record<string, unknown>): Promise<unknown>;
  /**
   * Launch against a real on-disk Chrome profile, returning a *context* rather
   * than a Browser. This is how an employee's browser gets a history: cache,
   * IndexedDB, service workers and TLS resumption state all live in
   * `userDataDir` and outlive the process.
   *
   * Optional for the same reason as `connectOverCDP` — and because a Playwright
   * build without it must still work, falling back to the ephemeral path.
   */
  launchPersistentContext?(
    userDataDir: string,
    options: Record<string, unknown>,
  ): Promise<unknown>;
};

let chromiumLauncherForTests: ChromiumLauncher | null = null;

/**
 * Swap in a fake Chromium for tests. The browser-login drivers have real
 * decision logic worth covering — which cookie jar to reach for, when to
 * refuse a retry — and none of it should need a 150 MB browser to exercise.
 * Pass `null` to restore the real loader.
 */
export function injectChromiumLauncherForTests(launcher: ChromiumLauncher | null): void {
  chromiumLauncherForTests = launcher;
}

let playwrightModule: { chromium: ChromiumLauncher } | null = null;

/**
 * Lazy-load `playwright-core` so modules that merely import this stay cheap
 * for stock installs that never launch a browser. `context` names the
 * feature that needed it, so the error tells the operator which capability
 * their image is missing.
 */
export async function loadChromiumLauncher(context: string): Promise<ChromiumLauncher> {
  if (chromiumLauncherForTests) return chromiumLauncherForTests;
  if (!playwrightModule) {
    try {
      const mod = await import("playwright-core");
      playwrightModule = { chromium: mod.chromium as unknown as ChromiumLauncher };
    } catch (err) {
      throw new Error(
        `playwright-core is not installed: ${
          err instanceof Error ? err.message : String(err)
        }. ${context}`,
      );
    }
  }
  return playwrightModule.chromium;
}

/**
 * `chromium.launch()` options.
 *
 * `--no-sandbox` is required because the container does not grant the browser
 * the user namespaces Chrome's own sandbox needs; it is not web-visible.
 * `--disable-blink-features=AutomationControlled` and the `--enable-automation`
 * removal below are: between them they drop the "controlled by automated
 * software" infobar and the `navigator.webdriver = true` it comes with.
 */
export async function chromiumLaunchOptions(): Promise<Record<string, unknown>> {
  const identity = await browserIdentity();
  const args = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    `--window-size=${BROWSER_WINDOW_WIDTH},${BROWSER_WINDOW_HEIGHT}`,
  ];
  return {
    headless: !identity.headed,
    executablePath: identity.executablePath,
    args,
    // Playwright's default argument list is close to a stock browser, with one
    // exception worth removing. Listing an argument Playwright may not pass is
    // harmless.
    ignoreDefaultArgs: ["--enable-automation"],
  };
}

/**
 * The fingerprint half of `browser.newContext()`. Callers merge in their own
 * security-boundary options (request routing, `serviceWorkers`) and the
 * `storageState` they want restored — those differ per caller and are not
 * part of the profile.
 *
 * On real Chrome this returns almost nothing, and that is the point. Chrome's
 * own user agent and client hints are consistent with its fonts, its GPU
 * strings and its `navigator.platform` because they describe the same real
 * browser; overriding any one of them is how you create the mismatch that
 * gets you blocked.
 */
export async function chromeContextOptions(): Promise<Record<string, unknown>> {
  const identity = await browserIdentity();
  const options: Record<string, unknown> = {};

  // Headed Chrome gets the window it was given; overriding the viewport makes
  // the page disagree with the window it is painted in, which desyncs
  // screenshots. Headless has no window, so it needs an explicit size.
  options.viewport = identity.headed
    ? null
    : { width: BROWSER_WINDOW_WIDTH, height: BROWSER_WINDOW_HEIGHT };

  // Empty means "inherit whatever Chrome derives from the container". A
  // hardcoded locale or timezone that disagrees with where this deployment
  // egresses from is read the same way a spoofed user agent is.
  if (config.browser.locale) options.locale = config.browser.locale;
  if (config.browser.timezone) options.timezoneId = config.browser.timezone;

  const spoofedUserAgent = spoofedUserAgentFor(identity);
  if (spoofedUserAgent) {
    options.userAgent = spoofedUserAgent;
    options.extraHTTPHeaders = {
      "sec-ch-ua": secChUaFor(identity),
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": `"${CH_PLATFORM[identity.platform]}"`,
    };
  }
  return options;
}
/**
 * Options for `launchPersistentContext`, which takes launch flags and context
 * options in one object.
 *
 * The two halves are the same ones the ephemeral path uses, with one deliberate
 * omission: **no `storageState`**. A persistent context restores its own
 * cookies from the profile on disk, and passing a snapshot as well would let a
 * stale JSON file overwrite a jar the browser had already loaded. Seeding the
 * profile from that snapshot happens exactly once, on first launch, and is the
 * caller's job — see `hydrateProfileFromSnapshot` in `browserChromium.ts`.
 */
export async function persistentContextOptions(): Promise<Record<string, unknown>> {
  const launch = await chromiumLaunchOptions();
  const context = await chromeContextOptions();
  return {
    ...launch,
    ...context,
    // Kept from the ephemeral path deliberately. A service worker can serve a
    // response without a network request Playwright can see, which would route
    // around the request marker `browserRequestBoundary` relies on. Removing
    // this is worth doing — Playwright's block is itself a loud automation
    // tell — but it has to land with a CDP-level replacement, not as a
    // side-effect of moving to a persistent profile.
    serviceWorkers: "block",
  };
}


/**
 * The user agent to claim, or `null` to send the browser's own.
 *
 * Two cases need one. A bare Chromium says "Chromium" where a real Chrome says
 * "Chrome". And headless Chrome — the fallback when no display is available —
 * puts `HeadlessChrome` in its user agent, which is a plain announcement that
 * nobody is watching. Both are rewritten to the same shape a real headed
 * Chrome sends, including the frozen `MAJOR.0.0.0` version: Chrome's user
 * agent reduction stopped sending real build numbers years ago, so a user
 * agent carrying one is itself an anomaly.
 */
export function spoofedUserAgentFor(identity: BrowserIdentity): string | null {
  if (identity.isRealChrome && identity.headed) return null;
  return (
    `Mozilla/5.0 (${UA_PLATFORM_TOKEN[identity.platform]}) AppleWebKit/537.36 ` +
    `(KHTML, like Gecko) Chrome/${identity.major}.0.0.0 Safari/537.36`
  );
}

/** The `Sec-CH-UA` header matching {@link spoofedUserAgentFor}. */
export function secChUaFor(identity: BrowserIdentity): string {
  return `"Chromium";v="${identity.major}", "Google Chrome";v="${identity.major}", "Not;A=Brand";v="24"`;
}

/**
 * Page-init script that finishes the masquerade for the compatibility path.
 * Returns **an empty string on real headed Chrome**, which is the shipped
 * configuration — there is nothing there to fake.
 *
 * Where it does run, the rule it follows is that a patch must not be
 * detectable as a patch. The previous version failed that rule in four ways,
 * each of which is a documented bot-detection probe:
 *
 *   * Every override was an arrow function, so
 *     `Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver')
 *     .get.toString()` returned `() => undefined` instead of `[native code]`.
 *     Fixed by routing `Function.prototype.toString` through a proxy that
 *     answers with a native-looking source for the functions we installed —
 *     including itself.
 *   * `navigator.webdriver` was forced to `undefined`. Real Chrome returns
 *     `false`; no browser returns `undefined`, so the patch was a stronger
 *     signal than the thing it hid. Now `false`.
 *   * `navigator.plugins` was an array of object literals, failing
 *     `instanceof PluginArray` and missing `item`/`namedItem`, while
 *     `navigator.mimeTypes` stayed empty and contradicted it. Both are now
 *     built on the real prototypes and agree with each other.
 *   * `permissions.query('notifications')` was made to answer `prompt` while
 *     `Notification.permission` still read `denied` — a pairing that occurs in
 *     no real browser, where the honest headless pairing at least occurs in a
 *     headless one. Both are now `default`/`prompt`, as in real Chrome.
 */
export async function chromeMaskInitScript(): Promise<string> {
  const identity = await browserIdentity();
  if (identity.isRealChrome && identity.headed) return "";

  const brandsJson = JSON.stringify([
    { brand: "Chromium", version: String(identity.major) },
    { brand: "Google Chrome", version: String(identity.major) },
    { brand: "Not;A=Brand", version: "24" },
  ]);
  const platformJson = JSON.stringify(CH_PLATFORM[identity.platform]);
  const uaPlatformJson = JSON.stringify(UA_PLATFORM_TOKEN[identity.platform]);
  const fullVersionJson = JSON.stringify(`${identity.major}.0.0.0`);
  // A real Chrome only needs the parts of this that its build actually lacks.
  const needsBrandFixes = !identity.isRealChrome;

  return `
    (() => {
      // ---- native-looking patches -------------------------------------
      // Anything we install is registered here with the source text a real
      // implementation would have printed. Without this every patch below
      // announces itself to a one-line probe.
      const nativeSource = new WeakMap();
      const realToString = Function.prototype.toString;
      const patchedToString = new Proxy(realToString, {
        apply(target, thisArg, args) {
          const spoofed = nativeSource.get(thisArg);
          if (spoofed !== undefined) return spoofed;
          return Reflect.apply(target, thisArg, args);
        },
      });
      nativeSource.set(patchedToString, 'function toString() { [native code] }');
      try {
        Function.prototype.toString = patchedToString;
      } catch {}

      const native = (fn, name) => {
        nativeSource.set(fn, 'function ' + name + '() { [native code] }');
        return fn;
      };
      /** Define an accessor whose getter reads as native. */
      const defineGetter = (target, name, get) => {
        try {
          Object.defineProperty(target, name, {
            configurable: true,
            enumerable: true,
            get: native(get, 'get ' + name),
          });
        } catch {}
      };

      // ---- navigator.webdriver ----------------------------------------
      // Real Chrome exposes this and returns false. Returning undefined, as
      // this used to, is a state no shipping browser is ever in.
      defineGetter(Navigator.prototype, 'webdriver', () => false);

      // ---- navigator.platform ------------------------------------------
      // The one that made the old macOS costume pointless: the user agent
      // claimed a Mac while this still read "Linux x86_64". Keep it agreeing
      // with whatever the user agent says.
      defineGetter(Navigator.prototype, 'platform', () => ${uaPlatformJson}.includes('Mac')
        ? 'MacIntel'
        : (${uaPlatformJson}.includes('Windows') ? 'Win32' : 'Linux x86_64'));

      // ---- navigator.languages -----------------------------------------
      // Headless sometimes returns an empty array; match the Accept-Language
      // the context sends.
      defineGetter(Navigator.prototype, 'languages', () => Object.freeze(['en-US', 'en']));
${
  needsBrandFixes
    ? `
      // ---- navigator.userAgentData -------------------------------------
      // Client-Hints brands. Bare Chromium omits the "Google Chrome" entry
      // that the spoofed user agent and the Sec-CH-UA header both claim.
      try {
        const brands = Object.freeze(${brandsJson}.map(Object.freeze));
        const fullVersionList = Object.freeze(
          brands.map((b) => Object.freeze({ brand: b.brand, version: ${fullVersionJson} })),
        );
        const uaData = Object.create(
          (typeof NavigatorUAData !== 'undefined' && NavigatorUAData.prototype) || Object.prototype,
        );
        defineGetter(uaData, 'brands', () => brands);
        defineGetter(uaData, 'mobile', () => false);
        defineGetter(uaData, 'platform', () => ${platformJson});
        Object.defineProperty(uaData, 'getHighEntropyValues', {
          configurable: true,
          writable: true,
          value: native((hints) => Promise.resolve(Object.assign(
            { brands, mobile: false, platform: ${platformJson} },
            (hints || []).includes('architecture') ? { architecture: 'x86' } : {},
            (hints || []).includes('bitness') ? { bitness: '64' } : {},
            (hints || []).includes('model') ? { model: '' } : {},
            (hints || []).includes('platformVersion') ? { platformVersion: '' } : {},
            (hints || []).includes('uaFullVersion') ? { uaFullVersion: ${fullVersionJson} } : {},
            (hints || []).includes('fullVersionList') ? { fullVersionList } : {},
            (hints || []).includes('wow64') ? { wow64: false } : {},
          )), 'getHighEntropyValues'),
        });
        Object.defineProperty(uaData, 'toJSON', {
          configurable: true,
          writable: true,
          value: native(() => ({ brands, mobile: false, platform: ${platformJson} }), 'toJSON'),
        });
        defineGetter(Navigator.prototype, 'userAgentData', () => uaData);
      } catch {}

      // ---- navigator.plugins / navigator.mimeTypes ----------------------
      // Chrome reports a fixed set of five PDF entries and two matching MIME
      // types. Built on the real prototypes so \`instanceof PluginArray\` and
      // \`item()\` behave, and so the two lists agree with each other.
      try {
        const pluginNames = [
          'PDF Viewer',
          'Chrome PDF Viewer',
          'Chromium PDF Viewer',
          'Microsoft Edge PDF Viewer',
          'WebKit built-in PDF',
        ];
        const mimeSpecs = [
          { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
          { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
        ];
        const buildList = (proto, entries, keyOf) => {
          const list = Object.create(proto || Object.prototype);
          entries.forEach((entry, index) => {
            Object.defineProperty(list, index, { value: entry, enumerable: true });
            Object.defineProperty(list, keyOf(entry), { value: entry, enumerable: false });
          });
          defineGetter(list, 'length', () => entries.length);
          Object.defineProperty(list, 'item', {
            configurable: true,
            writable: true,
            value: native((i) => entries[i] ?? null, 'item'),
          });
          Object.defineProperty(list, 'namedItem', {
            configurable: true,
            writable: true,
            value: native((name) => entries.find((e) => keyOf(e) === name) ?? null, 'namedItem'),
          });
          Object.defineProperty(list, Symbol.iterator, {
            configurable: true,
            writable: true,
            value: native(function () { return entries[Symbol.iterator](); }, 'values'),
          });
          return list;
        };

        const mimeProto = typeof MimeType !== 'undefined' ? MimeType.prototype : Object.prototype;
        const pluginProto = typeof Plugin !== 'undefined' ? Plugin.prototype : Object.prototype;
        const mimes = mimeSpecs.map((spec) => {
          const mime = Object.create(mimeProto);
          defineGetter(mime, 'type', () => spec.type);
          defineGetter(mime, 'suffixes', () => spec.suffixes);
          defineGetter(mime, 'description', () => spec.description);
          return mime;
        });
        const plugins = pluginNames.map((name) => {
          const plugin = Object.create(pluginProto);
          defineGetter(plugin, 'name', () => name);
          defineGetter(plugin, 'filename', () => 'internal-pdf-viewer');
          defineGetter(plugin, 'description', () => 'Portable Document Format');
          defineGetter(plugin, 'length', () => mimes.length);
          mimes.forEach((mime, index) => {
            Object.defineProperty(plugin, index, { value: mime, enumerable: true });
          });
          return plugin;
        });
        mimes.forEach((mime) => defineGetter(mime, 'enabledPlugin', () => plugins[0]));

        const pluginArray = buildList(
          typeof PluginArray !== 'undefined' ? PluginArray.prototype : null,
          plugins,
          (p) => p.name,
        );
        const mimeTypeArray = buildList(
          typeof MimeTypeArray !== 'undefined' ? MimeTypeArray.prototype : null,
          mimes,
          (m) => m.type,
        );
        defineGetter(Navigator.prototype, 'plugins', () => pluginArray);
        defineGetter(Navigator.prototype, 'mimeTypes', () => mimeTypeArray);
      } catch {}

      // ---- window.chrome -------------------------------------------------
      // The runtime object real Chrome exposes and bare Chromium does not.
      try {
        if (!window.chrome) {
          Object.defineProperty(window, 'chrome', {
            configurable: true,
            enumerable: true,
            writable: true,
            value: {
              runtime: {},
              app: { isInstalled: false },
              csi: native(function csi() { return {}; }, 'csi'),
              loadTimes: native(function loadTimes() { return {}; }, 'loadTimes'),
            },
          });
        }
      } catch {}
`
    : ""
}
      // ---- notifications -------------------------------------------------
      // Headless reports 'denied' from both of these; real Chrome reports
      // 'default' and 'prompt' until a user decides. Patch the pair together —
      // patching one and not the other invents a combination that exists
      // nowhere.
      try {
        if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
          defineGetter(Notification, 'permission', () => 'default');
          const realQuery = navigator.permissions && navigator.permissions.query;
          if (realQuery) {
            const query = native(function query(params) {
              if (params && params.name === 'notifications') {
                return Promise.resolve({
                  name: 'notifications',
                  state: 'prompt',
                  onchange: null,
                });
              }
              return Reflect.apply(realQuery, navigator.permissions, [params]);
            }, 'query');
            navigator.permissions.query = query;
          }
        }
      } catch {}
    })();
  `;
}
