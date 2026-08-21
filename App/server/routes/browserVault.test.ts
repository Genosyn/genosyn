import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import { chromium } from "playwright-core";

import {
  armUnapprovedFormSubmitGuard,
  browserClickMaySubmit,
  browserKeyMaySubmit,
  browserModelPressKeyIsAllowed,
  browserModelPressKeySchema,
  clearVaultSensitiveValuesForSession,
  disarmUnapprovedFormSubmitGuard,
  inspectBrowserApprovalTarget,
  observeBrowserSensitiveValue,
  pageSnapshot,
  redactPasswordInputsFromSnapshot,
  redactVaultSensitiveText,
  rememberVaultTotpCode,
  rememberCurrentPasswordValues,
  safeBrowserUrlForModel,
  vaultFillTargetIsAllowed,
  vaultPasskeyMatchesPage,
  vaultUrlAllowedForEmployee,
  vaultWebsiteMatchesPage,
} from "./browserRpc.js";

function chromiumExecutablePath(): string | undefined {
  return [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    chromium.executablePath(),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ]
    .filter((value): value is string => Boolean(value))
    .find((value) => existsSync(value));
}

describe("Vault browser hostname binding", () => {
  it("allows the exact saved origin across paths", () => {
    assert.equal(
      vaultWebsiteMatchesPage(
        "https://accounts.example.com/login",
        "https://accounts.example.com/settings?next=1",
      ),
      true,
    );
  });

  it("rejects scheme and port changes", () => {
    assert.equal(
      vaultWebsiteMatchesPage("http://accounts.example.com", "https://accounts.example.com"),
      false,
    );
    assert.equal(
      vaultWebsiteMatchesPage("https://accounts.example.com", "http://accounts.example.com"),
      false,
    );
    assert.equal(
      vaultWebsiteMatchesPage("https://accounts.example.com", "https://accounts.example.com:8443"),
      false,
    );
  });

  it("rejects sibling, parent and lookalike hosts", () => {
    assert.equal(
      vaultWebsiteMatchesPage("https://accounts.example.com", "https://example.com"),
      false,
    );
    assert.equal(
      vaultWebsiteMatchesPage("https://example.com", "https://accounts.example.com"),
      false,
    );
    assert.equal(
      vaultWebsiteMatchesPage("https://example.com", "https://example.com.attacker.test"),
      false,
    );
  });

  it("rejects non-http schemes and malformed URLs", () => {
    assert.equal(vaultWebsiteMatchesPage("javascript:alert(1)", "https://example.com"), false);
    assert.equal(vaultWebsiteMatchesPage("https://example.com", "not a url"), false);
  });
});

describe("Vault browser fill target", () => {
  it("only puts login passwords into password inputs", () => {
    assert.equal(vaultFillTargetIsAllowed("login", "secret", "password"), true);
    assert.equal(vaultFillTargetIsAllowed("login", "secret", "PASSWORD"), true);
    assert.equal(vaultFillTargetIsAllowed("login", "secret", "text"), false);
    assert.equal(vaultFillTargetIsAllowed("login", "secret", null), false);
  });

  it("allows usernames but rejects non-login secret targets", () => {
    assert.equal(vaultFillTargetIsAllowed("login", "username", "email"), true);
    assert.equal(vaultFillTargetIsAllowed("api_key", "secret", "text"), false);
    assert.equal(vaultFillTargetIsAllowed("secure_note", "secret", "textarea"), false);
  });

  it("allows generated TOTP codes only in ordinary Login inputs", () => {
    assert.equal(vaultFillTargetIsAllowed("login", "totp", "text"), true);
    assert.equal(vaultFillTargetIsAllowed("login", "totp", "tel"), true);
    assert.equal(vaultFillTargetIsAllowed("login", "totp", "number"), true);
    assert.equal(vaultFillTargetIsAllowed("login", "totp", null), false);
    assert.equal(vaultFillTargetIsAllowed("api_key", "totp", "text"), false);
  });

  it("intersects Vault use with the AI Employee Browser host policy", () => {
    assert.equal(vaultUrlAllowedForEmployee("https://accounts.example.com", null), true);
    assert.equal(
      vaultUrlAllowedForEmployee(
        "https://accounts.example.com/login",
        "accounts.example.com\nmail.example.com",
      ),
      true,
    );
    assert.equal(
      vaultUrlAllowedForEmployee("https://accounts.example.com", "mail.example.com"),
      false,
    );
  });
});

describe("Vault passkey RP binding", () => {
  it("accepts the exact RP ID and its subdomains on secure pages", () => {
    assert.equal(vaultPasskeyMatchesPage("example.com", "https://example.com/login"), true);
    assert.equal(
      vaultPasskeyMatchesPage("example.com", "https://accounts.example.com/login"),
      true,
    );
    assert.equal(vaultPasskeyMatchesPage("localhost", "http://localhost:3000/login"), true);
  });

  it("rejects sibling, lookalike, insecure, and malformed relying parties", () => {
    assert.equal(vaultPasskeyMatchesPage("accounts.example.com", "https://example.com"), false);
    assert.equal(
      vaultPasskeyMatchesPage("example.com", "https://example.com.attacker.test"),
      false,
    );
    assert.equal(vaultPasskeyMatchesPage("example.com", "http://example.com"), false);
    assert.equal(vaultPasskeyMatchesPage("", "https://example.com"), false);
  });
});

describe("Browser model-visible URL", () => {
  it("omits userinfo, path, query, and fragment tokens", () => {
    assert.equal(
      safeBrowserUrlForModel(
        "https://user:secret@example.com/reset/path-token?code=query-token#fragment-token",
      ),
      "https://example.com",
    );
  });
});

describe("Browser approval target binding", () => {
  it("treats submit-capable keys and button semantics as approval-required", () => {
    assert.equal(browserKeyMaySubmit("Enter"), true);
    assert.equal(browserKeyMaySubmit("Control+NumpadEnter"), true);
    assert.equal(browserKeyMaySubmit("Space"), true);
    assert.equal(browserKeyMaySubmit("Tab"), false);
    assert.equal(
      browserClickMaySubmit({
        tagName: "button",
        inputType: "button",
        frameUrl: "https://example.test/login",
        formAction: null,
        formMethod: null,
        submitsForm: true,
      }),
      true,
    );
  });

  it("allows only plain model keypresses and rejects clipboard or context-menu input", () => {
    for (const key of [
      "Enter",
      "NumpadEnter",
      "Tab",
      "Escape",
      "ArrowDown",
      "ArrowUp",
      "Home",
      "End",
      "Backspace",
      "Delete",
      "Space",
    ]) {
      assert.equal(browserModelPressKeyIsAllowed(key), true, key);
      assert.equal(browserModelPressKeySchema.safeParse(key).success, true, key);
    }

    for (const key of [
      "Control+C",
      "Meta+C",
      "Control+Insert",
      "Shift+Insert",
      "Control+Shift+V",
      "ControlOrMeta+C",
      "Copy",
      "Cut",
      "Paste",
      "ContextMenu",
      "Apps",
      "Shift+F10",
      "Control",
      "Meta",
      "F10",
      "c",
    ]) {
      assert.equal(browserModelPressKeyIsAllowed(key), false, key);
      assert.equal(browserModelPressKeySchema.safeParse(key).success, false, key);
    }
  });

  it("blocks a clipboard chord before it reaches real Chromium while plain Tab still works", async (t) => {
    const executablePath = chromiumExecutablePath();
    if (!executablePath) {
      t.skip("No Chromium executable is available for the keypress boundary test");
      return;
    }
    const browser = await chromium.launch({ headless: true, executablePath });
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <input id="first">
        <input id="secret" value="REAL_CHROMIUM_VAULT_PASSWORD">
        <script>
          window.clipboardChordEvents = 0;
          document.addEventListener('keydown', (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
              window.clipboardChordEvents += 1;
            }
          });
        </script>
      `);
      await page.locator("#first").focus();

      const modelPress = async (key: string) => {
        browserModelPressKeySchema.parse(key);
        await page.keyboard.press(key);
      };

      await modelPress("Tab");
      assert.equal(await page.evaluate(() => document.activeElement?.id), "secret");
      await page.locator("#secret").selectText();
      await assert.rejects(modelPress("Control+C"), /Modifier chords/);
      assert.equal(
        await page.evaluate(
          () => (window as unknown as { clipboardChordEvents: number }).clipboardChordEvents,
        ),
        0,
      );
    } finally {
      await browser.close();
    }
  });

  it("fingerprints form values without firing page-controlled formdata handlers", async (t) => {
    const executablePath = chromiumExecutablePath();
    if (!executablePath) {
      t.skip("No Chromium executable is available for the approval target test");
      return;
    }
    const browser = await chromium.launch({ headless: true, executablePath });
    try {
      const page = await browser.newPage();
      await page.route("https://example.test/login", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `
            <form id="login" action="/sessions" method="post">
              <input id="password" type="password" name="password" value="FIRST_PRIVATE_VALUE">
              <button id="submit" type="submit" name="intent" value="login">Sign in</button>
            </form>
            <script>
              window.formdataEvents = 0;
              window.formdataNetworkAttempts = 0;
              document.querySelector('#login').addEventListener('formdata', () => {
                window.formdataEvents += 1;
                window.formdataNetworkAttempts += 1;
              });
            </script>
          `,
        }),
      );
      await page.goto("https://example.test/login");
      const handle = await page.locator("#submit").elementHandle();
      assert.ok(handle);
      const common = {
        page: page as never,
        session: {
          id: "10000000-0000-4000-8000-000000000001",
          companyId: "10000000-0000-4000-8000-000000000002",
        } as never,
        employee: { id: "10000000-0000-4000-8000-000000000003" } as never,
        action: "submit" as const,
        selector: "#submit",
        key: null,
        handle: handle as never,
      };
      const first = await inspectBrowserApprovalTarget(common);
      assert.equal(first.descriptor.submitsForm, true);
      assert.doesNotMatch(JSON.stringify(first), /FIRST_PRIVATE_VALUE/);
      assert.deepEqual(
        await page.evaluate(() => ({
          formdataEvents: (window as unknown as { formdataEvents: number }).formdataEvents,
          networkAttempts: (window as unknown as { formdataNetworkAttempts: number })
            .formdataNetworkAttempts,
        })),
        { formdataEvents: 0, networkAttempts: 0 },
      );

      await page.locator("#password").fill("SECOND_PRIVATE_VALUE");
      const second = await inspectBrowserApprovalTarget(common);
      assert.notEqual(second.fingerprint, first.fingerprint);
      assert.doesNotMatch(JSON.stringify(second), /SECOND_PRIVATE_VALUE/);
    } finally {
      await browser.close();
    }
  });

  it("normalizes only the selected TOTP value while binding its field, form, and peers", async (t) => {
    const executablePath = chromiumExecutablePath();
    if (!executablePath) {
      t.skip("No Chromium executable is available for the TOTP approval target test");
      return;
    }
    const browser = await chromium.launch({ headless: true, executablePath });
    try {
      const page = await browser.newPage();
      await page.route("https://example.test/login", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `
            <form id="login" action="/sessions" method="post">
              <input id="password" type="password" name="password" value="UNCHANGED_PASSWORD">
              <input id="otp" type="text" inputmode="numeric" name="otp" value="111111">
              <button id="submit" type="submit">Sign in</button>
            </form>
            <form id="other"></form>
          `,
        }),
      );
      await page.goto("https://example.test/login");
      const submitHandle = await page.locator("#submit").elementHandle();
      const totpHandle = await page.locator("#otp").elementHandle();
      assert.ok(submitHandle);
      assert.ok(totpHandle);
      const common = {
        page: page as never,
        session: {
          id: "10000000-0000-4000-8000-000000000011",
          companyId: "10000000-0000-4000-8000-000000000012",
        } as never,
        employee: { id: "10000000-0000-4000-8000-000000000013" } as never,
        action: "vault_totp_submit" as const,
        selector: "#submit",
        key: null,
        handle: submitHandle as never,
        vaultTotp: {
          handle: totpHandle as never,
          itemId: "10000000-0000-4000-8000-000000000014",
          selector: "#otp",
        },
      };
      const first = await inspectBrowserApprovalTarget(common);
      assert.doesNotMatch(JSON.stringify(first), /111111|UNCHANGED_PASSWORD/);

      await page.locator("#otp").fill("222222");
      const refreshedCode = await inspectBrowserApprovalTarget(common);
      assert.equal(refreshedCode.fingerprint, first.fingerprint);
      assert.doesNotMatch(JSON.stringify(refreshedCode), /222222|UNCHANGED_PASSWORD/);

      await page.locator("#password").fill("CHANGED_PASSWORD");
      const changedPeer = await inspectBrowserApprovalTarget(common);
      assert.notEqual(changedPeer.fingerprint, first.fingerprint);

      await page.locator("#otp").evaluate((element) => element.setAttribute("form", "other"));
      await assert.rejects(
        inspectBrowserApprovalTarget(common),
        /same form as the approved submit target/,
      );
    } finally {
      await browser.close();
    }
  });

  it("blocks requestSubmit inside an iframe while an unapproved action runs", async (t) => {
    const executablePath = chromiumExecutablePath();
    if (!executablePath) {
      t.skip("No Chromium executable is available for the iframe submit-guard test");
      return;
    }
    const browser = await chromium.launch({ headless: true, executablePath });
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <iframe srcdoc='<form id="f"><button id="go" type="button" onclick="this.form.requestSubmit()">Go</button></form>'></iframe>
      `);
      const frame = page.locator("iframe").contentFrame();
      await frame.locator("#go").waitFor();
      await armUnapprovedFormSubmitGuard(page as never);
      await frame.locator("#go").click();
      assert.equal(await disarmUnapprovedFormSubmitGuard(page as never), true);
    } finally {
      await browser.close();
    }
  });
});

describe("Browser snapshot password redaction", () => {
  it("withholds model-visible codes from direct fill and combined submit across clock skew", async () => {
    for (const [path, code] of [
      ["direct-fill", "123456"],
      ["combined-submit", "654321"],
    ] as const) {
      const sessionId = `browser-current-totp-redaction-${path}`;
      // Keep the preceding code window withheld briefly too: a site's clock
      // or response can lag behind the App after the code was accepted.
      await rememberVaultTotpCode(sessionId, code, new Date(Date.now() - 60_000));
      const spaced = code.split("").join(" ");
      const redacted = redactVaultSensitiveText(
        sessionId,
        `The page reflected ${spaced} in separate accessibility nodes`,
      );
      assert.doesNotMatch(redacted, new RegExp(`${spaced}|${code}`));
      assert.match(redacted, /current Vault one-time code/);
      clearVaultSensitiveValuesForSession(sessionId);
    }
  });

  it("removes top-level and framed password values while retaining ordinary inputs", async () => {
    const tree = [
      "- generic [active] [ref=e1]:",
      '  - textbox "Text" [ref=e2]: ordinary value',
      '  - textbox "Password" [ref=e3]: TOP_PASSWORD_SECRET',
      "  - iframe [ref=e4]:",
      '    - textbox "Frame password" [ref=f1e2]: FRAME_PASSWORD_SECRET',
    ].join("\n");
    const fields: Record<string, { type: string; value: string }> = {
      e2: { type: "text", value: "ordinary value" },
      e3: { type: "password", value: "TOP_PASSWORD_SECRET" },
      f1e2: { type: "password", value: "FRAME_PASSWORD_SECRET" },
    };
    const fakePage = {
      locator(selector: string) {
        const ref = selector.replace("aria-ref=", "");
        const field = fields[ref];
        return {
          first: () => ({
            elementHandle: async () =>
              field
                ? {
                    getAttribute: async () => field.type,
                    inputValue: async () => field.value,
                  }
                : null,
          }),
        };
      },
    };

    const redacted = await redactPasswordInputsFromSnapshot(
      fakePage as never,
      "browser-redaction-test",
      tree,
    );
    assert.doesNotMatch(redacted, /ordinary value/);
    assert.doesNotMatch(redacted, /TOP_PASSWORD_SECRET|FRAME_PASSWORD_SECRET/);
    assert.equal((redacted.match(/\[redacted password\]/g) ?? []).length, 3);

    const laterOutput = redactVaultSensitiveText(
      "browser-redaction-test",
      'Playwright fill("TOP_PASSWORD_SECRET") and reflected FRAME_PASSWORD_SECRET',
    );
    assert.doesNotMatch(laterOutput, /TOP_PASSWORD_SECRET|FRAME_PASSWORD_SECRET/);
    clearVaultSensitiveValuesForSession("browser-redaction-test");
  });

  it("fails closed when a textbox ref cannot be resolved", async () => {
    const fakePage = {
      locator: () => ({ first: () => ({ elementHandle: async () => null }) }),
    };
    const redacted = await redactPasswordInputsFromSnapshot(
      fakePage as never,
      "browser-detached-test",
      '- textbox "Detached" [ref=e9]: MAYBE_SECRET',
    );
    assert.equal(redacted, '- textbox "Detached" [ref=e9]: [redacted password]');
  });

  it("does not use raw visible-text fallback after a password taints the session", async () => {
    const sessionId = "browser-empty-aria-fallback-test";
    observeBrowserSensitiveValue(sessionId, "", "password-present");
    const snapshot = await pageSnapshot(
      {
        url: () => "https://example.com/reset?token=hidden",
        title: async () => "Reset",
        ariaSnapshot: async () => "",
        evaluate: async () => "FALLBACK_PASSWORD_SECRET",
      } as never,
      sessionId,
    );
    assert.doesNotMatch(snapshot, /FALLBACK_PASSWORD_SECRET/);
    assert.match(snapshot, /redacted because this BrowserSession has contained a password/);
    clearVaultSensitiveValuesForSession(sessionId);
  });

  it("redacts an authenticator setup key found only in the page title", async () => {
    const sessionId = "browser-title-totp-redaction-test";
    const setupKey = "JBSWY3DPEHPK3PXP";
    const snapshot = await pageSnapshot(
      {
        url: () => "https://example.com/mfa",
        title: async () => setupKey,
        ariaSnapshot: async () => '- heading "Account settings"',
        locator: () => ({ first: () => ({ elementHandle: async () => null }) }),
      } as never,
      sessionId,
    );
    assert.doesNotMatch(snapshot, new RegExp(setupKey));
    assert.match(snapshot, /Title: \[redacted TOTP setup key\]/);
    clearVaultSensitiveValuesForSession(sessionId);
  });

  it("fails closed instead of evicting an older password from the redaction set", async () => {
    const sessionId = "browser-sensitive-overflow-test";
    const oldest = "OLDEST_REFLECTED_PASSWORD";
    let overflowValue = "";
    for (let index = 0; index < 65; index += 1) {
      const value = index === 0 ? oldest : `later-password-${index}`;
      overflowValue = value;
      observeBrowserSensitiveValue(sessionId, value, "password-value");
    }
    const snapshot = await pageSnapshot(
      {
        url: () => "https://example.com",
        title: async () => overflowValue,
        ariaSnapshot: async () => `- text: ${oldest}`,
        locator: () => ({ first: () => ({ elementHandle: async () => null }) }),
      } as never,
      sessionId,
    );
    assert.doesNotMatch(snapshot, /OLDEST_REFLECTED_PASSWORD/);
    assert.doesNotMatch(snapshot, new RegExp(overflowValue));
    assert.match(snapshot, /exceeded the sensitive-value safety limit/);
    assert.doesNotMatch(
      redactVaultSensitiveText(sessionId, `Playwright error contained ${overflowValue}`),
      new RegExp(overflowValue),
    );
    clearVaultSensitiveValuesForSession(sessionId);
  });

  it("redacts password values from a real Playwright top page and iframe", async (t) => {
    const candidates = [
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      chromium.executablePath(),
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ].filter((value): value is string => Boolean(value));
    const executablePath = candidates.find((value) => existsSync(value));
    if (!executablePath) {
      t.skip("No Chromium executable is available for the real-browser redaction test");
      return;
    }
    const browser = await chromium.launch({ headless: true, executablePath });
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <label>Ordinary <input value="ordinary value"></label>
        <label>Secret <input type="password" value="TOP_REAL_PASSWORD"></label>
        <iframe srcdoc='<label>Frame <input type="password" value="FRAME_REAL_PASSWORD"></label>'></iframe>
      `);
      await page.locator("iframe").contentFrame().locator("input").waitFor();
      const raw = await page.locator("body").ariaSnapshot({ mode: "ai" });
      assert.match(raw, /TOP_REAL_PASSWORD|FRAME_REAL_PASSWORD/);

      const redacted = await redactPasswordInputsFromSnapshot(
        page as never,
        "real-browser-redaction-test",
        raw,
      );
      assert.doesNotMatch(redacted, /ordinary value/);
      assert.doesNotMatch(redacted, /TOP_REAL_PASSWORD|FRAME_REAL_PASSWORD/);

      await page.getByLabel("Ordinary").click();
      const nextRaw = await page.locator("body").ariaSnapshot({ mode: "ai" });
      const next = await redactPasswordInputsFromSnapshot(
        page as never,
        "real-browser-redaction-test",
        nextRaw,
      );
      assert.doesNotMatch(next, /TOP_REAL_PASSWORD|FRAME_REAL_PASSWORD/);
      assert.doesNotMatch(
        redactVaultSensitiveText(
          "real-browser-redaction-test",
          'locator.fill("TOP_REAL_PASSWORD") failed after FRAME_REAL_PASSWORD',
        ),
        /TOP_REAL_PASSWORD|FRAME_REAL_PASSWORD/,
      );
    } finally {
      clearVaultSensitiveValuesForSession("real-browser-redaction-test");
      await browser.close();
    }
  });

  it("keeps a human-entered password redacted after a show-password toggle", async (t) => {
    const candidates = [
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      chromium.executablePath(),
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ].filter((value): value is string => Boolean(value));
    const executablePath = candidates.find((value) => existsSync(value));
    if (!executablePath) {
      t.skip("No Chromium executable is available for the real-browser redaction test");
      return;
    }
    const sessionId = "real-browser-human-password-test";
    const browser = await chromium.launch({ headless: true, executablePath });
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <label>Password <input id="secret" type="password"></label>
        <button id="show" onclick="document.querySelector('#secret').type = 'text'">Show</button>
      `);
      await page.locator("#secret").fill("HUMAN_TAKEOVER_PASSWORD");
      await rememberCurrentPasswordValues(page as never, sessionId);
      await page.locator("#show").click();

      const raw = await page.locator("body").ariaSnapshot({ mode: "ai" });
      assert.match(raw, /HUMAN_TAKEOVER_PASSWORD/);
      const semanticRedaction = await redactPasswordInputsFromSnapshot(
        page as never,
        sessionId,
        raw,
      );
      const fullyRedacted = redactVaultSensitiveText(sessionId, semanticRedaction);
      assert.doesNotMatch(fullyRedacted, /HUMAN_TAKEOVER_PASSWORD/);
    } finally {
      clearVaultSensitiveValuesForSession(sessionId);
      await browser.close();
    }
  });

  it("keeps a password redacted when a human reveals the empty field before typing", async (t) => {
    const candidates = [
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      chromium.executablePath(),
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ].filter((value): value is string => Boolean(value));
    const executablePath = candidates.find((value) => existsSync(value));
    if (!executablePath) {
      t.skip("No Chromium executable is available for the real-browser redaction test");
      return;
    }
    const sessionId = "real-browser-reveal-before-type-test";
    const browser = await chromium.launch({ headless: true, executablePath });
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <label>Password <input id="secret" type="password"></label>
        <button id="show" onclick="document.querySelector('#secret').type = 'text'">Show</button>
      `);
      await rememberCurrentPasswordValues(page as never, sessionId);
      await page.locator("#show").click();
      await page.locator("#secret").fill("REVEALED_BEFORE_HUMAN_TYPED");
      observeBrowserSensitiveValue(sessionId, "REVEALED_BEFORE_HUMAN_TYPED", "active-input-value");

      const raw = await page.locator("body").ariaSnapshot({ mode: "ai" });
      assert.match(raw, /REVEALED_BEFORE_HUMAN_TYPED/);
      const semanticRedaction = await redactPasswordInputsFromSnapshot(
        page as never,
        sessionId,
        raw,
      );
      assert.doesNotMatch(
        redactVaultSensitiveText(sessionId, semanticRedaction),
        /REVEALED_BEFORE_HUMAN_TYPED/,
      );
    } finally {
      clearVaultSensitiveValuesForSession(sessionId);
      await browser.close();
    }
  });
});
