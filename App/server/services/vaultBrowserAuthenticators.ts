import { createCanvas, loadImage } from "@napi-rs/canvas";
import jsQR from "jsqr";

import type { VaultPasskeyCredential } from "./vault.js";

type BrowserElementHandle = {
  evaluate: <T>(fn: (element: Element) => T) => Promise<T>;
  screenshot: (options: { type: "png" }) => Promise<Buffer>;
};

type BrowserPasskeyClickHandle = {
  evaluate: <T, Arg = undefined>(fn: (element: Element, arg: Arg) => T, arg?: Arg) => Promise<T>;
  click: (options: { timeout: number; noWaitAfter: true }) => Promise<void>;
};

type BrowserPasskeyGateContext = {
  addInitScript: (script: { content: string }) => Promise<void>;
};

type BrowserPasskeyGatePage = {
  context: () => BrowserPasskeyGateContext;
};

type CdpSession = {
  send: (method: string, params?: unknown) => Promise<unknown>;
  on?: (event: string, listener: (payload: unknown) => void) => void;
  off?: (event: string, listener: (payload: unknown) => void) => void;
};

type CdpCredential = Omit<VaultPasskeyCredential, "id" | "createdAt" | "lastUsedAt">;

type RegistrationState = {
  mode: "registration";
  stateId: string;
  cdp: CdpSession;
  authenticatorId: string;
  addedListener: (payload: unknown) => void;
  navigationListener: (payload: unknown) => void;
  expiryTimer: NodeJS.Timeout;
  settled: boolean;
  resolveCredential: (credential: CdpCredential) => void;
  rejectCredential: (error: Error) => void;
};

type AuthenticationState = {
  mode: "authentication";
  stateId: string;
  cdp: CdpSession;
  authenticatorId: string;
  assertedListener: (payload: unknown) => void;
  navigationListener: (payload: unknown) => void;
  expiryTimer: NodeJS.Timeout;
  settled: boolean;
  resolveAssertion: (credential: CdpCredential) => void;
  rejectAssertion: (error: Error) => void;
};

type AuthenticatorState = RegistrationState | AuthenticationState;

const authenticatorStates = new Map<string, AuthenticatorState>();
const sessionOperationTails = new Map<string, Promise<void>>();
const vaultPasskeyGateTokens = new WeakMap<object, string>();
const VAULT_PASSKEY_GATE_KEY = "__genosynVaultPasskeyGateV1";

function vaultPasskeyGateInitScript(token: string): string {
  return `(() => {
    const gateKey = ${JSON.stringify(VAULT_PASSKEY_GATE_KEY)};
    const gateToken = ${JSON.stringify(token)};
    const credentials = navigator.credentials;
    if (!credentials || Object.prototype.hasOwnProperty.call(globalThis, gateKey)) return;
    const originalCreate = credentials.create;
    const originalGet = credentials.get;
    if (typeof originalCreate !== "function" || typeof originalGet !== "function") return;
    const reflectApply = Reflect.apply;
    const nativePromise = Promise;
    const originalPromiseReject = Promise.reject;
    const NativeDOMException = DOMException;
    const originalComposedPath = Event.prototype.composedPath;
    const originalArrayIncludes = Array.prototype.includes;
    const originalDateNow = Date.now;
    const now = () => reflectApply(originalDateNow, null, []);
    const credentialsPrototype = Object.getPrototypeOf(credentials);
    let active = null;
    const blocked = () => reflectApply(originalPromiseReject, nativePromise, [
      new NativeDOMException(
        "Public-key credentials in this browser must use the bound Vault passkey action",
        "NotAllowedError",
      ),
    ]);
    const control = (providedToken, command, element) => {
      if (providedToken !== gateToken || !command || typeof command !== "object") return false;
      if (command.kind === "arm") {
        if (!(element instanceof Element) || !element.isConnected) return false;
        if (command.mode !== "create" && command.mode !== "get") return false;
        const timeoutMs = Number.isFinite(command.timeoutMs)
          ? Math.max(1_000, Math.min(30_000, Math.trunc(command.timeoutMs)))
          : 10_000;
        active = {
          id: command.id,
          mode: command.mode,
          element,
          clicked: false,
          consumed: false,
          timeoutMs,
          expiresAt: now() + timeoutMs,
        };
        return true;
      }
      if (!active || active.id !== command.id) return false;
      if (command.kind === "status") {
        return { clicked: active.clicked, consumed: active.consumed };
      }
      if (command.kind === "disarm") {
        active = null;
        return true;
      }
      return false;
    };
    window.addEventListener("click", (event) => {
      if (!active || active.consumed || !event.isTrusted || now() > active.expiresAt) return;
      const eventPath = reflectApply(originalComposedPath, event, []);
      if (!reflectApply(originalArrayIncludes, eventPath, [active.element])) return;
      active.clicked = true;
      active.expiresAt = now() + active.timeoutMs;
    }, true);
    const guarded = (mode, original) => function(options) {
      // Credential options are page-owned objects. They can be Proxies whose
      // has trap hides publicKey from a preflight check while their get
      // trap exposes it to native WebIDL conversion. Gate every create/get
      // invocation so no ambient native credential request can bypass the
      // one-shot trusted-click boundary through option-shape trickery.
      const current = active;
      if (
        !current ||
        current.mode !== mode ||
        !current.clicked ||
        current.consumed ||
        now() > current.expiresAt
      ) {
        return blocked();
      }
      current.consumed = true;
      return reflectApply(original, credentials, [options]);
    };
    const guardedCreate = guarded("create", originalCreate);
    const guardedGet = guarded("get", originalGet);
    for (const target of [credentialsPrototype, credentials]) {
      Object.defineProperties(target, {
        create: {
          value: guardedCreate,
          configurable: false,
          enumerable: false,
          writable: false,
        },
        get: {
          value: guardedGet,
          configurable: false,
          enumerable: false,
          writable: false,
        },
      });
    }
    // Publish the token-protected controller last. If Chrome ever makes the
    // CredentialsContainer methods non-overridable, the route sees no gate
    // and fails closed instead of enabling a virtual authenticator unguarded.
    Object.defineProperty(globalThis, gateKey, {
      value: control,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  })();`;
}

/**
 * Install the main-world WebAuthn gate before any website script runs. The
 * App-owned browser otherwise has no way to distinguish the selected control's
 * ceremony from a request a page started before the Vault credential arrived.
 */
export async function installVaultPasskeyGate(context: BrowserPasskeyGateContext): Promise<void> {
  if (vaultPasskeyGateTokens.has(context as object)) return;
  const token = crypto.randomUUID();
  await context.addInitScript({ content: vaultPasskeyGateInitScript(token) });
  vaultPasskeyGateTokens.set(context as object, token);
}

async function withSessionOperation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = sessionOperationTails.get(sessionId);
  sessionOperationTails.set(sessionId, current);
  if (previous) await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (sessionOperationTails.get(sessionId) === current) {
      sessionOperationTails.delete(sessionId);
    }
  }
}

function originOf(value: string): string | null {
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return null;
  }
}

function mainFrameLeftOrigin(payload: unknown, expectedOrigin: string): boolean {
  if (!payload || typeof payload !== "object") return false;
  const frame = (payload as { frame?: unknown }).frame;
  if (!frame || typeof frame !== "object") return false;
  const details = frame as { parentId?: unknown; url?: unknown };
  if (typeof details.parentId === "string" && details.parentId) return false;
  return typeof details.url !== "string" || originOf(details.url) !== originOf(expectedOrigin);
}

function cdpCredential(value: unknown): CdpCredential {
  if (!value || typeof value !== "object") throw new Error("The software passkey was unavailable");
  const credential = value as Record<string, unknown>;
  const requiredStrings = ["credentialId", "privateKey", "rpId"] as const;
  for (const field of requiredStrings) {
    if (typeof credential[field] !== "string" || credential[field].length === 0) {
      throw new Error("The software passkey was incomplete");
    }
  }
  if (typeof credential.isResidentCredential !== "boolean") {
    throw new Error("The software passkey was incomplete");
  }
  if (!Number.isSafeInteger(credential.signCount) || Number(credential.signCount) < 0) {
    throw new Error("The software passkey counter was invalid");
  }
  for (const field of ["userHandle", "largeBlob", "userName", "userDisplayName"] as const) {
    if (credential[field] !== undefined && typeof credential[field] !== "string") {
      throw new Error("The software passkey was incomplete");
    }
  }
  for (const field of ["backupEligibility", "backupState"] as const) {
    if (credential[field] !== undefined && typeof credential[field] !== "boolean") {
      throw new Error("The software passkey was incomplete");
    }
  }
  return {
    credentialId: credential.credentialId as string,
    isResidentCredential: credential.isResidentCredential,
    rpId: credential.rpId as string,
    privateKey: credential.privateKey as string,
    userHandle: credential.userHandle as string | undefined,
    signCount: Number(credential.signCount),
    largeBlob: credential.largeBlob as string | undefined,
    backupEligibility: credential.backupEligibility as boolean | undefined,
    backupState: credential.backupState as boolean | undefined,
    userName: credential.userName as string | undefined,
    userDisplayName: credential.userDisplayName as string | undefined,
  };
}

async function addVirtualAuthenticator(cdp: CdpSession): Promise<string> {
  await cdp.send("WebAuthn.enable", { enableUI: false });
  try {
    const reply = (await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        ctap2Version: "ctap2_1",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        hasLargeBlob: true,
        // The document-start gate blocks ambient WebAuthn requests. A route
        // enables presence only after revalidation and arming that gate for
        // the explicitly selected website control.
        automaticPresenceSimulation: false,
        isUserVerified: true,
      },
    })) as { authenticatorId?: unknown };
    if (typeof reply.authenticatorId !== "string" || !reply.authenticatorId) {
      throw new Error("Chrome could not create a software passkey authenticator");
    }
    return reply.authenticatorId;
  } catch (error) {
    await cdp.send("WebAuthn.disable").catch(() => undefined);
    throw error;
  }
}

async function removeAuthenticator(state: AuthenticatorState): Promise<void> {
  state.cdp.off?.("Page.frameNavigated", state.navigationListener);
  clearTimeout(state.expiryTimer);
  if (state.mode === "registration") {
    state.cdp.off?.("WebAuthn.credentialAdded", state.addedListener);
    if (!state.settled) {
      state.settled = true;
      state.rejectCredential(
        new Error("The Vault software passkey ceremony ended before Chrome created it"),
      );
    }
  } else {
    state.cdp.off?.("WebAuthn.credentialAsserted", state.assertedListener);
    if (!state.settled) {
      state.settled = true;
      state.rejectAssertion(
        new Error("The Vault software passkey ceremony ended before Chrome asserted it"),
      );
    }
  }
  await state.cdp
    .send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: state.authenticatorId })
    .catch(() => undefined);
  await state.cdp.send("WebAuthn.disable").catch(() => undefined);
}

async function clearVaultPasskeyAuthenticatorUnlocked(
  sessionId: string,
  expectedStateId?: string,
): Promise<void> {
  const state = authenticatorStates.get(sessionId);
  if (!state || (expectedStateId && state.stateId !== expectedStateId)) return;
  authenticatorStates.delete(sessionId);
  await removeAuthenticator(state);
}

async function clearMatchingVaultPasskeyAuthenticator(
  sessionId: string,
  stateId: string,
): Promise<void> {
  await withSessionOperation(sessionId, () =>
    clearVaultPasskeyAuthenticatorUnlocked(sessionId, stateId),
  );
}

export async function clearVaultPasskeyAuthenticator(
  sessionId: string,
  expectedStateId?: string,
): Promise<void> {
  await withSessionOperation(sessionId, () =>
    clearVaultPasskeyAuthenticatorUnlocked(sessionId, expectedStateId),
  );
}

export async function activateVaultPasskeyAuthenticator(
  sessionId: string,
  stateId: string,
): Promise<void> {
  await withSessionOperation(sessionId, async () => {
    const state = authenticatorStates.get(sessionId);
    if (!state || state.stateId !== stateId) {
      throw new Error("The Vault software passkey ceremony is no longer active");
    }
    await state.cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
      authenticatorId: state.authenticatorId,
      enabled: true,
    });
  });
}

export async function clickAndActivateVaultPasskey(
  page: BrowserPasskeyGatePage,
  handle: BrowserPasskeyClickHandle,
  sessionId: string,
  stateId: string,
  timeoutMs: number,
): Promise<void> {
  const context = page.context();
  const token = vaultPasskeyGateTokens.get(context as object);
  if (!token) {
    throw new Error("The App browser was not initialized for Vault software passkeys");
  }
  const authenticator = authenticatorStates.get(sessionId);
  if (!authenticator || authenticator.stateId !== stateId) {
    throw new Error("The Vault software passkey ceremony is no longer active");
  }
  const gateId = crypto.randomUUID();
  const mode = authenticator.mode === "registration" ? "create" : "get";
  const gateArgs = {
    key: VAULT_PASSKEY_GATE_KEY,
    token,
    id: gateId,
    mode,
    timeoutMs,
  };
  const armed = await handle.evaluate((element, args) => {
    const gate = (globalThis as unknown as Record<string, unknown>)[args.key];
    if (typeof gate !== "function") return false;
    return (
      gate as (
        providedToken: string,
        command: Record<string, unknown>,
        selectedElement?: Element,
      ) => unknown
    )(
      args.token,
      {
        kind: "arm",
        id: args.id,
        mode: args.mode,
        timeoutMs: args.timeoutMs,
      },
      element,
    );
  }, gateArgs);
  if (armed !== true) {
    throw new Error("The current page was not initialized for Vault software passkeys");
  }
  try {
    // Presence is enabled before the click so Chrome sees it when an async
    // site handler eventually starts WebAuthn. The document-start gate blocks
    // every public-key request until this exact selected element receives a
    // trusted click, so no earlier page request can consume the authenticator.
    await activateVaultPasskeyAuthenticator(sessionId, stateId);
    const click = handle.click({ timeout: timeoutMs, noWaitAfter: true });
    let clickFinished = false;
    let clickError: unknown;
    void click.then(
      () => {
        clickFinished = true;
      },
      (error: unknown) => {
        clickFinished = true;
        clickError = error;
      },
    );
    const deadline = Date.now() + timeoutMs + 1_000;
    let observedClick = false;
    for (;;) {
      const status = await handle
        .evaluate((_element, args) => {
          const gate = (globalThis as unknown as Record<string, unknown>)[args.key];
          if (typeof gate !== "function") return null;
          return (gate as (providedToken: string, command: Record<string, unknown>) => unknown)(
            args.token,
            { kind: "status", id: args.id },
          );
        }, gateArgs)
        .catch(() => null);
      if (status && typeof status === "object") {
        const details = status as { clicked?: unknown; consumed?: unknown };
        observedClick ||= details.clicked === true;
        if (details.consumed === true) break;
      } else if (observedClick) {
        // A successful ceremony may navigate immediately and destroy the old
        // document before the status probe. The credential event remains the
        // authoritative completion signal in the route.
        break;
      }
      if (clickFinished && clickError && !observedClick) {
        throw clickError;
      }
      if (Date.now() >= deadline) {
        await click.catch(() => undefined);
        throw new Error(
          observedClick
            ? "The selected passkey control did not start a WebAuthn ceremony in time"
            : "The selected passkey control did not receive its trusted click in time",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Navigation can make Playwright report the click as interrupted even
    // though Chrome already emitted the credential event.
    await click.catch(() => undefined);
  } finally {
    await handle
      .evaluate((_element, args) => {
        const gate = (globalThis as unknown as Record<string, unknown>)[args.key];
        if (typeof gate !== "function") return;
        (gate as (providedToken: string, command: Record<string, unknown>) => unknown)(args.token, {
          kind: "disarm",
          id: args.id,
        });
      }, gateArgs)
      .catch(() => undefined);
  }
}

export async function prepareVaultPasskeyRegistration(
  sessionId: string,
  cdp: CdpSession,
  expectedOrigin: string,
): Promise<{ stateId: string; credential: Promise<CdpCredential> }> {
  return withSessionOperation(sessionId, async () => {
    await clearVaultPasskeyAuthenticatorUnlocked(sessionId);
    // Page.frameNavigated is silent on a raw CDP session until Page is
    // enabled. Leave it enabled: the shared Browser runtime and screencast
    // also use this domain.
    await cdp.send("Page.enable");
    const authenticatorId = await addVirtualAuthenticator(cdp);
    const stateId = crypto.randomUUID();
    let resolveCredential!: (credential: CdpCredential) => void;
    let rejectCredential!: (error: Error) => void;
    const credential = new Promise<CdpCredential>((resolve, reject) => {
      resolveCredential = resolve;
      rejectCredential = reject;
    });
    void credential.catch(() => undefined);
    let handled = false;
    const addedListener = (payload: unknown) => {
      if (handled) return;
      const envelope = payload as { authenticatorId?: unknown; credential?: unknown };
      if (envelope.authenticatorId !== authenticatorId) return;
      handled = true;
      void (async () => {
        try {
          const created = cdpCredential(envelope.credential);
          await withSessionOperation(sessionId, async () => {
            const state = authenticatorStates.get(sessionId);
            if (!state || state.mode !== "registration" || state.stateId !== stateId) {
              throw new Error("The Vault software passkey ceremony is no longer active");
            }
            state.settled = true;
            authenticatorStates.delete(sessionId);
            await removeAuthenticator(state);
          });
          resolveCredential(created);
        } catch (error) {
          rejectCredential(
            error instanceof Error
              ? error
              : new Error("Chrome could not finish creating the Vault software passkey"),
          );
          await clearMatchingVaultPasskeyAuthenticator(sessionId, stateId);
        }
      })().catch(() => undefined);
    };
    const navigationListener = (payload: unknown) => {
      if (mainFrameLeftOrigin(payload, expectedOrigin)) {
        void clearMatchingVaultPasskeyAuthenticator(sessionId, stateId).catch(() => undefined);
      }
    };
    cdp.on?.("WebAuthn.credentialAdded", addedListener);
    cdp.on?.("Page.frameNavigated", navigationListener);
    const expiryTimer = setTimeout(() => {
      void clearMatchingVaultPasskeyAuthenticator(sessionId, stateId).catch(() => undefined);
    }, 20_000);
    expiryTimer.unref?.();
    authenticatorStates.set(sessionId, {
      mode: "registration",
      stateId,
      cdp,
      authenticatorId,
      addedListener,
      navigationListener,
      expiryTimer,
      settled: false,
      resolveCredential,
      rejectCredential,
    });
    return { stateId, credential };
  });
}

export async function prepareVaultPasskeyAuthentication(args: {
  sessionId: string;
  cdp: CdpSession;
  expectedOrigin: string;
  credential: VaultPasskeyCredential;
}): Promise<{ stateId: string; assertion: Promise<CdpCredential> }> {
  return withSessionOperation(args.sessionId, async () => {
    await clearVaultPasskeyAuthenticatorUnlocked(args.sessionId);
    await args.cdp.send("Page.enable");
    const stateId = crypto.randomUUID();
    let authenticatorId: string | null = null;
    let resolveAssertion!: (credential: CdpCredential) => void;
    let rejectAssertion!: (error: Error) => void;
    const assertion = new Promise<CdpCredential>((resolve, reject) => {
      resolveAssertion = resolve;
      rejectAssertion = reject;
    });
    // Teardown may reject while the HTTP request is being cancelled. Keep the
    // caller-visible rejection while ensuring Node never sees it unhandled.
    void assertion.catch(() => undefined);
    try {
      authenticatorId = await addVirtualAuthenticator(args.cdp);
      let handled = false;
      const assertedListener = (payload: unknown) => {
        if (handled) return;
        const envelope = payload as { authenticatorId?: unknown; credential?: unknown };
        if (envelope.authenticatorId !== authenticatorId) return;
        handled = true;
        void (async () => {
          try {
            const credential = cdpCredential(envelope.credential);
            await withSessionOperation(args.sessionId, async () => {
              const state = authenticatorStates.get(args.sessionId);
              if (!state || state.mode !== "authentication" || state.stateId !== stateId) {
                throw new Error("The Vault software passkey ceremony is no longer active");
              }
              // Remove browser access before counter persistence begins. The
              // Browser RPC retains the database lease separately until its
              // CAS succeeds or fails, so navigation cannot release it.
              state.settled = true;
              authenticatorStates.delete(args.sessionId);
              await removeAuthenticator(state);
            });
            resolveAssertion(credential);
          } catch (error) {
            rejectAssertion(
              error instanceof Error
                ? error
                : new Error("Chrome could not finish the Vault software passkey assertion"),
            );
            await clearMatchingVaultPasskeyAuthenticator(args.sessionId, stateId);
          }
        })().catch(() => undefined);
      };
      const navigationListener = (payload: unknown) => {
        if (mainFrameLeftOrigin(payload, args.expectedOrigin)) {
          void clearMatchingVaultPasskeyAuthenticator(args.sessionId, stateId).catch(
            () => undefined,
          );
        }
      };
      args.cdp.on?.("WebAuthn.credentialAsserted", assertedListener);
      args.cdp.on?.("Page.frameNavigated", navigationListener);
      const expiryTimer = setTimeout(() => {
        void clearMatchingVaultPasskeyAuthenticator(args.sessionId, stateId).catch(() => undefined);
      }, 20_000);
      expiryTimer.unref?.();
      authenticatorStates.set(args.sessionId, {
        mode: "authentication",
        stateId,
        cdp: args.cdp,
        authenticatorId,
        assertedListener,
        navigationListener,
        expiryTimer,
        settled: false,
        resolveAssertion,
        rejectAssertion,
      });
      const {
        id: _id,
        createdAt: _createdAt,
        lastUsedAt: _lastUsedAt,
        ...credential
      } = args.credential;
      await args.cdp.send("WebAuthn.addCredential", { authenticatorId, credential });
      return { stateId, assertion };
    } catch (error) {
      const current = authenticatorStates.get(args.sessionId);
      if (current?.stateId === stateId) {
        await clearVaultPasskeyAuthenticatorUnlocked(args.sessionId, stateId);
      } else {
        rejectAssertion(
          error instanceof Error
            ? error
            : new Error("Chrome could not hydrate the Vault software passkey"),
        );
        if (authenticatorId) {
          await args.cdp
            .send("WebAuthn.removeVirtualAuthenticator", { authenticatorId })
            .catch(() => undefined);
          await args.cdp.send("WebAuthn.disable").catch(() => undefined);
        }
      }
      throw error;
    }
  });
}

function candidateTotpValue(candidate: string): string | null {
  const decoded = candidate.replaceAll("&amp;", "&").trim();
  const uri = /otpauth:\/\/totp\/[^\s"'<>]+/i.exec(decoded)?.[0];
  if (uri) return uri;
  const label =
    /(?:authenticator\s+)?setup\s+key|(?:authenticator|totp|2fa)\s+secret(?:\s+key)?|\bsecret(?:\s+key)?\b/i.exec(
      decoded,
    );
  const labelled = label
    ? /(?:^|[^A-Z2-7])((?:[A-Z2-7][\s-]?){16,})/i.exec(
        decoded.slice(
          (label.index ?? 0) + label[0].length,
          (label.index ?? 0) + label[0].length + 240,
        ),
      )?.[1]
    : undefined;
  if (labelled) return labelled.replace(/[\s-]/g, "");
  const exact = decoded.replace(/[\s-]/g, "");
  return /^[A-Z2-7]{16,}={0,6}$/i.test(exact) ? exact : null;
}

export function findTotpSetupKeyInText(text: string): string | null {
  return candidateTotpValue(text);
}

export function textSuggestsTotpEnrollment(text: string): boolean {
  const compact = text.replace(/\s+/g, " ").slice(0, 250_000);
  return (
    /(?:authenticator|authentication|verification|one[- ]time|2fa|two[- ]factor).{0,100}(?:qr|scan|setup key|manual key|secret key)/i.test(
      compact,
    ) ||
    /(?:qr|scan|setup key|manual key).{0,100}(?:authenticator|authentication|verification|one[- ]time|2fa|two[- ]factor)/i.test(
      compact,
    )
  );
}

function imageDimensionsFromHeader(bytes: Buffer): { width: number; height: number } {
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      while (bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++];
      if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
      if (marker >= 0xd0 && marker <= 0xd7) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (
        length >= 7 &&
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        )
      ) {
        return {
          height: bytes.readUInt16BE(offset + 3),
          width: bytes.readUInt16BE(offset + 5),
        };
      }
      offset += length;
    }
  }
  throw new Error("The QR image format or dimensions were invalid");
}

const MAX_QR_IMAGE_PIXELS = 12_000_000;
const MAX_QR_IMAGE_DIMENSION = 4096;

function assertBoundedImage(bytes: Buffer): { width: number; height: number } {
  if (bytes.length === 0 || bytes.length > 20_000_000) {
    throw new Error("The QR image was too large to inspect safely");
  }
  const dimensions = imageDimensionsFromHeader(bytes);
  if (
    dimensions.width <= 0 ||
    dimensions.height <= 0 ||
    dimensions.width > MAX_QR_IMAGE_DIMENSION ||
    dimensions.height > MAX_QR_IMAGE_DIMENSION ||
    dimensions.width * dimensions.height > MAX_QR_IMAGE_PIXELS
  ) {
    throw new Error("The QR image dimensions were too large to inspect safely");
  }
  return dimensions;
}

export async function decodeQrFromImage(bytes: Buffer): Promise<string | null> {
  const expected = assertBoundedImage(bytes);
  const image = await loadImage(bytes);
  if (image.width !== expected.width || image.height !== expected.height) {
    throw new Error("The QR image dimensions changed while decoding");
  }
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height);
  const decoded = jsQR(new Uint8ClampedArray(pixels.data), image.width, image.height, {
    inversionAttempts: "attemptBoth",
  });
  return decoded ? decoded.data : null;
}

export async function decodeTotpQrFromPng(bytes: Buffer): Promise<string | null> {
  const decoded = await decodeQrFromImage(bytes);
  return decoded === null ? null : candidateTotpValue(decoded);
}

export async function transcodeImageToJpeg(bytes: Buffer, quality = 60): Promise<Buffer> {
  const expected = assertBoundedImage(bytes);
  const image = await loadImage(bytes);
  if (image.width !== expected.width || image.height !== expected.height) {
    throw new Error("The screenshot dimensions changed while transcoding");
  }
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext("2d").drawImage(image, 0, 0);
  return canvas.toBuffer("image/jpeg", quality);
}

export async function readTotpSetupKeyFromElement(handle: BrowserElementHandle): Promise<string> {
  const inspected = await handle.evaluate((element) => {
    const values: string[] = [];
    const push = (value: unknown) => {
      if (typeof value === "string" && value.trim() && value.length <= 10_000) {
        values.push(value);
      }
    };
    const inspect = (candidate: Element) => {
      if (candidate instanceof HTMLInputElement || candidate instanceof HTMLTextAreaElement) {
        push(candidate.value);
      }
      push(candidate.textContent);
      for (const name of [
        "href",
        "src",
        "value",
        "title",
        "aria-label",
        "data-uri",
        "data-url",
        "data-otpauth",
        "data-secret",
      ]) {
        push(candidate.getAttribute(name));
      }
    };
    inspect(element);
    for (const descendant of Array.from(element.querySelectorAll("*")).slice(0, 200)) {
      inspect(descendant);
    }
    const rect = element.getBoundingClientRect();
    return {
      values,
      width: Math.ceil(Math.max(rect.width, element.scrollWidth)),
      height: Math.ceil(Math.max(rect.height, element.scrollHeight)),
    };
  });
  for (const candidate of inspected.values) {
    const value = candidateTotpValue(candidate);
    if (value) return value;
  }
  if (
    inspected.width <= 0 ||
    inspected.height <= 0 ||
    inspected.width > MAX_QR_IMAGE_DIMENSION ||
    inspected.height > MAX_QR_IMAGE_DIMENSION ||
    inspected.width * inspected.height > MAX_QR_IMAGE_PIXELS
  ) {
    throw new Error("The selected QR element was too large to capture safely");
  }
  const screenshot = await handle.screenshot({ type: "png" });
  const decoded = await decodeTotpQrFromPng(screenshot);
  if (decoded) return decoded;
  throw new Error(
    "The selected element did not contain a TOTP setup key or readable authenticator QR code",
  );
}

export function redactUncapturedTotpValues(text: string, aggressive = false): string {
  let redacted = text
    .replace(/otpauth:\/\/[^\s"'<>]+/gi, "[redacted authenticator setup URI]")
    .replace(/otpauth%3a%2f%2f[^\s"'<>]+/gi, "[redacted authenticator setup URI]")
    .replace(
      /((?:(?:authenticator\s+)?setup\s+key|(?:authenticator|totp|2fa)\s+secret(?:\s+key)?|\bsecret(?:\s+key)?\b)[^\n]{0,40}?)((?:[A-Z2-7][\s-]{0,2}){15,127}[A-Z2-7])/gi,
      "$1[redacted TOTP setup key]",
    );
  if (aggressive) {
    // Once a TOTP enrollment ceremony is armed, ordinary labels are not a
    // safety boundary: sites frequently render only a bare manual key. Keep
    // the pattern bounded so hostile page text cannot trigger pathological
    // matching while still covering grouped Base32 values.
    redacted = redacted.replace(
      /(?<![A-Z2-7])(?:[A-Z2-7][\s-]{0,2}){15,127}[A-Z2-7](?![A-Z2-7])/gi,
      "[redacted TOTP setup key]",
    );
  }
  return redacted;
}
