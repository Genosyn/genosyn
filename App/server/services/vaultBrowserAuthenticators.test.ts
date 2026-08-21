import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { afterEach, describe, test } from "node:test";

import { chromium } from "playwright-core";
import QRCode from "qrcode";

import type { VaultPasskeyCredential } from "./vault.js";
import {
  activateVaultPasskeyAuthenticator,
  clearVaultPasskeyAuthenticator,
  clickAndActivateVaultPasskey,
  decodeQrFromImage,
  decodeTotpQrFromPng,
  findTotpSetupKeyInText,
  installVaultPasskeyGate,
  prepareVaultPasskeyAuthentication,
  prepareVaultPasskeyRegistration,
  redactUncapturedTotpValues,
  textSuggestsTotpEnrollment,
  transcodeImageToJpeg,
} from "./vaultBrowserAuthenticators.js";

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

const sessionIds = new Set<string>();

afterEach(async () => {
  await Promise.all([...sessionIds].map((sessionId) => clearVaultPasskeyAuthenticator(sessionId)));
  sessionIds.clear();
});

describe("Vault TOTP browser capture", () => {
  test("decodes QR-only otpauth enrollment without exposing it", async () => {
    const uri = "otpauth://totp/Example%3Aops%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example";
    const png = await QRCode.toBuffer(uri, { width: 320, margin: 2, errorCorrectionLevel: "M" });
    assert.equal(await decodeTotpQrFromPng(png), uri);
    const jpeg = await transcodeImageToJpeg(png, 60);
    assert.equal(await decodeQrFromImage(jpeg), uri);
  });

  test("finds and redacts text setup keys and URIs", () => {
    const key = "JBSW Y3DP EHPK 3PXP";
    assert.equal(findTotpSetupKeyInText(`Authenticator setup key: ${key}`), "JBSWY3DPEHPK3PXP");
    const text = "Open otpauth://totp/Example:user?secret=JBSWY3DPEHPK3PXP&issuer=Example now";
    const redacted = redactUncapturedTotpValues(text);
    assert.doesNotMatch(redacted, /JBSWY3DPEHPK3PXP/);
    assert.match(redacted, /redacted authenticator setup URI/);
    assert.doesNotMatch(
      redactUncapturedTotpValues("otpauth%3A%2F%2Ftotp%2FExample%3Fsecret%3DJBSWY3DPEHPK3PXP"),
      /JBSWY3DPEHPK3PXP/,
    );
    assert.doesNotMatch(
      redactUncapturedTotpValues("Manual value JBSW Y3DP EHPK 3PXP", true),
      /JBSW Y3DP EHPK 3PXP/,
    );
    assert.equal(textSuggestsTotpEnrollment("Scan this QR with your authenticator app"), true);
  });

  test("rejects oversized image headers before allocating decoded pixels", async () => {
    const pngHeader = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(pngHeader);
    pngHeader.writeUInt32BE(5000, 16);
    pngHeader.writeUInt32BE(5000, 20);
    await assert.rejects(decodeQrFromImage(pngHeader), /too large/);
  });
});

class FakeCdp {
  readonly calls: Array<{ method: string; params?: unknown }> = [];
  readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  credentials: unknown[] = [];
  failAddAuthenticator = false;
  failAddCredential = false;
  addAuthenticatorDelay: Promise<void> | null = null;
  removeAuthenticatorDelay: Promise<void> | null = null;
  onRemoveAuthenticator: (() => void) | null = null;
  enabled = false;
  activeAuthenticators = 0;
  maximumActiveAuthenticators = 0;

  async send(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "WebAuthn.enable") {
      this.enabled = true;
      return {};
    }
    if (method === "WebAuthn.addVirtualAuthenticator") {
      await this.addAuthenticatorDelay;
      if (this.failAddAuthenticator) {
        throw new Error("simulated addVirtualAuthenticator failure");
      }
      this.activeAuthenticators += 1;
      this.maximumActiveAuthenticators = Math.max(
        this.maximumActiveAuthenticators,
        this.activeAuthenticators,
      );
      return {
        authenticatorId: `auth-${this.calls.filter((call) => call.method === method).length}`,
      };
    }
    if (method === "WebAuthn.removeVirtualAuthenticator") {
      this.onRemoveAuthenticator?.();
      await this.removeAuthenticatorDelay;
      this.activeAuthenticators -= 1;
      return {};
    }
    if (method === "WebAuthn.disable") {
      this.enabled = false;
      return {};
    }
    if (method === "WebAuthn.addCredential" && this.failAddCredential) {
      throw new Error("simulated addCredential failure");
    }
    if (method === "WebAuthn.getCredentials") return { credentials: this.credentials };
    return {};
  }

  on(event: string, listener: (payload: unknown) => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: string, listener: (payload: unknown) => void): void {
    const listeners = this.listeners.get(event);
    listeners?.delete(listener);
    if (listeners?.size === 0) this.listeners.delete(event);
  }

  emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

const storedPasskey: VaultPasskeyCredential = {
  id: "00000000-0000-4000-8000-000000000001",
  credentialId: "Y3JlZGVudGlhbA==",
  isResidentCredential: true,
  rpId: "example.com",
  privateKey: "cHJpdmF0ZS1rZXk=",
  userHandle: "dXNlci0x",
  signCount: 1,
  backupEligibility: false,
  backupState: false,
  userName: "ops@example.com",
  userDisplayName: "Ops",
  createdAt: "2026-08-21T00:00:00.000Z",
  lastUsedAt: null,
};

describe("Vault virtual passkey authenticator", () => {
  test("captures the one credential created after preparation", async () => {
    const sessionId = "registration-session";
    sessionIds.add(sessionId);
    const cdp = new FakeCdp();
    const prepared = await prepareVaultPasskeyRegistration(
      sessionId,
      cdp,
      "https://accounts.example.com",
    );
    cdp.emit("WebAuthn.credentialAdded", {
      authenticatorId: "auth-1",
      credential: { ...storedPasskey, id: undefined, createdAt: undefined, lastUsedAt: undefined },
    });
    const credential = await prepared.credential;
    assert.equal(credential.privateKey, storedPasskey.privateKey);
    assert.equal(credential.rpId, "example.com");
    assert.equal(JSON.stringify(cdp.calls).includes(storedPasskey.privateKey), false);
  });

  test("rehydrates a credential, returns its asserted counter, and removes browser access", async () => {
    const sessionId = "authentication-session";
    sessionIds.add(sessionId);
    const cdp = new FakeCdp();
    const prepared = await prepareVaultPasskeyAuthentication({
      sessionId,
      cdp,
      expectedOrigin: "https://accounts.example.com",
      credential: storedPasskey,
    });
    cdp.emit("WebAuthn.credentialAsserted", {
      authenticatorId: "auth-1",
      credential: { ...storedPasskey, signCount: 2 },
    });
    const asserted = await prepared.assertion;
    assert.equal(asserted.signCount, 2);
    assert.equal(cdp.activeAuthenticators, 0);
    const add = cdp.calls.find((call) => call.method === "WebAuthn.addCredential");
    assert.match(JSON.stringify(add), /cHJpdmF0ZS1rZXk=/);
  });

  test("contains malformed assertion failures in the caller-visible promise", async () => {
    const sessionId = "assertion-failure-session";
    sessionIds.add(sessionId);
    const cdp = new FakeCdp();
    const prepared = await prepareVaultPasskeyAuthentication({
      sessionId,
      cdp,
      expectedOrigin: "https://accounts.example.com",
      credential: storedPasskey,
    });
    cdp.emit("WebAuthn.credentialAsserted", {
      authenticatorId: "auth-1",
      credential: { ...storedPasskey, privateKey: "", signCount: 2 },
    });
    await assert.rejects(prepared.assertion, /incomplete/);
  });

  test("removes the authenticator when Chrome rejects credential hydration", async () => {
    const sessionId = "hydration-failure-session";
    sessionIds.add(sessionId);
    const cdp = new FakeCdp();
    cdp.failAddCredential = true;
    await assert.rejects(
      prepareVaultPasskeyAuthentication({
        sessionId,
        cdp,
        expectedOrigin: "https://accounts.example.com",
        credential: storedPasskey,
      }),
      /simulated addCredential failure/,
    );
    assert.equal(cdp.activeAuthenticators, 0);
  });

  test("disables WebAuthn when Chrome cannot create a virtual authenticator", async () => {
    const sessionId = "authenticator-setup-failure-session";
    sessionIds.add(sessionId);
    const cdp = new FakeCdp();
    cdp.failAddAuthenticator = true;
    await assert.rejects(
      prepareVaultPasskeyRegistration(sessionId, cdp, "https://accounts.example.com"),
      /simulated addVirtualAuthenticator failure/,
    );
    assert.equal(cdp.enabled, false);
    assert.equal(cdp.activeAuthenticators, 0);
  });

  test("removes a rehydrated passkey when the top frame leaves its exact origin", async () => {
    const sessionId = "origin-bound-session";
    sessionIds.add(sessionId);
    const cdp = new FakeCdp();
    const prepared = await prepareVaultPasskeyAuthentication({
      sessionId,
      cdp,
      expectedOrigin: "https://accounts.example.com",
      credential: storedPasskey,
    });
    cdp.emit("Page.frameNavigated", {
      frame: { id: "main", url: "https://shop.example.com/sign-in" },
    });
    await assert.rejects(prepared.assertion, /ended before Chrome asserted/);
    assert.equal(cdp.activeAuthenticators, 0);
  });

  test("serializes concurrent per-session preparations without orphaning authenticators", async () => {
    const sessionId = "concurrent-session";
    sessionIds.add(sessionId);
    const cdp = new FakeCdp();
    await Promise.all([
      prepareVaultPasskeyRegistration(sessionId, cdp, "https://accounts.example.com"),
      prepareVaultPasskeyRegistration(sessionId, cdp, "https://accounts.example.com"),
    ]);
    assert.equal(cdp.maximumActiveAuthenticators, 1);
    assert.equal(cdp.activeAuthenticators, 1);
    await clearVaultPasskeyAuthenticator(sessionId);
    assert.equal(cdp.activeAuthenticators, 0);
  });

  test("a stale cleanup token cannot remove a newer per-session authenticator", async () => {
    const sessionId = "stale-cleanup-session";
    sessionIds.add(sessionId);
    const cdp = new FakeCdp();
    const first = await prepareVaultPasskeyRegistration(
      sessionId,
      cdp,
      "https://accounts.example.com",
    );
    const second = await prepareVaultPasskeyRegistration(
      sessionId,
      cdp,
      "https://accounts.example.com",
    );
    await clearVaultPasskeyAuthenticator(sessionId, first.stateId);
    assert.equal(cdp.activeAuthenticators, 1);
    await clearVaultPasskeyAuthenticator(sessionId, second.stateId);
    assert.equal(cdp.activeAuthenticators, 0);
  });

  test("a stale ceremony token cannot enable presence on a replacement authenticator", async () => {
    const sessionId = "stale-presence-session";
    sessionIds.add(sessionId);
    const cdp = new FakeCdp();
    const first = await prepareVaultPasskeyRegistration(
      sessionId,
      cdp,
      "https://accounts.example.com",
    );
    const second = await prepareVaultPasskeyRegistration(
      sessionId,
      cdp,
      "https://accounts.example.com",
    );
    await assert.rejects(
      activateVaultPasskeyAuthenticator(sessionId, first.stateId),
      /no longer active/,
    );
    await activateVaultPasskeyAuthenticator(sessionId, second.stateId);
    const enablePresence = cdp.calls.filter(
      (call) => call.method === "WebAuthn.setAutomaticPresenceSimulation",
    );
    assert.equal(enablePresence.length, 1);
    assert.deepEqual(enablePresence[0]?.params, {
      authenticatorId: "auth-2",
      enabled: true,
    });
  });

  test("serializes assertion cleanup before enabling a replacement authenticator", async () => {
    const sessionId = "assertion-replacement-session";
    sessionIds.add(sessionId);
    const cdp = new FakeCdp();
    let enteredRemoval!: () => void;
    let releaseRemoval!: () => void;
    const removalEntered = new Promise<void>((resolve) => {
      enteredRemoval = resolve;
    });
    cdp.removeAuthenticatorDelay = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    cdp.onRemoveAuthenticator = enteredRemoval;
    const authentication = await prepareVaultPasskeyAuthentication({
      sessionId,
      cdp,
      expectedOrigin: "https://accounts.example.com",
      credential: storedPasskey,
    });
    cdp.emit("WebAuthn.credentialAsserted", {
      authenticatorId: "auth-1",
      credential: { ...storedPasskey, signCount: 2 },
    });
    await removalEntered;
    const replacement = prepareVaultPasskeyRegistration(
      sessionId,
      cdp,
      "https://accounts.example.com",
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cdp.activeAuthenticators, 1);
    releaseRemoval();
    await authentication.assertion;
    const prepared = await replacement;
    assert.equal(cdp.enabled, true);
    assert.equal(cdp.activeAuthenticators, 1);
    await clearVaultPasskeyAuthenticator(sessionId, prepared.stateId);
  });

  test("completes registration and a later assertion in real Chromium", async (t) => {
    const executablePath = chromiumExecutablePath();
    if (!executablePath) {
      t.skip("No Chromium executable is available for the WebAuthn ceremony test");
      return;
    }
    const browser = await chromium.launch({ headless: true, executablePath });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    await installVaultPasskeyGate(context as never);
    const page = await context.newPage();
    const sessionId = "real-chromium-session";
    sessionIds.add(sessionId);
    try {
      await page.route("https://accounts.example.test/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `
            <button id="register">Create passkey</button>
            <button id="login">Use passkey</button>
            <script>
              const bytes = (value) => new TextEncoder().encode(value);
              document.querySelector('#register').addEventListener('click', async () => {
                try {
                  document.body.dataset.registration = 'started';
                  await navigator.credentials.create({ publicKey: {
                    challenge: bytes('registration-challenge-32-bytes'),
                    rp: { id: 'example.test', name: 'Example' },
                    user: { id: bytes('user-1'), name: 'ops@example.test', displayName: 'Ops' },
                    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
                    authenticatorSelection: {
                      residentKey: 'required',
                      requireResidentKey: true,
                      userVerification: 'required'
                    },
                    timeout: 10000,
                  }});
                  document.body.dataset.registration = 'ok';
                } catch { document.body.dataset.registration = 'failed'; }
              });
              document.querySelector('#login').addEventListener('click', async () => {
                try {
                  document.body.dataset.authentication = 'started';
                  await navigator.credentials.get({ publicKey: {
                    challenge: bytes('authentication-challenge-32bytes'),
                    rpId: 'example.test',
                    userVerification: 'required',
                    timeout: 10000,
                  }});
                  document.body.dataset.authentication = 'ok';
                } catch { document.body.dataset.authentication = 'failed'; }
              });
            </script>
          `,
        }),
      );
      await page.route("https://shop.example.test/**", (route) =>
        route.fulfill({ contentType: "text/html", body: "<h1>Different exact origin</h1>" }),
      );
      await page.goto("https://accounts.example.test/register");
      const cdp = await context.newCDPSession(page);
      const registration = await prepareVaultPasskeyRegistration(
        sessionId,
        cdp as never,
        "https://accounts.example.test",
      );
      const ambientCreate = await page.evaluate(async () => {
        try {
          await Object.getPrototypeOf(navigator.credentials).create.call(navigator.credentials, {
            publicKey: {
              rp: { id: "example.test", name: "Ambient request" },
              user: {
                id: new TextEncoder().encode("ambient-registration-user"),
                name: "ambient@example.test",
                displayName: "Ambient request",
              },
              challenge: new TextEncoder().encode("ambient-registration-challenge"),
              pubKeyCredParams: [{ type: "public-key", alg: -7 }],
              timeout: 1_000,
            },
          });
          return "resolved";
        } catch (error) {
          return error instanceof DOMException ? error.name : "unknown";
        }
      });
      assert.equal(ambientCreate, "NotAllowedError");
      const registrationButton = await page.locator("#register").elementHandle();
      assert.ok(registrationButton);
      await clickAndActivateVaultPasskey(
        page as never,
        registrationButton as never,
        sessionId,
        registration.stateId,
        10_000,
      );
      const created = await registration.credential;
      await page.waitForFunction(() => document.body.dataset.registration !== undefined);
      assert.equal(await page.locator("body").getAttribute("data-registration"), "ok");
      assert.equal(created.rpId, "example.test");
      assert.ok(created.privateKey.length > 20);
      await clearVaultPasskeyAuthenticator(sessionId, registration.stateId);

      const authentication = await prepareVaultPasskeyAuthentication({
        sessionId,
        cdp: cdp as never,
        expectedOrigin: "https://accounts.example.test",
        credential: {
          ...created,
          id: "00000000-0000-4000-8000-000000000099",
          createdAt: "2026-08-21T00:00:00.000Z",
          lastUsedAt: null,
        },
      });
      const ambientGet = await page.evaluate(async () => {
        try {
          await navigator.credentials.get({
            publicKey: {
              challenge: new TextEncoder().encode("ambient-authentication-challenge"),
              rpId: "example.test",
              userVerification: "required",
              timeout: 1_000,
            },
          });
          return "resolved";
        } catch (error) {
          return error instanceof DOMException ? error.name : "unknown";
        }
      });
      assert.equal(ambientGet, "NotAllowedError");
      const authenticationButton = await page.locator("#login").elementHandle();
      assert.ok(authenticationButton);
      await clickAndActivateVaultPasskey(
        page as never,
        authenticationButton as never,
        sessionId,
        authentication.stateId,
        10_000,
      );
      await page.waitForFunction(
        () =>
          document.body.dataset.authentication === "ok" ||
          document.body.dataset.authentication === "failed",
      );
      assert.equal(await page.locator("body").getAttribute("data-authentication"), "ok");
      const asserted = await authentication.assertion;
      assert.ok(asserted.signCount > created.signCount);

      const navigationBound = await prepareVaultPasskeyAuthentication({
        sessionId,
        cdp: cdp as never,
        expectedOrigin: "https://accounts.example.test",
        credential: {
          ...asserted,
          id: "00000000-0000-4000-8000-000000000099",
          createdAt: "2026-08-21T00:00:00.000Z",
          lastUsedAt: null,
        },
      });
      await page.goto("https://shop.example.test/");
      await assert.rejects(navigationBound.assertion, /ended before Chrome asserted/);
    } finally {
      await clearVaultPasskeyAuthenticator(sessionId);
      await context.close();
      await browser.close();
    }
  });
});
