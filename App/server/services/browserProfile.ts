/**
 * The shared "look like desktop Chrome" profile.
 *
 * Two different parts of the App drive a headless Chromium:
 *
 *   * `browserChromium.ts` — the App-owned browser behind an employee's
 *     `browser_*` tools, which humans can watch live and take over.
 *   * the browser-login Integration drivers (`providers/x-browser.ts`),
 *     which replay a stored username/password against a site that has no
 *     usable API.
 *
 * Both talk to the same hostile login pages, so both need the same
 * disguise. It used to live only in `browserChromium.ts`, which meant the
 * Integration drivers announced themselves with a `Genosyn/0.1` user agent
 * and left `navigator.webdriver` set — then reported the resulting block as
 * if the site had simply gone down. Keeping the profile here means a bump
 * for one caller is a bump for both.
 *
 * We can't ship the real Chrome binary — Playwright's bundled Chromium is
 * glibc-only and the Alpine image only has `chromium` from apk — so we fake
 * the identity at every layer Chromium exposes:
 *
 *   * UA string → no "HeadlessChrome" token, no "Genosyn/" token, claims
 *     "Chrome" with a realistic version.
 *   * Sec-CH-UA / Sec-CH-UA-Platform request headers → "Google Chrome",
 *     not "Chromium".
 *   * `navigator.webdriver` → undefined (the `--disable-blink-features=
 *     AutomationControlled` flag handles most of this; the init script is
 *     belt-and-braces in case Chromium re-adds it).
 *   * `navigator.userAgentData.brands` → contains "Google Chrome", which is
 *     the Client-Hints equivalent of the UA spoof above.
 *
 * `CHROME_MAJOR` is the only piece that needs touching when we want to look
 * like a newer Chrome — the rest is derived from it. Bump it when sites
 * start sniffing for a newer baseline.
 *
 * This is camouflage, not evasion of a decision: we never solve a captcha
 * or defeat a challenge. When a site does challenge us, the browser-login
 * drivers stop and hand the page to a human (see
 * `browserConnectionHealth.ts`).
 */

export const CHROME_MAJOR = 134;
export const CHROME_FULL_VERSION = `${CHROME_MAJOR}.0.6998.166`;
export const CHROME_USER_AGENT = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_FULL_VERSION} Safari/537.36`;
export const CHROME_SEC_CH_UA = `"Chromium";v="${CHROME_MAJOR}", "Google Chrome";v="${CHROME_MAJOR}", "Not.A/Brand";v="24"`;

export const BROWSER_VIEWPORT_WIDTH = 1280;
export const BROWSER_VIEWPORT_HEIGHT = 800;

export const CHROMIUM_EXECUTABLE_PATH =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;

/** The one bit of Playwright the launch path actually needs. */
export type ChromiumLauncher = {
  launch(options: Record<string, unknown>): Promise<unknown>;
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
 * `chromium.launch()` options. `--disable-blink-features=
 * AutomationControlled` strips the `navigator.webdriver = true` tell that
 * headless Chromium injects, plus a handful of related automation hints
 * sites use to bounce bots.
 */
export function chromiumLaunchOptions(): Record<string, unknown> {
  return {
    headless: true,
    executablePath: CHROMIUM_EXECUTABLE_PATH,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
  };
}

/**
 * The fingerprint half of `browser.newContext()`. Callers merge in their
 * own security-boundary options (request routing, `serviceWorkers`) and the
 * `storageState` they want restored — those differ per caller and are not
 * part of the disguise.
 */
export function chromeContextOptions(): Record<string, unknown> {
  return {
    viewport: { width: BROWSER_VIEWPORT_WIDTH, height: BROWSER_VIEWPORT_HEIGHT },
    userAgent: CHROME_USER_AGENT,
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    extraHTTPHeaders: {
      "sec-ch-ua": CHROME_SEC_CH_UA,
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"macOS"',
    },
  };
}

/**
 * Page-init script that finishes the Chrome masquerade started by
 * `chromiumLaunchOptions` + `chromeContextOptions`. Runs in every page
 * (including iframes) before any site script executes, so by the time the
 * page's own bot-detection runs the automation tells are already gone.
 */
export function chromeMaskInitScript(): string {
  const brandsJson = JSON.stringify([
    { brand: "Chromium", version: String(CHROME_MAJOR) },
    { brand: "Google Chrome", version: String(CHROME_MAJOR) },
    { brand: "Not.A/Brand", version: "24" },
  ]);
  return `
    (() => {
      try {
        // navigator.webdriver — the canonical "is this a bot" check.
        // The launch flag covers most of it, but some Chromium builds
        // re-add the property; force-define it to undefined.
        Object.defineProperty(Navigator.prototype, 'webdriver', {
          configurable: true,
          enumerable: true,
          get: () => undefined,
        });
      } catch {}

      try {
        // navigator.userAgentData — Client Hints brands. Default
        // Chromium reports only "Chromium" and "Not.A/Brand"; real
        // Chrome adds a "Google Chrome" entry. Sites that key off this
        // (rather than the UA string) can tell us apart otherwise.
        const brands = ${brandsJson};
        const uaData = {
          brands,
          mobile: false,
          platform: 'macOS',
          getHighEntropyValues: (hints) => Promise.resolve({
            architecture: 'x86',
            bitness: '64',
            brands,
            fullVersionList: brands.map(b => ({ brand: b.brand, version: '${CHROME_FULL_VERSION}' })),
            mobile: false,
            model: '',
            platform: 'macOS',
            platformVersion: '10.15.7',
            uaFullVersion: '${CHROME_FULL_VERSION}',
            wow64: false,
          }),
          toJSON: () => ({ brands, mobile: false, platform: 'macOS' }),
        };
        Object.defineProperty(Navigator.prototype, 'userAgentData', {
          configurable: true,
          enumerable: true,
          get: () => uaData,
        });
      } catch {}

      try {
        // navigator.plugins / navigator.mimeTypes — headless Chromium
        // returns empty arrays; real desktop Chrome ships with a small
        // non-zero set. A length of 0 is a common bot heuristic.
        const fakePlugins = [
          { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        ];
        Object.defineProperty(Navigator.prototype, 'plugins', {
          configurable: true,
          get: () => fakePlugins,
        });
      } catch {}

      try {
        // navigator.languages — headless Chromium sometimes returns an
        // empty array if the locale isn't wired through. Pin to en-US
        // so it matches the Accept-Language header from the context.
        Object.defineProperty(Navigator.prototype, 'languages', {
          configurable: true,
          get: () => ['en-US', 'en'],
        });
      } catch {}

      try {
        // window.chrome — the runtime object real Chrome exposes that
        // bare Chromium does not. Sites probe \`window.chrome.runtime\`
        // as a "is this Google Chrome" gate; an empty stub is enough
        // to pass that probe without emulating the full surface.
        if (!window.chrome) {
          Object.defineProperty(window, 'chrome', {
            configurable: true,
            enumerable: true,
            writable: true,
            value: { runtime: {}, app: {}, csi: () => {}, loadTimes: () => {} },
          });
        }
      } catch {}

      try {
        // Notifications permission — headless Chromium always reports
        // 'denied'; real Chrome reports 'default' until the user grants
        // it. Some bot detectors compare \`Notification.permission\`
        // against the result of \`navigator.permissions.query\` and
        // flag the inconsistent headless pairing.
        const origQuery = navigator.permissions && navigator.permissions.query;
        if (origQuery) {
          navigator.permissions.query = (params) => (
            params && params.name === 'notifications'
              ? Promise.resolve({ state: Notification.permission === 'denied' ? 'prompt' : Notification.permission })
              : origQuery.call(navigator.permissions, params)
          );
        }
      } catch {}
    })();
  `;
}
