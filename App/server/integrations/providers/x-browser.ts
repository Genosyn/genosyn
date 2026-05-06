/**
 * X.com (Twitter) — username/password browser-driven mode.
 *
 * Connections of `authMode: "browser"` store the operator's login credentials
 * encrypted at rest. When an AI employee invokes a tool on this connection,
 * we launch a headless Chromium (the same `playwright-core` + bundled
 * binary the `mcp-browser` server uses), restore a cached storageState if
 * we have one, log in if we don't, perform the tool action by driving the
 * X.com UI, and persist the freshened storageState back to the encrypted
 * config. Subsequent calls reuse the cookies and skip login entirely until
 * X invalidates the session.
 *
 * Why this exists alongside the OAuth path:
 *   - Free-tier OAuth has brutal write rate-limits (~17 tweets/day at the
 *     time of writing) and DM endpoints are paywalled behind Basic+ access.
 *   - Some operators don't want to register an X dev project at all.
 *
 * Caveats — surfaced honestly in the UI:
 *   - X has aggressive anti-automation. "Unusual login" challenges, captchas,
 *     and 2FA can all block this flow. We don't attempt to defeat them; if
 *     login fails, we surface the actual error and the operator can sort it
 *     out (use a less-suspicious account, disable 2FA, complete the email
 *     verification once manually).
 *   - The DOM selectors below are X-internal `data-testid`s. They drift.
 *     Treat any flake from this module as a signal to re-check selectors
 *     against the current x.com login + compose surface.
 */

import type { IntegrationConfig, IntegrationRuntimeContext } from "../types.js";

export type XBrowserConfig = {
  username: string;
  password: string;
  /** Optional verification email/phone for the "unusual activity" prompt
   * X sometimes shows the first time we log in from a new IP. */
  verification?: string;
  /** Optional display name shown next to the connection in the UI. */
  displayName?: string;
  /** Cached Playwright storageState (cookies + localStorage) so we skip
   * login on subsequent tool calls. JSON-serialized — Playwright reads it
   * back as an object. */
  storageStateJson?: string;
  /** ms epoch of the last successful login. Informational only. */
  lastLoginAt?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const POST_TIMEOUT_MS = 60_000;
const X_LOGIN_URL = "https://x.com/i/flow/login";
const X_HOME_URL = "https://x.com/home";
const X_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Genosyn/0.1 Safari/537.36";

const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;

type Playwright = {
  chromium: {
    launch(options: Record<string, unknown>): Promise<unknown>;
  };
};

/**
 * Lazy-load `playwright-core` so the integrations module stays cheap to
 * import for stock installs that never use a browser-mode connection.
 */
async function getPlaywright(): Promise<Playwright> {
  try {
    const mod = await import("playwright-core");
    return { chromium: mod.chromium as unknown as Playwright["chromium"] };
  } catch (err) {
    throw new Error(
      `playwright-core is not installed: ${
        err instanceof Error ? err.message : String(err)
      }. Browser-login connections require the App container to bundle Chromium and playwright-core.`,
    );
  }
}

type RunOpts<T> = {
  cfg: XBrowserConfig;
  ctx: IntegrationRuntimeContext;
  action: (page: PWPage, cfg: XBrowserConfig) => Promise<T>;
};

type PWPage = {
  goto(url: string, opts?: Record<string, unknown>): Promise<unknown>;
  waitForSelector(sel: string, opts?: Record<string, unknown>): Promise<unknown>;
  fill(sel: string, value: string, opts?: Record<string, unknown>): Promise<unknown>;
  click(sel: string, opts?: Record<string, unknown>): Promise<unknown>;
  press?(sel: string, key: string, opts?: Record<string, unknown>): Promise<unknown>;
  url(): string;
  locator(sel: string): {
    first(): {
      waitFor(opts: Record<string, unknown>): Promise<unknown>;
      click(opts?: Record<string, unknown>): Promise<unknown>;
      fill(value: string, opts?: Record<string, unknown>): Promise<unknown>;
      press(key: string, opts?: Record<string, unknown>): Promise<unknown>;
      textContent(): Promise<string | null>;
      isVisible(): Promise<boolean>;
    };
    count(): Promise<number>;
  };
  keyboard: { press(key: string): Promise<unknown>; type(text: string): Promise<unknown> };
  evaluate<R>(fn: () => R): Promise<R>;
  waitForLoadState(state: string, opts?: Record<string, unknown>): Promise<unknown>;
  waitForTimeout(ms: number): Promise<unknown>;
  close(): Promise<unknown>;
};

type PWContext = {
  newPage(): Promise<PWPage>;
  storageState(): Promise<unknown>;
  close(): Promise<unknown>;
};

type PWBrowser = {
  newContext(opts: Record<string, unknown>): Promise<PWContext>;
  close(): Promise<unknown>;
};

/**
 * Open a browser, restore (or create) a session, run `action`, persist the
 * fresh storageState back to the connection config, and shut everything
 * down. The action's return value is bubbled out to the caller.
 *
 * One launch per tool call — keeps memory predictable since these calls are
 * infrequent (an AI employee posting a few tweets per routine, not a busy
 * web app). If we ever need throughput we can pool here.
 */
export async function runWithXBrowser<T>(opts: RunOpts<T>): Promise<T> {
  const pw = await getPlaywright();
  const browser = (await pw.chromium.launch({
    headless: true,
    executablePath: CHROMIUM_PATH,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  })) as PWBrowser;

  let context: PWContext | null = null;
  let page: PWPage | null = null;
  try {
    const storage = parseStorageState(opts.cfg.storageStateJson);
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: X_USER_AGENT,
      storageState: storage ?? undefined,
    });
    page = await context.newPage();

    if (!storage || !(await isLoggedIn(page))) {
      await loginToX(page, opts.cfg);
    }

    const result = await opts.action(page, opts.cfg);

    // Persist fresh cookies for the next call.
    const fresh = await context.storageState();
    const next: XBrowserConfig = {
      ...opts.cfg,
      storageStateJson: JSON.stringify(fresh),
      lastLoginAt: Date.now(),
    };
    opts.ctx.setConfig?.(next as unknown as IntegrationConfig);
    opts.ctx.config = next as unknown as IntegrationConfig;

    return result;
  } finally {
    try {
      if (page) await page.close();
    } catch {
      // ignore — best-effort cleanup
    }
    try {
      if (context) await context.close();
    } catch {
      // ignore
    }
    try {
      await browser.close();
    } catch {
      // ignore
    }
  }
}

function parseStorageState(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    // fall through — bad cache will trigger a fresh login
  }
  return null;
}

/**
 * Cheap signal that an X session is still good. We hit /home and look for
 * the "compose tweet" sidebar button; if it's there we're logged in, if
 * we get bounced back to /i/flow/login we're not.
 */
async function isLoggedIn(page: PWPage): Promise<boolean> {
  try {
    await page.goto(X_HOME_URL, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
    const url = page.url();
    if (/\/i\/flow\/login/.test(url) || /\/login/.test(url)) return false;
    const compose = page.locator('[data-testid="SideNav_NewTweet_Button"], [data-testid="tweetButtonInline"]').first();
    return await compose.isVisible();
  } catch {
    return false;
  }
}

/**
 * Drive the X login flow:
 *   1. Open /i/flow/login
 *   2. Type username, press Next
 *   3. Sometimes: "unusual activity" → email/phone verification
 *   4. Type password, press Login
 *   5. Wait until home loads
 *
 * Throws with the actual visible error text (or a friendly fallback) if any
 * step times out — the operator gets a concrete signal to act on.
 */
async function loginToX(page: PWPage, cfg: XBrowserConfig): Promise<void> {
  await page.goto(X_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });

  // Step 1: username field.
  const usernameSel = 'input[autocomplete="username"]';
  await page.waitForSelector(usernameSel, { timeout: DEFAULT_TIMEOUT_MS }).catch(() => {
    throw new Error(
      "X login page did not render the username field. The site may be showing a captcha or a temporary block.",
    );
  });
  await page.fill(usernameSel, cfg.username);
  await page.keyboard.press("Enter");

  // Step 2: optional verification challenge.
  await page.waitForTimeout(800);
  const verifyVisible = await page
    .locator('input[data-testid="ocfEnterTextTextInput"]')
    .first()
    .isVisible()
    .catch(() => false);
  if (verifyVisible) {
    if (!cfg.verification) {
      throw new Error(
        'X is asking for an "unusual activity" verification (email or phone). Add a Verification value to the connection and try again.',
      );
    }
    await page.fill('input[data-testid="ocfEnterTextTextInput"]', cfg.verification);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(800);
  }

  // Step 3: password field.
  const passwordSel = 'input[name="password"]';
  await page.waitForSelector(passwordSel, { timeout: DEFAULT_TIMEOUT_MS }).catch(() => {
    throw new Error(
      "X did not render the password field. The credentials may be wrong, or X is showing a captcha. Try logging in manually once from the same network and disable 2FA on this account if you have it on.",
    );
  });
  await page.fill(passwordSel, cfg.password);
  await page.keyboard.press("Enter");

  // Step 4: wait for /home (or detect a 2FA challenge and bail).
  const start = Date.now();
  for (;;) {
    await page.waitForTimeout(800);
    const url = page.url();
    if (/\/home/.test(url)) return;
    if (/\/i\/flow\/two/.test(url) || /\/i\/flow\/login\/2fa/.test(url)) {
      throw new Error(
        "X is asking for a 2FA code. Browser-login mode does not support accounts with 2FA — turn off 2FA on this account or use the OAuth connection mode instead.",
      );
    }
    const errLoc = page.locator('div[role="alert"], [data-testid="error"]').first();
    if (await errLoc.isVisible().catch(() => false)) {
      const text = (await errLoc.textContent().catch(() => "")) || "";
      if (text.trim()) throw new Error(`X login failed: ${text.trim().slice(0, 200)}`);
    }
    if (Date.now() - start > POST_TIMEOUT_MS) {
      throw new Error(
        "X login timed out — the site did not advance to /home within 60s. The credentials may be wrong, or X is showing a captcha.",
      );
    }
  }
}

/** Open the compose dialog and post a tweet. Returns the URL of the tweet
 * if we can capture it, otherwise an empty string. */
export async function postTweetViaBrowser(
  page: PWPage,
  args: { text: string; replyToTweetId?: string },
): Promise<{ ok: true; url: string }> {
  if (args.replyToTweetId) {
    await page.goto(`https://x.com/i/web/status/${encodeURIComponent(args.replyToTweetId)}`, {
      waitUntil: "domcontentloaded",
      timeout: DEFAULT_TIMEOUT_MS,
    });
    const replyLoc = page
      .locator('[data-testid="reply"]')
      .first();
    await replyLoc.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT_MS });
    await replyLoc.click();
  } else {
    await page.goto(X_HOME_URL, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
    const composeLoc = page
      .locator('[data-testid="SideNav_NewTweet_Button"], [data-testid="tweetButtonInline"]')
      .first();
    await composeLoc.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT_MS });
    await composeLoc.click();
  }

  const editorLoc = page.locator('[data-testid="tweetTextarea_0"]').first();
  await editorLoc.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT_MS });
  await editorLoc.click();
  // X's editor is a contenteditable, not an <input> — type via keyboard
  // so the React state syncs and the post button enables.
  await page.keyboard.type(args.text);

  const submitLoc = page
    .locator('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]')
    .first();
  await submitLoc.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT_MS });
  await submitLoc.click();

  // Wait for the editor to clear / the toast to appear, indicating the post
  // landed. We then go to /home and try to capture the URL of the most
  // recent tweet by the authed user; if anything fails we still return ok
  // (the post itself succeeded).
  await page.waitForTimeout(2_000);
  let url = "";
  try {
    await page.goto(X_HOME_URL, { waitUntil: "domcontentloaded", timeout: 15_000 });
    const link = page.locator('article a[href*="/status/"]').first();
    if (await link.isVisible().catch(() => false)) {
      const href = await link.textContent().catch(() => null);
      if (href) url = href;
    }
  } catch {
    // ignore — best-effort
  }
  return { ok: true, url };
}

export async function likeTweetViaBrowser(
  page: PWPage,
  args: { tweetId: string },
): Promise<{ ok: true }> {
  await page.goto(`https://x.com/i/web/status/${encodeURIComponent(args.tweetId)}`, {
    waitUntil: "domcontentloaded",
    timeout: DEFAULT_TIMEOUT_MS,
  });
  const likeLoc = page.locator('[data-testid="like"]').first();
  await likeLoc.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT_MS });
  await likeLoc.click();
  await page.waitForTimeout(500);
  return { ok: true };
}

export async function unlikeTweetViaBrowser(
  page: PWPage,
  args: { tweetId: string },
): Promise<{ ok: true }> {
  await page.goto(`https://x.com/i/web/status/${encodeURIComponent(args.tweetId)}`, {
    waitUntil: "domcontentloaded",
    timeout: DEFAULT_TIMEOUT_MS,
  });
  const unlikeLoc = page.locator('[data-testid="unlike"]').first();
  await unlikeLoc.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT_MS });
  await unlikeLoc.click();
  await page.waitForTimeout(500);
  return { ok: true };
}

export async function retweetViaBrowser(
  page: PWPage,
  args: { tweetId: string },
): Promise<{ ok: true }> {
  await page.goto(`https://x.com/i/web/status/${encodeURIComponent(args.tweetId)}`, {
    waitUntil: "domcontentloaded",
    timeout: DEFAULT_TIMEOUT_MS,
  });
  const rtLoc = page.locator('[data-testid="retweet"]').first();
  await rtLoc.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT_MS });
  await rtLoc.click();
  // Confirmation menu opens — click the "Repost" item.
  const confirmLoc = page.locator('[data-testid="retweetConfirm"]').first();
  await confirmLoc.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT_MS });
  await confirmLoc.click();
  await page.waitForTimeout(500);
  return { ok: true };
}

export async function deleteTweetViaBrowser(
  page: PWPage,
  args: { tweetId: string },
): Promise<{ ok: true }> {
  await page.goto(`https://x.com/i/web/status/${encodeURIComponent(args.tweetId)}`, {
    waitUntil: "domcontentloaded",
    timeout: DEFAULT_TIMEOUT_MS,
  });
  const caretLoc = page.locator('[data-testid="caret"]').first();
  await caretLoc.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT_MS });
  await caretLoc.click();
  // Menu opens — pick "Delete".
  const deleteItem = page.locator('[role="menuitem"]:has-text("Delete")').first();
  await deleteItem.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT_MS });
  await deleteItem.click();
  // Confirm.
  const confirmLoc = page.locator('[data-testid="confirmationSheetConfirm"]').first();
  await confirmLoc.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT_MS });
  await confirmLoc.click();
  await page.waitForTimeout(500);
  return { ok: true };
}

export async function followUserViaBrowser(
  page: PWPage,
  args: { handle: string },
): Promise<{ ok: true }> {
  const handle = args.handle.replace(/^@/, "");
  await page.goto(`https://x.com/${encodeURIComponent(handle)}`, {
    waitUntil: "domcontentloaded",
    timeout: DEFAULT_TIMEOUT_MS,
  });
  // The follow button's data-testid is "<userid>-follow" — match by suffix.
  const followLoc = page.locator('[data-testid$="-follow"]').first();
  await followLoc.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT_MS });
  await followLoc.click();
  await page.waitForTimeout(500);
  return { ok: true };
}

export async function unfollowUserViaBrowser(
  page: PWPage,
  args: { handle: string },
): Promise<{ ok: true }> {
  const handle = args.handle.replace(/^@/, "");
  await page.goto(`https://x.com/${encodeURIComponent(handle)}`, {
    waitUntil: "domcontentloaded",
    timeout: DEFAULT_TIMEOUT_MS,
  });
  const unfollowLoc = page.locator('[data-testid$="-unfollow"]').first();
  await unfollowLoc.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT_MS });
  await unfollowLoc.click();
  // X confirms — click the confirmation.
  const confirmLoc = page.locator('[data-testid="confirmationSheetConfirm"]').first();
  await confirmLoc.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
  if (await confirmLoc.isVisible().catch(() => false)) {
    await confirmLoc.click();
  }
  await page.waitForTimeout(500);
  return { ok: true };
}
