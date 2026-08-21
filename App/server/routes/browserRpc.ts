import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { BrowserSession } from "../db/entities/BrowserSession.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { MemberBrowser } from "../db/entities/MemberBrowser.js";
import type { VaultItemType } from "../db/entities/VaultItem.js";
import { validateBody } from "../middleware/validate.js";
import {
  resolveBrowserSessionToken,
  beginBrowserRpcActivity,
  markSessionLive,
  observeRuntimePasswordValues,
  registerBrowserRecordingFrameInspector,
  registerBrowserSessionCleanup,
  registerBrowserSensitiveValueListener,
} from "../services/browserSessions.js";
import {
  acquirePage,
  releasePage,
  getRuntime,
  markActivity,
  pushSessionNotice,
  takeSessionNotices,
  awaitAdoption,
} from "../services/browserChromium.js";
import { recordAudit } from "../services/audit.js";
import {
  beginVaultPasskeyRegistrationForEmployee,
  createVaultLoginForEmployee,
  finalizeVaultPasskeyRegistrationForEmployee,
  getVaultPasskeyForEmployee,
  getVaultItemPayloadForEmployee,
  getVaultTotpCodeForEmployee,
  recordVaultPasskeyUseForEmployee,
  releaseVaultPasskeyRegistrationForEmployee,
  releaseVaultPasskeyUseForEmployee,
  setVaultTotpForEmployee,
  VaultError,
} from "../services/vault.js";
import {
  clickAndActivateVaultPasskey,
  clearVaultPasskeyAuthenticator,
  decodeQrFromImage,
  findTotpSetupKeyInText,
  prepareVaultPasskeyAuthentication,
  prepareVaultPasskeyRegistration,
  readTotpSetupKeyFromElement,
  redactUncapturedTotpValues,
  textSuggestsTotpEnrollment,
  transcodeImageToJpeg,
} from "../services/vaultBrowserAuthenticators.js";
import {
  BrowserApprovalError,
  claimBrowserActionApproval,
  computeBrowserActionTargetFingerprint,
  settleBrowserActionApproval,
  type BrowserActionPayload,
  type BrowserApprovalTargetDescriptor,
} from "../services/approvals.js";
import {
  browserAccessEnabledForSession,
  closeBrowserSessionForPolicy,
} from "../services/browserAccess.js";
import { memberBrowserUrlAllowed } from "../services/memberBrowsers.js";
import { parseAllowList, urlAllowed } from "../services/browserHostPolicy.js";
import { restrictBrowserRecording } from "../services/browserRecordings.js";

/**
 * Internal HTTP surface called by the stripped-down `browser` MCP child.
 *
 * Each browser tool the AI invokes (`browser_open`, `browser_click`, …)
 * round-trips here as a POST. The App owns the headless Chromium, so the
 * MCP child stays a thin protocol translator — Chromium persists across
 * MCP spawns / chat turns, which is what makes "I'll wait while you drop
 * your credentials in" actually work.
 *
 * Snapshots are Playwright aria snapshots in `ai` mode: a YAML outline of
 * the page in which every interactive element carries a `[ref=eN]` marker.
 * The model acts on those refs directly (`aria-ref=e12` as the selector),
 * which resolves instantly and unambiguously — no CSS guessing. Refs stay
 * valid until the next snapshot replaces them, and every action returns a
 * fresh snapshot, so the refs the model sees are always current.
 *
 * Auth: bearer token = `BrowserSession.mcpToken` (per-session). The
 * resolved session id is stamped on the request for downstream handlers.
 *
 * Mounted at `/api/internal/browser/sessions/:id/`. The session-id
 * segment is redundant with the bearer token (which already implies the
 * session) but appears in the URL so the routes read naturally and
 * accidental token reuse across sessions surfaces as a 403.
 */

export const browserRpcRouter = Router({ mergeParams: true });

type BrowserRpcReq = Request<{ id: string }> & {
  browserSession?: BrowserSession;
  browserEmployee?: AIEmployee;
  /** The Member's browser this session drives, or null for App Chromium. */
  memberBrowser?: MemberBrowser | null;
  /** Employee policy OR browser policy — resolved once, in the middleware. */
  approvalRequired?: boolean;
  /** Lease proving this handler crossed the Run-finalization boundary first. */
  browserRpcAllowsFinalizingRun?: boolean;
};

const SNAPSHOT_MAX_LINES = 400;
const TEXT_MAX_BYTES = 8 * 1024;
/** Navigation budget (goto / goBack) — pages can genuinely be slow. */
const NAV_TIMEOUT_MS = 30_000;
/**
 * How long a selector gets to match a visible element. Kept short on
 * purpose: a wrong guess should fail in seconds, not eat a 30s navigation
 * budget — the model recovers by reading the snapshot in the error and
 * picking a real ref. `browser_wait` exists for genuinely slow content.
 */
const LOCATE_TIMEOUT_MS = 5_000;
/** Actionability budget once the element exists (scroll into view, enabled…). */
const ACTION_TIMEOUT_MS = 10_000;
const ARIA_SNAPSHOT_TIMEOUT_MS = 5_000;
const WAIT_MAX_MS = 15_000;
/** Hard ceiling on the post-action settle, enforced Node-side (page.evaluate
 *  itself is ungoverned by any Playwright timeout — a page that blocks its
 *  main thread would otherwise wedge the tool call forever). */
const SETTLE_CAP_MS = 2_000;
/** How long an action waits for a popup it opened to be adopted. Slightly
 *  above adoptPage's own 5s load wait so a just-loaded popup is reflected. */
const ADOPTION_WAIT_MS = 5_500;
const MAX_TRACKED_VAULT_VALUES_PER_SESSION = 64;
const vaultSensitiveValuesBySession = new Map<string, Map<string, number>>();
const vaultTaintedSessions = new Set<string>();
const vaultSensitiveOverflowSessions = new Set<string>();
const vaultTotpArmedSessions = new Set<string>();
const vaultTotpCodesBySession = new Map<string, Map<string, number>>();
const vaultTotpCaptureBindings = new Map<
  string,
  { companyId: string; employeeId: string; itemId: string; origin: string }
>();

async function requireBrowserSession(req: BrowserRpcReq, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const token = match?.[1]?.trim();
  if (!token) return res.status(401).json({ error: "Missing bearer token" });
  const sessionId = await resolveBrowserSessionToken(token);
  if (!sessionId) return res.status(401).json({ error: "Invalid token" });
  if (sessionId !== req.params.id) {
    return res.status(403).json({ error: "Token does not match session id" });
  }
  const repo = AppDataSource.getRepository(BrowserSession);
  const row = await repo.findOneBy({ id: sessionId });
  if (!row) return res.status(404).json({ error: "Session not found" });
  if (row.status === "closed" || row.status === "expired") {
    clearVaultSensitiveValuesForSession(sessionId);
    return res.status(410).json({ error: "Session is closed" });
  }
  if (row.mcpTokenExpiresAt.getTime() < Date.now()) {
    return res.status(401).json({ error: "Token expired" });
  }
  const emp = await AppDataSource.getRepository(AIEmployee).findOneBy({ id: row.employeeId });
  if (!emp) return res.status(404).json({ error: "Employee not found" });
  if (!(await browserAccessEnabledForSession(row, emp))) {
    await closeBrowserSessionForPolicy(sessionId);
    return res.status(403).json({ error: "Browser access is disabled for this AI Employee" });
  }
  const memberBrowser = row.memberBrowserId
    ? await AppDataSource.getRepository(MemberBrowser).findOneBy({ id: row.memberBrowserId })
    : null;
  const releaseActivity = beginBrowserRpcActivity(row);
  if (!releaseActivity) {
    return res.status(409).json({ error: "This browser session is finalizing" });
  }
  let activityReleased = false;
  const releaseOnce = () => {
    if (activityReleased) return;
    activityReleased = true;
    releaseActivity();
  };
  const originalEnd = res.end;
  res.end = function (this: Response, ...args: unknown[]) {
    releaseOnce();
    return Reflect.apply(originalEnd, this, args);
  } as typeof res.end;
  res.once("finish", releaseOnce);
  req.browserSession = row;
  req.browserEmployee = emp;
  req.memberBrowser = memberBrowser;
  req.approvalRequired = browserApprovalRequiredForSession(emp, memberBrowser);
  req.browserRpcAllowsFinalizingRun = true;
  try {
    next();
  } catch (error) {
    releaseOnce();
    throw error;
  }
}

browserRpcRouter.use(requireBrowserSession);

// ---------- helpers ----------

type Page = {
  context: () => { addInitScript: (script: { content: string }) => Promise<void> };
  url: () => string;
  title: () => Promise<string>;
  goto: (url: string, opts: unknown) => Promise<unknown>;
  goBack: (opts: unknown) => Promise<unknown>;
  locator: (sel: string) => PageLocator;
  frames: () => Array<{
    locator: (sel: string) => PageLocator;
    evaluate: <T>(fn: (() => T) | string) => Promise<T>;
  }>;
  keyboard: { press: (key: string) => Promise<void> };
  mouse: { wheel: (dx: number, dy: number) => Promise<void> };
  waitForLoadState: (state: string, opts: unknown) => Promise<void>;
  waitForTimeout: (ms: number) => Promise<void>;
  evaluate: <T>(fn: () => T) => Promise<T>;
  ariaSnapshot: (opts: { mode: "ai" | "default"; timeout?: number }) => Promise<string>;
  screenshot: (opts: unknown) => Promise<Buffer>;
};

type PageLocator = {
  first: () => Locator;
  count: () => Promise<number>;
};

type Locator = {
  waitFor: (opts: unknown) => Promise<void>;
  click: (opts: unknown) => Promise<void>;
  fill: (value: string, opts: unknown) => Promise<void>;
  inputValue: (opts?: unknown) => Promise<string>;
  getAttribute: (name: string, opts?: unknown) => Promise<string | null>;
  elementHandle: () => Promise<ElementHandle | null>;
  press: (key: string, opts: unknown) => Promise<void>;
  hover: (opts: unknown) => Promise<void>;
  selectOption: (values: unknown, opts: unknown) => Promise<string[]>;
  scrollIntoViewIfNeeded: (opts: unknown) => Promise<void>;
};

type ElementHandle = {
  evaluate: <T, Arg = undefined>(fn: (element: Element, arg: Arg) => T, arg?: Arg) => Promise<T>;
  click: (opts: unknown) => Promise<void>;
  press: (key: string, opts: unknown) => Promise<void>;
  fill: (value: string, opts: unknown) => Promise<void>;
  getAttribute: (name: string) => Promise<string | null>;
  inputValue: (opts?: unknown) => Promise<string>;
  screenshot: (opts: { type: "png" }) => Promise<Buffer>;
};

type BrowserApprovalTargetInspection = {
  handle: ElementHandle;
  descriptor: BrowserApprovalTargetDescriptor;
  fingerprint: string;
  /** Passkey ceremonies are confined to the top document. */
  isTopDocument: boolean;
  /** Returned only inside this server process and never serialized. */
  sensitiveValue: string | null;
  /** Bound second target for an approval-safe current-TOTP submission. */
  vaultTotpTarget?: {
    handle: ElementHandle;
    frameUrl: string;
    inputType: string | null;
  };
};

function safeBrowserApprovalTargetUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

export function browserKeyMaySubmit(key: string): boolean {
  const terminalKey = key
    .split("+")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .at(-1);
  return (
    terminalKey === "enter" ||
    terminalKey === "numpadenter" ||
    terminalKey === "space" ||
    terminalKey === "spacebar"
  );
}

/**
 * `keyboard.press()` accepts Playwright modifier chords such as `Control+C`
 * and `Meta+V`. Once a Vault password has been filled into the page, those
 * chords would let the model move the value through the system clipboard and
 * paste it into model-visible content. Keep the model-facing `/press` surface
 * to the small set of plain keys needed for navigation and ordinary editing.
 * Text entry belongs in `/fill`; submission remains governed separately.
 */
export const BROWSER_MODEL_PRESS_KEYS = [
  "Enter",
  "NumpadEnter",
  "Tab",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Backspace",
  "Delete",
  "Space",
  "Spacebar",
] as const;

const browserModelPressKeySet = new Set<string>(BROWSER_MODEL_PRESS_KEYS);

export function browserModelPressKeyIsAllowed(key: string): boolean {
  return browserModelPressKeySet.has(key);
}

export const browserModelPressKeySchema = z
  .string()
  .min(1)
  .max(60)
  .refine(browserModelPressKeyIsAllowed, {
    message:
      "Unsupported browser key. Modifier chords, clipboard shortcuts, and context-menu keys are not allowed.",
  });

export function browserClickMaySubmit(descriptor: BrowserApprovalTargetDescriptor): boolean {
  return descriptor.submitsForm;
}

const INSTALL_BROWSER_SUBMIT_GUARD_SCRIPT = `(() => {
  const key = "__genosynBrowserSubmitGuardV1";
  const scope = window;
  if (scope[key] && typeof scope[key].cleanup === "function") scope[key].cleanup();
  const state = { blocked: false };
  const prototype = HTMLFormElement.prototype;
  const originalSubmit = prototype.submit;
  const originalRequestSubmit = prototype.requestSubmit;
  const onSubmit = (event) => {
    state.blocked = true;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  document.addEventListener("submit", onSubmit, true);
  const guardedSubmit = function () { state.blocked = true; };
  const guardedRequestSubmit = function () { state.blocked = true; };
  prototype.submit = guardedSubmit;
  prototype.requestSubmit = guardedRequestSubmit;
  scope[key] = {
    state,
    cleanup() {
      document.removeEventListener("submit", onSubmit, true);
      if (prototype.submit === guardedSubmit) prototype.submit = originalSubmit;
      if (prototype.requestSubmit === guardedRequestSubmit) {
        prototype.requestSubmit = originalRequestSubmit;
      }
    },
  };
})()`;

const REMOVE_BROWSER_SUBMIT_GUARD_SCRIPT = `(() => {
  const key = "__genosynBrowserSubmitGuardV1";
  const guard = window[key];
  const blocked = Boolean(guard && guard.state && guard.state.blocked === true);
  if (guard && typeof guard.cleanup === "function") guard.cleanup();
  delete window[key];
  return blocked;
})()`;

/**
 * Block native `submit`, `requestSubmit`, and `form.submit()` while an
 * unapproved click/key action runs. This catches framework buttons whose DOM
 * type does not reveal that their handler submits a form. The guard lives in
 * the page realm only for the duration of one RPC action.
 */
export async function armUnapprovedFormSubmitGuard(page: Page): Promise<void> {
  await Promise.all(
    page.frames().map((frame) => frame.evaluate<void>(INSTALL_BROWSER_SUBMIT_GUARD_SCRIPT)),
  );
}

export async function disarmUnapprovedFormSubmitGuard(page: Page): Promise<boolean> {
  const results = await Promise.all(
    page
      .frames()
      .map((frame) =>
        frame.evaluate<boolean>(REMOVE_BROWSER_SUBMIT_GUARD_SCRIPT).catch(() => false),
      ),
  );
  return results.some(Boolean);
}

export async function inspectBrowserApprovalTarget(args: {
  page: Page;
  session: BrowserSession;
  employee: AIEmployee;
  action: BrowserActionPayload["action"];
  selector: string;
  key: string | null;
  handle?: ElementHandle;
  vaultTotp?: {
    handle: ElementHandle;
    itemId: string;
    selector: string;
  };
}): Promise<BrowserApprovalTargetInspection> {
  const handle =
    args.handle ??
    (await (async () => {
      const locator = await locate(args.page, args.session.id, args.selector);
      const resolved = await locator.elementHandle();
      if (!resolved) throw new BrowserApprovalError("Browser target is no longer attached", 409);
      return resolved;
    })());
  const inspected = await handle.evaluate(
    (
      element,
      context: {
        action: BrowserActionPayload["action"];
        key: string | null;
        vaultTotpElement: Element | null;
        vaultItemId: string | null;
        vaultTotpSelector: string | null;
      },
    ) => {
      const input = element instanceof HTMLInputElement ? element : null;
      const button = element instanceof HTMLButtonElement ? element : null;
      const vaultTotpInput =
        context.action === "vault_totp_submit" &&
        context.vaultTotpElement instanceof HTMLInputElement
          ? context.vaultTotpElement
          : null;
      const tagName = element.tagName.toLowerCase();
      const inputType = input
        ? input.type.toLowerCase()
        : button
          ? button.type.toLowerCase()
          : element.getAttribute("type")?.toLowerCase() || null;
      const directForm = input?.form ?? button?.form ?? element.closest("form");
      const nativeSubmitTarget = Boolean(
        directForm &&
        ((button && button.type.toLowerCase() === "submit") ||
          (input && ["submit", "image"].includes(input.type.toLowerCase()))),
      );
      const terminalKey = context.key
        ?.split("+")
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean)
        .at(-1);
      const nativeClickSubmitter = Boolean(!context.key && nativeSubmitTarget);
      const keyActivatesSubmitter = Boolean(
        context.key &&
        nativeSubmitTarget &&
        ["enter", "numpadenter", "space", "spacebar"].includes(terminalKey ?? ""),
      );
      const enterMaySubmit = Boolean(
        context.key &&
        context.key
          .split("+")
          .map((part) => part.trim().toLowerCase())
          .filter(Boolean)
          .at(-1)
          ?.match(/^(enter|numpadenter)$/) &&
        directForm,
      );
      const buttonLikeClick = Boolean(
        !context.key &&
        (button ||
          (input && ["button", "submit", "image"].includes(input.type.toLowerCase())) ||
          element.getAttribute("role")?.toLowerCase() === "button"),
      );
      const submitsForm = Boolean(
        nativeClickSubmitter || keyActivatesSubmitter || enterMaySubmit || buttonLikeClick,
      );
      const submitter =
        nativeClickSubmitter || keyActivatesSubmitter
          ? element
          : enterMaySubmit && directForm
            ? (Array.from(directForm.elements).find((candidate) => {
                if (candidate instanceof HTMLButtonElement) {
                  return !candidate.disabled && candidate.type.toLowerCase() === "submit";
                }
                return (
                  candidate instanceof HTMLInputElement &&
                  !candidate.disabled &&
                  ["submit", "image"].includes(candidate.type.toLowerCase())
                );
              }) ?? null)
            : null;
      const submitterElement = submitter instanceof HTMLElement ? submitter : null;
      const effectiveAction =
        (submitterElement && "formAction" in submitterElement
          ? String((submitterElement as HTMLButtonElement | HTMLInputElement).formAction || "")
          : "") ||
        directForm?.action ||
        null;
      const effectiveMethod =
        (submitterElement && "formMethod" in submitterElement
          ? String((submitterElement as HTMLButtonElement | HTMLInputElement).formMethod || "")
          : "") ||
        directForm?.method ||
        null;
      const vaultTotpForm = vaultTotpInput?.form ?? vaultTotpInput?.closest("form") ?? null;
      const vaultTotpSameDocument = Boolean(
        vaultTotpInput && vaultTotpInput.ownerDocument === element.ownerDocument,
      );
      const vaultTotpSameForm = Boolean(
        vaultTotpInput && directForm && vaultTotpForm === directForm,
      );
      // Do not construct FormData here: that fires page-controlled `formdata`
      // listeners before a human has approved anything. Native property reads
      // capture the submitted state without dispatching DOM events.
      const formFields = directForm
        ? Array.from(directForm.elements).map((control) => {
            if (control instanceof HTMLInputElement) {
              return {
                tag: "input",
                type: control.type.toLowerCase(),
                name: control.name,
                disabled: control.disabled,
                checked: control.checked,
                value:
                  control === vaultTotpInput
                    ? "[current Vault TOTP]"
                    : control.type.toLowerCase() === "file"
                      ? Array.from(control.files ?? []).map((file) => ({
                          name: file.name,
                          size: file.size,
                          type: file.type,
                        }))
                      : control.value,
              };
            }
            if (control instanceof HTMLTextAreaElement) {
              return {
                tag: "textarea",
                name: control.name,
                disabled: control.disabled,
                value: control.value,
              };
            }
            if (control instanceof HTMLSelectElement) {
              return {
                tag: "select",
                name: control.name,
                disabled: control.disabled,
                values: Array.from(control.selectedOptions).map((option) => option.value),
              };
            }
            if (control instanceof HTMLButtonElement) {
              return {
                tag: "button",
                type: control.type.toLowerCase(),
                name: control.name,
                disabled: control.disabled,
                value: control.value,
              };
            }
            return {
              tag: control.tagName.toLowerCase(),
              name: control.getAttribute("name") ?? "",
            };
          })
        : [];
      const domPath: Array<{ tag: string; index: number }> = [];
      let cursor: Element | null = element;
      while (cursor && domPath.length < 32) {
        const parent: Element | null = cursor.parentElement;
        domPath.push({
          tag: cursor.tagName.toLowerCase(),
          index: parent ? Array.from(parent.children).indexOf(cursor) : 0,
        });
        cursor = parent;
      }
      const vaultTotpDomPath: Array<{ tag: string; index: number }> = [];
      let vaultTotpCursor: Element | null = vaultTotpInput;
      while (vaultTotpCursor && vaultTotpDomPath.length < 32) {
        const parent: Element | null = vaultTotpCursor.parentElement;
        vaultTotpDomPath.push({
          tag: vaultTotpCursor.tagName.toLowerCase(),
          index: parent ? Array.from(parent.children).indexOf(vaultTotpCursor) : 0,
        });
        vaultTotpCursor = parent;
      }
      const frameUrl =
        element.ownerDocument.defaultView?.location.href ?? element.ownerDocument.URL;
      const vaultTotpFrameUrl = vaultTotpInput
        ? (vaultTotpInput.ownerDocument.defaultView?.location.href ??
          vaultTotpInput.ownerDocument.URL)
        : null;
      return {
        isTopDocument: element.ownerDocument.defaultView === element.ownerDocument.defaultView?.top,
        descriptor: {
          tagName,
          inputType,
          frameUrl,
          formAction: effectiveAction,
          formMethod: effectiveMethod?.toUpperCase() ?? null,
          submitsForm,
        },
        targetMaterial: {
          isTopDocument:
            element.ownerDocument.defaultView === element.ownerDocument.defaultView?.top,
          frameUrl,
          tagName,
          inputType,
          id: element.id,
          name: element.getAttribute("name") ?? "",
          role: element.getAttribute("role") ?? "",
          domPath,
          form: directForm
            ? {
                id: directForm.id,
                name: directForm.getAttribute("name") ?? "",
                action: effectiveAction,
                method: effectiveMethod,
                enctype: directForm.enctype,
                target: directForm.target,
                fields: formFields,
              }
            : null,
          submitter: submitterElement
            ? {
                id: submitterElement.id,
                name: submitterElement.getAttribute("name") ?? "",
                value: submitterElement.getAttribute("value") ?? "",
                formAction: effectiveAction,
                formMethod: effectiveMethod,
              }
            : null,
          capturedValue: context.action === "vault_capture" && input ? input.value : null,
          vaultTotp:
            context.action === "vault_totp_submit" && vaultTotpInput
              ? {
                  itemId: context.vaultItemId,
                  selector: context.vaultTotpSelector,
                  tagName: vaultTotpInput.tagName.toLowerCase(),
                  inputType: vaultTotpInput.type.toLowerCase(),
                  id: vaultTotpInput.id,
                  name: vaultTotpInput.name,
                  autocomplete: vaultTotpInput.autocomplete,
                  inputMode: vaultTotpInput.inputMode,
                  disabled: vaultTotpInput.disabled,
                  readOnly: vaultTotpInput.readOnly,
                  domPath: vaultTotpDomPath,
                  frameUrl: vaultTotpFrameUrl,
                  formControlIndex: directForm
                    ? Array.from(directForm.elements).indexOf(vaultTotpInput)
                    : -1,
                  sameDocument: vaultTotpSameDocument,
                  sameForm: vaultTotpSameForm,
                }
              : null,
        },
        sensitiveValue: context.action === "vault_capture" && input ? input.value : null,
        vaultTotpTarget: vaultTotpInput
          ? {
              frameUrl: vaultTotpFrameUrl,
              inputType: vaultTotpInput.type.toLowerCase(),
              sameDocument: vaultTotpSameDocument,
              sameForm: vaultTotpSameForm,
            }
          : null,
      };
    },
    {
      action: args.action,
      key: args.key,
      vaultTotpElement: (args.vaultTotp?.handle ?? null) as unknown as Element | null,
      vaultItemId: args.vaultTotp?.itemId ?? null,
      vaultTotpSelector: args.vaultTotp?.selector ?? null,
    },
  );
  if (args.action === "vault_totp_submit") {
    if (
      !args.vaultTotp ||
      !inspected.vaultTotpTarget ||
      !inspected.vaultTotpTarget.sameDocument ||
      !inspected.vaultTotpTarget.sameForm
    ) {
      throw new BrowserApprovalError(
        "The selected TOTP input must belong to the same form as the approved submit target",
        409,
      );
    }
  }
  const descriptor: BrowserApprovalTargetDescriptor = {
    ...inspected.descriptor,
    frameUrl: safeBrowserApprovalTargetUrl(inspected.descriptor.frameUrl),
    formAction: inspected.descriptor.formAction
      ? safeBrowserApprovalTargetUrl(inspected.descriptor.formAction)
      : null,
  };
  const fingerprint = computeBrowserActionTargetFingerprint({
    companyId: args.session.companyId,
    employeeId: args.employee.id,
    browserSessionId: args.session.id,
    action: args.action,
    selector: args.selector,
    key: args.key,
    pageUrl: args.page.url(),
    targetMaterial: inspected.targetMaterial,
  });
  return {
    handle,
    descriptor,
    fingerprint,
    isTopDocument: inspected.isTopDocument,
    sensitiveValue: inspected.sensitiveValue,
    ...(args.action === "vault_totp_submit" && inspected.vaultTotpTarget && args.vaultTotp
      ? {
          vaultTotpTarget: {
            handle: args.vaultTotp.handle,
            frameUrl: safeBrowserApprovalTargetUrl(inspected.vaultTotpTarget.frameUrl ?? ""),
            inputType: inspected.vaultTotpTarget.inputType,
          },
        }
      : {}),
  };
}

/**
 * Passwords are bound to an exact saved origin. Keeping this pure and
 * exported makes the anti-phishing boundary straightforward to unit test.
 */
export function vaultWebsiteMatchesPage(websiteUrl: string, pageUrl: string): boolean {
  try {
    const website = new URL(websiteUrl);
    const page = new URL(pageUrl);
    if (!["http:", "https:"].includes(website.protocol)) return false;
    if (!["http:", "https:"].includes(page.protocol)) return false;
    return website.origin.toLowerCase() === page.origin.toLowerCase();
  } catch {
    return false;
  }
}

/** WebAuthn permits an RP ID equal to the current host or one of its registrable parents. */
export function vaultPasskeyMatchesPage(rpId: string, pageUrl: string): boolean {
  try {
    const page = new URL(pageUrl);
    if (
      page.protocol !== "https:" &&
      !(page.protocol === "http:" && page.hostname === "localhost")
    ) {
      return false;
    }
    const normalizedRpId = rpId
      .trim()
      .toLowerCase()
      .replace(/^\.+|\.+$/g, "");
    const hostname = page.hostname.toLowerCase();
    return Boolean(
      normalizedRpId && (hostname === normalizedRpId || hostname.endsWith(`.${normalizedRpId}`)),
    );
  } catch {
    return false;
  }
}

export function vaultFillTargetIsAllowed(
  itemType: VaultItemType,
  field: "username" | "secret" | "totp",
  inputType: string | null,
): boolean {
  if (field === "totp") {
    return (
      itemType === "login" &&
      ["text", "tel", "number", "password"].includes(inputType?.toLowerCase() ?? "")
    );
  }
  if (field !== "secret") return itemType === "login";
  return itemType === "login" && inputType?.toLowerCase() === "password";
}

function assertVaultTotpSubmitTarget(args: {
  employee: AIEmployee;
  pageUrl: string;
  websiteUrl: string;
  itemType: VaultItemType;
  hasTotp: boolean;
  target: BrowserApprovalTargetInspection;
}): asserts args is typeof args & {
  target: BrowserApprovalTargetInspection & {
    vaultTotpTarget: NonNullable<BrowserApprovalTargetInspection["vaultTotpTarget"]>;
  };
} {
  if (args.itemType !== "login" || !args.hasTotp) {
    throw new VaultError("This Vault login has no TOTP saved", 404);
  }
  if (!args.target.descriptor.submitsForm || !args.target.vaultTotpTarget) {
    throw new BrowserApprovalError(
      "A Vault TOTP submission requires a submit target and a TOTP input in the same form",
      409,
    );
  }
  if (!vaultFillTargetIsAllowed(args.itemType, "totp", args.target.vaultTotpTarget.inputType)) {
    throw new VaultError(
      "A Vault TOTP code can only fill a text, telephone, number, or password input",
      400,
    );
  }
  if (
    !vaultWebsiteMatchesPage(args.websiteUrl, args.pageUrl) ||
    !vaultWebsiteMatchesPage(args.websiteUrl, args.target.descriptor.frameUrl) ||
    !vaultWebsiteMatchesPage(args.websiteUrl, args.target.vaultTotpTarget.frameUrl)
  ) {
    throw new VaultError(
      "Vault origin mismatch: this login can only be used in its exact saved origin",
      403,
    );
  }
  assertVaultBrowserPolicy(
    args.employee,
    args.pageUrl,
    args.target.descriptor.frameUrl,
    args.target.vaultTotpTarget.frameUrl,
  );
}

async function rememberVaultSensitiveValue(sessionId: string, value: string): Promise<void> {
  vaultTaintedSessions.add(sessionId);
  if (value) {
    let values = vaultSensitiveValuesBySession.get(sessionId);
    if (!values) {
      values = new Map<string, number>();
      vaultSensitiveValuesBySession.set(sessionId, values);
    }
    if (values.size >= MAX_TRACKED_VAULT_VALUES_PER_SESSION && !values.has(value)) {
      // Never evict a known password: the page may reflect it later as generic
      // text. Stop remembering new values and make all subsequent model-visible
      // page/error output fail closed for this BrowserSession.
      vaultSensitiveOverflowSessions.add(sessionId);
    } else {
      // Keep the bounded value set for the whole BrowserSession. Password reveal
      // controls can change an input to type=text long after the original fill;
      // expiring the scrub value would then disclose it in a later snapshot.
      values.set(value, Date.now());
    }
  }
  // Recording is all-or-nothing. This await completes before a sensitive
  // action, but encoder/filesystem failure remains auxiliary to browser work.
  await restrictBrowserRecording(sessionId).catch(() => undefined);
}

async function rememberTotpSetupValue(sessionId: string, setupKey: string): Promise<void> {
  vaultTotpArmedSessions.add(sessionId);
  await rememberVaultSensitiveValue(sessionId, setupKey);
  try {
    const uri = new URL(setupKey);
    if (uri.protocol === "otpauth:" && uri.hostname.toLowerCase() === "totp") {
      const secret = uri.searchParams.get("secret") ?? "";
      if (secret) await rememberVaultSensitiveValue(sessionId, secret);
      return;
    }
  } catch {
    // A raw Base32 setup key is expected on many enrollment pages.
  }
  const compact = setupKey.replace(/[\s-]/g, "");
  if (compact && compact !== setupKey) await rememberVaultSensitiveValue(sessionId, compact);
}

async function armVaultTotpSession(sessionId: string): Promise<void> {
  vaultTotpArmedSessions.add(sessionId);
  await rememberVaultSensitiveValue(sessionId, "");
}

export async function rememberVaultTotpCode(
  sessionId: string,
  code: string,
  expiresAt: Date,
): Promise<void> {
  await rememberVaultSensitiveValue(sessionId, code);
  let codes = vaultTotpCodesBySession.get(sessionId);
  if (!codes) {
    codes = new Map<string, number>();
    vaultTotpCodesBySession.set(sessionId, codes);
  }
  if (codes.size >= MAX_TRACKED_VAULT_VALUES_PER_SESSION && !codes.has(code)) {
    vaultSensitiveOverflowSessions.add(sessionId);
    return;
  }
  codes.set(code, expiresAt.getTime());
}

export function clearVaultSensitiveValuesForSession(sessionId: string): void {
  vaultSensitiveValuesBySession.delete(sessionId);
  vaultTaintedSessions.delete(sessionId);
  vaultSensitiveOverflowSessions.delete(sessionId);
  vaultTotpArmedSessions.delete(sessionId);
  vaultTotpCodesBySession.delete(sessionId);
  vaultTotpCaptureBindings.delete(sessionId);
}

registerBrowserSessionCleanup(clearVaultSensitiveValuesForSession);
registerBrowserSessionCleanup((sessionId) => {
  void clearVaultPasskeyAuthenticator(sessionId);
});
export function observeBrowserSensitiveValue(
  sessionId: string,
  value: string,
  kind: "password-present" | "password-value" | "active-input-value",
): Promise<void> {
  if (kind === "password-present") {
    vaultTaintedSessions.add(sessionId);
    return restrictBrowserRecording(sessionId).catch(() => undefined);
  }
  if (kind === "password-value" || vaultTaintedSessions.has(sessionId)) {
    return rememberVaultSensitiveValue(sessionId, value);
  }
  return Promise.resolve();
}

registerBrowserSensitiveValueListener(observeBrowserSensitiveValue);

export function redactVaultSensitiveText(sessionId: string, text: string): string {
  if (vaultSensitiveOverflowSessions.has(sessionId)) {
    return "[redacted because this BrowserSession exceeded the sensitive-value safety limit]";
  }
  const now = Date.now();
  const codes = vaultTotpCodesBySession.get(sessionId);
  if ([...(codes?.values() ?? [])].some((expiresAt) => expiresAt + 120_000 > now)) {
    // Pages can reflect one code across separate spans, accessibility nodes,
    // or punctuation variants. Until it expires, withholding the complete
    // model-visible text is the only representation-independent boundary.
    return "[redacted while the current Vault one-time code could be reflected by the page]";
  }
  let redacted = redactUncapturedTotpValues(text, vaultTotpArmedSessions.has(sessionId));
  for (const value of vaultSensitiveValuesBySession.get(sessionId)?.keys() ?? []) {
    const escaped = JSON.stringify(value).slice(1, -1);
    for (const candidate of new Set([value, escaped])) {
      if (candidate) redacted = redacted.split(candidate).join("[redacted Vault value]");
    }
  }
  return redacted;
}

registerBrowserRecordingFrameInspector(async (sessionId, jpegBase64) => {
  // Inspect the exact bytes that would enter ffmpeg. Any QR is withheld: a
  // benign first symbol must not be able to hide a second authenticator QR
  // from a single-result decoder. Enrollment preparation independently
  // withholds the whole recording before the website reveals its secret.
  const page = getRuntime(sessionId)?.page as Page | undefined;
  if (!page) throw new Error("The Browser page was unavailable for credential-frame inspection");
  await observeRuntimeTotpEnrollment(page, sessionId);
  if (vaultTotpArmedSessions.has(sessionId)) return false;
  const decoded = await decodeQrFromImage(Buffer.from(jpegBase64, "base64"));
  return decoded === null;
});

type VaultTargetDescriptor = {
  frameUrl: string;
  inputType: string | null;
};

async function resolveVaultTarget(locator: Locator): Promise<ElementHandle> {
  const handle = await locator.elementHandle();
  if (!handle) throw new VaultError("The selected Vault target is no longer attached", 409);
  return handle;
}

async function describeVaultTarget(handle: ElementHandle): Promise<VaultTargetDescriptor> {
  return handle.evaluate((element) => ({
    frameUrl: element.ownerDocument.defaultView?.location.href ?? element.ownerDocument.URL,
    inputType: element instanceof HTMLInputElement ? element.type : element.getAttribute("type"),
  }));
}

function safeVaultWebsiteUrl(pageUrl: string): string {
  const parsed = new URL(pageUrl);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new VaultError("Vault logins can only be saved from an http(s) page", 400);
  }
  // Deliberately discard path/query/hash: account setup links often carry
  // bearer material in the URL, and the Vault only needs the origin/host.
  return parsed.origin;
}

/**
 * The browser's own allow list, when the session drives a Member's computer.
 * Returns `{ok:true}` untouched for the container's Chromium, so the local
 * path keeps exactly the semantics it had.
 */
async function memberBrowserOpenAllowed(
  req: BrowserRpcReq,
  url: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const browserId = req.browserSession?.memberBrowserId;
  if (!browserId) return { ok: true };
  const row = await AppDataSource.getRepository(MemberBrowser).findOneBy({ id: browserId });
  if (!row) return { ok: false, reason: "That browser is no longer connected." };
  return memberBrowserUrlAllowed(url, row, (candidate, allowList) =>
    urlAllowed(candidate, allowList),
  );
}

/**
 * Approvals are the union of the employee's setting and the browser's. A
 * Member's own machine defaults to requiring them, and that default must not
 * be silently undone by an employee configured for the unattended container
 * browser.
 */
export function browserApprovalRequiredForSession(
  employee: AIEmployee,
  memberBrowser: { approvalRequired: boolean } | null,
): boolean {
  return employee.browserApprovalRequired || Boolean(memberBrowser?.approvalRequired);
}

export function vaultUrlAllowedForEmployee(url: string, rawAllowList: string | null): boolean {
  return urlAllowed(url, parseAllowList(rawAllowList)).ok;
}

function assertVaultBrowserPolicy(employee: AIEmployee, ...urls: string[]): void {
  const allowList = parseAllowList(employee.browserAllowedHosts);
  if (urls.some((url) => !urlAllowed(url, allowList).ok)) {
    throw new VaultError("Vault use is blocked by this AI Employee's Browser host policy", 403);
  }
}

/** Byte-accurate UTF-8 truncation that never splits a code point. */
function truncateUtf8(s: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= maxBytes) return { text: s, truncated: false };
  let text = buf.subarray(0, maxBytes).toString("utf8");
  // A code point split at the boundary decodes to U+FFFD — drop it.
  if (text.endsWith("�")) text = text.slice(0, -1);
  return { text, truncated: true };
}

/**
 * Playwright's AI aria snapshot includes textbox values, including password
 * inputs. Resolve textbox refs back to their DOM elements and replace the
 * entire rendered scalar for password fields. An unresolvable ref fails
 * closed by hiding that textbox value as well.
 */
export async function redactPasswordInputsFromSnapshot(
  page: Page,
  sessionId: string,
  tree: string,
): Promise<string> {
  const refs = Array.from(
    new Set(Array.from(tree.matchAll(/\btextbox\b[^\n]*\[ref=([^\]]+)\]/g), (match) => match[1])),
  );
  if (refs.length === 0) return tree;

  const states = new Map<string, "keep" | "redact">();
  await Promise.all(
    refs.map(async (ref) => {
      try {
        const locator = page.locator(`aria-ref=${ref}`).first();
        const handle = await locator.elementHandle();
        if (!handle) throw new Error("snapshot ref detached");
        const inputType = (await handle.getAttribute("type"))?.toLowerCase();
        if (inputType !== "password") {
          states.set(ref, "keep");
          return;
        }
        const value = await handle.inputValue().catch(() => "");
        await rememberVaultSensitiveValue(sessionId, value);
        states.set(ref, "redact");
      } catch {
        states.set(ref, "redact");
      }
    }),
  );

  // Once any password field/value has existed, redact every textbox value.
  // This fail-closed rule prevents a reveal control, DOM replacement, or the
  // bounded exact-value cache from declassifying an older password while
  // keeping element labels and refs usable for subsequent actions.
  const redactAllTextboxValues = vaultTaintedSessions.has(sessionId);

  return tree
    .split("\n")
    .map((line) => {
      const match = /\btextbox\b[^\n]*\[ref=([^\]]+)\]/.exec(line);
      if (!match || (!redactAllTextboxValues && states.get(match[1]) !== "redact")) {
        return line;
      }
      const marker = `[ref=${match[1]}]`;
      const markerEnd = line.indexOf(marker) + marker.length;
      return `${line.slice(0, markerEnd)}: [redacted password]`;
    })
    .join("\n");
}

export async function pageSnapshot(p: Page, sessionId: string): Promise<string> {
  const url = safeBrowserUrlForModel(p.url());
  const [title, rawTree] = await Promise.all([
    p.title().catch(() => ""),
    p.ariaSnapshot({ mode: "ai", timeout: ARIA_SNAPSHOT_TIMEOUT_MS }).catch(() => ""),
  ]);
  const enrollmentText = `${title}\n${rawTree}`;
  const uncapturedTotpSetup = findTotpSetupKeyInText(title) ?? findTotpSetupKeyInText(rawTree);
  if (uncapturedTotpSetup) {
    await rememberTotpSetupValue(sessionId, uncapturedTotpSetup);
  }
  if (textSuggestsTotpEnrollment(enrollmentText)) {
    await armVaultTotpSession(sessionId);
  }
  const tree = await redactPasswordInputsFromSnapshot(p, sessionId, rawTree);

  if (vaultSensitiveOverflowSessions.has(sessionId)) {
    return [
      `URL: ${url}`,
      "Title: [redacted]",
      "",
      "## Page snapshot",
      "[redacted because this BrowserSession exceeded the sensitive-value safety limit]",
    ].join("\n");
  }

  const sections: string[] = [];
  for (const notice of takeSessionNotices(sessionId)) {
    sections.push(`NOTE: ${notice}`);
  }
  sections.push(`URL: ${url}`, `Title: ${title || "(none)"}`, "");

  if (tree.trim().length > 0) {
    let lines = tree.split("\n");
    const total = lines.length;
    const truncated = total > SNAPSHOT_MAX_LINES;
    if (truncated) lines = lines.slice(0, SNAPSHOT_MAX_LINES);
    sections.push(
      "## Page snapshot",
      "Interactive elements carry [ref=eN] markers — act on them by passing `aria-ref=eN` as the selector.",
      ...lines,
    );
    if (truncated) {
      sections.push(
        `(outline capped at ${SNAPSHOT_MAX_LINES} of ${total} elements — deeper elements are omitted from this snapshot. This is a full-page outline, so scrolling will not reveal more; narrow down by interacting with a container here, or navigate to a more specific page/URL.)`,
      );
    }
    return redactVaultSensitiveText(sessionId, sections.join("\n"));
  }

  // Aria snapshot came back empty (blank page, or a page still rendering).
  // Fall back to raw visible text so the model isn't left with nothing.
  if (vaultTaintedSessions.has(sessionId)) {
    return [
      `URL: ${url}`,
      "Title: [redacted]",
      "",
      "## Visible text",
      "[redacted because this BrowserSession has contained a password]",
    ].join("\n");
  }
  let bodyText = "";
  try {
    bodyText = await p.evaluate(() => (document.body?.innerText ?? "").slice(0, 16_384));
  } catch {
    // ignore
  }
  const visibleTotpSetup = findTotpSetupKeyInText(bodyText);
  if (visibleTotpSetup) {
    await rememberTotpSetupValue(sessionId, visibleTotpSetup);
  }
  if (textSuggestsTotpEnrollment(bodyText)) {
    await armVaultTotpSession(sessionId);
  }
  const { text, truncated } = truncateUtf8(bodyText, TEXT_MAX_BYTES);
  sections.push(
    "## Visible text",
    text ||
      "(empty — the page may still be rendering; call browser_wait or browser_snapshot to retry)",
  );
  if (truncated) sections.push(`(truncated to first ${TEXT_MAX_BYTES} bytes)`);
  return redactVaultSensitiveText(sessionId, sections.join("\n"));
}

/**
 * Resolve a selector to its first visible match, failing fast. On no match
 * the error carries a fresh snapshot so the model can pick a valid ref
 * without spending another turn on browser_snapshot. When a CSS/text
 * selector matches several elements, a notice flags the ambiguity instead
 * of silently acting on the first.
 */
async function locate(p: Page, sessionId: string, selector: string): Promise<Locator> {
  const base = p.locator(selector);
  const loc = base.first();
  try {
    await loc.waitFor({ state: "visible", timeout: LOCATE_TIMEOUT_MS });
  } catch (err) {
    // Distinguish "nothing matched in time" from a malformed selector —
    // Playwright reports the latter with a parse error worth relaying.
    const raw = safeBrowserError(sessionId, err);
    const timedOut = raw.includes("Timeout");
    let snap = "";
    try {
      snap = await pageSnapshot(p, sessionId);
    } catch {
      // page may be mid-navigation — the message alone still helps
    }
    throw new Error(
      (timedOut
        ? `No visible element matched selector \`${selector}\` within ${LOCATE_TIMEOUT_MS}ms. `
        : `Selector \`${selector}\` failed: ${raw}. `) +
        `Prefer an \`aria-ref=eN\` ref from the snapshot below.` +
        (snap ? `\n\nCurrent page:\n${snap}` : ""),
    );
  }
  if (!selector.startsWith("aria-ref=")) {
    try {
      const n = await base.count();
      if (n > 1) {
        pushSessionNotice(
          sessionId,
          `Selector \`${selector}\` matched ${n} elements — acted on the first. Use an aria-ref from the snapshot to target precisely.`,
        );
      }
    } catch {
      // advisory only
    }
  }
  return loc;
}

/**
 * Let the page settle after an action before snapshotting. Waits for the
 * DOM to go quiet (no mutations for 250ms, capped at 1.5s) — far cheaper
 * than the old `networkidle` wait, which burned its full 3s timeout on any
 * page with analytics beacons or sockets. If the action kicked off a
 * navigation, the quiescence evaluate dies with the old document; the
 * bounded `domcontentloaded` wait below covers that case (and resolves
 * instantly when no navigation happened).
 */
async function settle(p: Page): Promise<void> {
  // The in-page CAP_MS timer only fires if the page's event loop runs — a
  // page that blocks its main thread would never resolve the evaluate, and
  // page.evaluate is not bound by any Playwright timeout. Race a Node-side
  // deadline so a busy page can't wedge the tool call.
  const quiesce = p
    .evaluate(
      () =>
        new Promise<void>((resolve) => {
          const QUIET_MS = 250;
          const CAP_MS = 1_500;
          const done = () => {
            observer.disconnect();
            clearTimeout(quietTimer);
            clearTimeout(capTimer);
            resolve();
          };
          let quietTimer = setTimeout(done, QUIET_MS);
          const capTimer = setTimeout(done, CAP_MS);
          const observer = new MutationObserver(() => {
            clearTimeout(quietTimer);
            quietTimer = setTimeout(done, QUIET_MS);
          });
          observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true,
          });
        }),
    )
    .catch(() => {
      // navigation destroyed the evaluation context — fall through
    });
  let capTimer: NodeJS.Timeout | null = null;
  const deadline = new Promise<void>((resolve) => {
    capTimer = setTimeout(resolve, SETTLE_CAP_MS);
  });
  try {
    await Promise.race([quiesce, deadline]);
  } finally {
    if (capTimer) clearTimeout(capTimer);
  }
  try {
    await p.waitForLoadState("domcontentloaded", { timeout: 5_000 });
  } catch {
    // advisory
  }
}

export async function rememberCurrentPasswordValues(page: Page, sessionId: string): Promise<void> {
  const observations = await Promise.all(
    page.frames().map((frame) =>
      frame
        .evaluate(() => {
          const inputs: HTMLInputElement[] = [];
          const visit = (root: Document | ShadowRoot) => {
            for (const element of root.querySelectorAll("*")) {
              if (element instanceof HTMLInputElement && element.type === "password") {
                inputs.push(element);
              }
              if (element.shadowRoot) visit(element.shadowRoot);
            }
          };
          visit(document);
          return { present: inputs.length > 0, values: inputs.map((input) => input.value) };
        })
        // Failure to inspect a frame must not make it safe to expose textbox
        // values or screenshots. Taint the session and fail closed.
        .catch(() => ({ present: true, values: [] as string[] })),
    ),
  );
  for (const observation of observations) {
    if (observation.present) {
      await observeBrowserSensitiveValue(sessionId, "", "password-present");
    }
    for (const value of observation.values) {
      await rememberVaultSensitiveValue(sessionId, value);
    }
  }
}

async function observeRuntimeTotpEnrollment(page: Page, sessionId: string): Promise<void> {
  const observations = await Promise.all(
    page.frames().map((frame) =>
      frame
        .evaluate(() => {
          const pieces: string[] = [];
          const push = (value: unknown, limit = 64_000) => {
            if (typeof value === "string" && value) pieces.push(value.slice(0, limit));
          };
          push(document.body?.innerText);
          const candidates = Array.from(
            document.querySelectorAll(
              'img, canvas, svg, [data-otpauth], [data-secret], [aria-label*="QR" i], [title*="QR" i]',
            ),
          ).slice(0, 256);
          for (const element of candidates) {
            push(element.textContent, 2_000);
            for (const attribute of [
              "src",
              "href",
              "alt",
              "title",
              "aria-label",
              "data-otpauth",
              "data-secret",
            ]) {
              push(element.getAttribute(attribute), 2_000);
            }
          }
          return pieces.join("\n").slice(0, 250_000);
        })
        .catch(() => null),
    ),
  );
  for (const observation of observations) {
    if (observation === null) {
      // A frame that cannot be inspected is not evidence that enrollment
      // secrets are absent. Withholding is reversible only by ending the
      // BrowserSession, while leaking a setup key is not.
      await armVaultTotpSession(sessionId);
      continue;
    }
    const setupKey = findTotpSetupKeyInText(observation);
    if (setupKey) await rememberTotpSetupValue(sessionId, setupKey);
    if (textSuggestsTotpEnrollment(observation)) await armVaultTotpSession(sessionId);
  }
}

async function bumpAndAcquire(req: BrowserRpcReq): Promise<Page> {
  const session = req.browserSession!;
  markActivity(session.id);
  const page = (await acquirePage(session.id)) as Page;
  // Observe password fields before any model action can click a reveal
  // control or otherwise mutate their type/value. Values stay scrubbed for
  // the lifetime of this BrowserSession.
  await observeRuntimePasswordValues(session.id, {
    failClosedIfUnavailable: true,
  });
  await observeRuntimeTotpEnrollment(page, session.id);
  // Start and await the cast after the fail-closed password scan but still
  // before the first browser action. A sensitive page leaves a persisted
  // restriction marker, so beginBrowserRecording refuses to start.
  await markSessionLive(session.id, {
    allowFinalizingRun: req.browserRpcAllowsFinalizingRun === true,
  });
  return page;
}

/**
 * The page to snapshot after an action — re-read from the runtime because
 * the action may have opened a popup that `adoptPage` has since made the
 * active page.
 */
function currentPage(sessionId: string, fallback: Page): Page {
  const runtime = getRuntime(sessionId);
  return (runtime?.page as Page | undefined) ?? fallback;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function safeBrowserError(sessionId: string, err: unknown): string {
  if (vaultSensitiveOverflowSessions.has(sessionId)) {
    return "Browser action failed after sensitive page data was redacted";
  }
  return redactVaultSensitiveText(sessionId, errText(err));
}

/** Model-visible snapshots need origin context, not token-bearing URL details. */
export function safeBrowserUrlForModel(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "(unavailable)";
    return url.origin;
  } catch {
    return "(unavailable)";
  }
}

// ---------- routes ----------

const openSchema = z.object({ url: z.string().min(1).max(2048) });
browserRpcRouter.post("/open", validateBody(openSchema), async (req: BrowserRpcReq, res) => {
  const body = req.body as z.infer<typeof openSchema>;
  const url = body.url.trim();
  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: "`url` must be an absolute http(s) URL" });
  }
  const allow = parseAllowList(req.browserEmployee!.browserAllowedHosts);
  const ok = urlAllowed(url, allow);
  if (!ok.ok) return res.status(403).json({ error: ok.reason });
  // Two lists, checked independently. Glob lists cannot be merged into a
  // third — `*.example.com` and `mail.*` have no common list form — so the URL
  // simply has to pass both. The browser's own list is also the stricter one:
  // empty means "opens nothing", where an empty employee list means
  // "unrestricted".
  const memberBrowserVerdict = await memberBrowserOpenAllowed(req, url);
  if (!memberBrowserVerdict.ok) {
    return res.status(403).json({ error: memberBrowserVerdict.reason });
  }
  const sessionId = req.browserSession!.id;
  try {
    const page = await bumpAndAcquire(req);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    // Give SPAs a beat to hydrate — a snapshot at bare domcontentloaded is
    // often an empty shell that costs the model a retry turn.
    await settle(page);
    res.json({ snapshot: await pageSnapshot(page, sessionId) });
  } catch (err) {
    res.status(500).json({ error: safeBrowserError(req.browserSession!.id, err) });
  }
});

browserRpcRouter.post("/snapshot", async (req: BrowserRpcReq, res) => {
  const sessionId = req.browserSession!.id;
  try {
    const page = await bumpAndAcquire(req);
    res.json({ snapshot: await pageSnapshot(page, sessionId) });
  } catch (err) {
    res.status(500).json({ error: safeBrowserError(req.browserSession!.id, err) });
  }
});

/**
 * Lightweight current-location read for the approval flow — no snapshot
 * machinery and, deliberately, no `bumpAndAcquire`: asking "where are we?"
 * must not launch Chromium.
 */
browserRpcRouter.post("/url", async (req: BrowserRpcReq, res) => {
  const session = req.browserSession!;
  const runtime = getRuntime(session.id);
  const page = runtime?.page as { url: () => string; isClosed: () => boolean } | undefined | null;
  if (page && !page.isClosed()) {
    return res.json({ url: page.url(), title: session.pageTitle ?? null });
  }
  res.json({ url: session.pageUrl ?? "", title: session.pageTitle ?? null });
});

const describeApprovalTargetSchema = z
  .object({
    action: z.enum([
      "submit",
      "vault_capture",
      "vault_totp_submit",
      "vault_passkey_create",
      "vault_passkey_use",
    ]),
    selector: z.string().min(1).max(500),
    key: browserModelPressKeySchema.nullable().optional(),
    itemId: z.string().uuid().optional(),
    totpSelector: z.string().min(1).max(500).optional(),
    passkeyId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.action !== "vault_totp_submit") return;
    if (!body.itemId) {
      ctx.addIssue({ code: "custom", path: ["itemId"], message: "itemId is required" });
    }
    if (!body.totpSelector) {
      ctx.addIssue({
        code: "custom",
        path: ["totpSelector"],
        message: "totpSelector is required",
      });
    }
  })
  .superRefine((body, ctx) => {
    if (body.action !== "vault_passkey_create" && body.action !== "vault_passkey_use") return;
    if (!body.itemId) {
      ctx.addIssue({ code: "custom", path: ["itemId"], message: "itemId is required" });
    }
  });

browserRpcRouter.post(
  "/approval/describe-target",
  validateBody(describeApprovalTargetSchema),
  async (req: BrowserRpcReq, res) => {
    const body = req.body as z.infer<typeof describeApprovalTargetSchema>;
    const session = req.browserSession!;
    const employee = req.browserEmployee!;
    try {
      let itemVersion: number | undefined;
      let passkeyId: string | undefined;
      const page = await bumpAndAcquire(req);
      const vaultTotp =
        body.action === "vault_totp_submit"
          ? {
              itemId: body.itemId!,
              selector: body.totpSelector!,
              handle: await resolveVaultTarget(await locate(page, session.id, body.totpSelector!)),
            }
          : undefined;
      const target = await inspectBrowserApprovalTarget({
        page,
        session,
        employee,
        action: body.action,
        selector: body.selector,
        key: body.key ?? null,
        vaultTotp,
      });
      if (body.action === "vault_capture") {
        if (
          target.descriptor.inputType !== "password" ||
          !vaultWebsiteMatchesPage(page.url(), target.descriptor.frameUrl)
        ) {
          throw new VaultError(
            "Vault capture requires a same-origin input with type=password",
            400,
          );
        }
        assertVaultBrowserPolicy(employee, page.url(), target.descriptor.frameUrl);
        if (!target.sensitiveValue) {
          throw new VaultError("The selected password field is empty", 400);
        }
        if (target.sensitiveValue.length > 10_000) {
          throw new VaultError("The selected password is too long", 400);
        }
      } else if (body.action === "vault_totp_submit") {
        const resolved = await getVaultItemPayloadForEmployee({
          companyId: session.companyId,
          employeeId: employee.id,
          itemId: body.itemId!,
          required: "use",
        });
        if (!Number.isSafeInteger(resolved.item.version) || resolved.item.version < 1) {
          throw new VaultError("Vault item version is invalid", 409);
        }
        itemVersion = resolved.item.version;
        assertVaultTotpSubmitTarget({
          employee,
          pageUrl: page.url(),
          websiteUrl: resolved.payload.websiteUrl,
          itemType: resolved.item.type,
          hasTotp: resolved.payload.totp !== null,
          target,
        });
      } else if (body.action === "vault_passkey_create" || body.action === "vault_passkey_use") {
        if (session.memberBrowserId) {
          throw new VaultError(
            "Vault software passkeys are available only in the App-owned Browser",
            403,
          );
        }
        if (!target.isTopDocument) {
          throw new VaultError(
            "Vault software passkey ceremonies must start in the top-level page",
            400,
          );
        }
        const resolved = await getVaultItemPayloadForEmployee({
          companyId: session.companyId,
          employeeId: employee.id,
          itemId: body.itemId!,
          required: body.action === "vault_passkey_create" ? "manage" : "use",
        });
        if (!Number.isSafeInteger(resolved.item.version) || resolved.item.version < 1) {
          throw new VaultError("Vault item version is invalid", 409);
        }
        itemVersion = resolved.item.version;
        if (resolved.item.type !== "login") {
          throw new VaultError("Software passkeys can only be used with Vault logins", 400);
        }
        if (body.action === "vault_passkey_use") {
          const selected = body.passkeyId
            ? resolved.payload.passkeys.find((candidate) => candidate.id === body.passkeyId)
            : resolved.payload.passkeys.length === 1
              ? resolved.payload.passkeys[0]
              : undefined;
          if (!selected) {
            if (!body.passkeyId && resolved.payload.passkeys.length > 1) {
              throw new VaultError("Choose which saved Vault passkey to use", 400);
            }
            throw new VaultError("Vault passkey not found", 404);
          }
          passkeyId = selected.id;
        }
        if (
          body.action === "vault_passkey_create" &&
          resolved.item.createdByEmployeeId !== employee.id
        ) {
          throw new VaultError(
            "AI Employees can only attach software passkeys to Vault logins they created",
            403,
          );
        }
        if (
          !vaultWebsiteMatchesPage(resolved.payload.websiteUrl, page.url()) ||
          !vaultWebsiteMatchesPage(resolved.payload.websiteUrl, target.descriptor.frameUrl)
        ) {
          throw new VaultError(
            "Vault origin mismatch: this login can only be used in its exact saved origin",
            403,
          );
        }
        assertVaultBrowserPolicy(employee, page.url(), target.descriptor.frameUrl);
      }
      res.setHeader("Cache-Control", "no-store");
      res.json({
        pageUrl: safeBrowserApprovalTargetUrl(page.url()),
        targetFingerprint: target.fingerprint,
        targetDescriptor: target.descriptor,
        ...(itemVersion !== undefined ? { itemVersion } : {}),
        ...(passkeyId !== undefined ? { passkeyId } : {}),
      });
    } catch (error) {
      if (error instanceof VaultError || error instanceof BrowserApprovalError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      res.status(500).json({ error: safeBrowserError(session.id, error) });
    }
  },
);

const clickSchema = z
  .object({
    selector: z.string().min(1).max(500),
    approvalId: z.string().uuid().optional(),
  })
  .strict();
browserRpcRouter.post("/click", validateBody(clickSchema), async (req: BrowserRpcReq, res) => {
  const body = req.body as z.infer<typeof clickSchema>;
  const session = req.browserSession!;
  const employee = req.browserEmployee!;
  let claimId: string | null = null;
  let actionAttempted = false;
  let guardedPage: Page | null = null;
  try {
    const page = await bumpAndAcquire(req);
    if (!req.approvalRequired && !body.approvalId) {
      const loc = await locate(page, session.id, body.selector);
      await loc.click({ timeout: ACTION_TIMEOUT_MS });
    } else {
      let target = await inspectBrowserApprovalTarget({
        page,
        session,
        employee,
        action: "submit",
        selector: body.selector,
        key: null,
      });
      if (!body.approvalId && browserClickMaySubmit(target.descriptor)) {
        throw new BrowserApprovalError(
          "This click can submit a form and requires browser_submit approval",
          409,
        );
      }
      if (!body.approvalId) {
        await armUnapprovedFormSubmitGuard(page);
        guardedPage = page;
      }
      if (body.approvalId) {
        const claimed = await claimBrowserActionApproval({
          approvalId: body.approvalId,
          companyId: session.companyId,
          employeeId: employee.id,
          browserSessionId: session.id,
          action: "submit",
          selector: body.selector,
          key: null,
          targetFingerprint: target.fingerprint,
          targetDescriptor: target.descriptor,
        });
        claimId = claimed.claimId;
        const revalidated = await inspectBrowserApprovalTarget({
          page,
          session,
          employee,
          action: "submit",
          selector: body.selector,
          key: null,
          handle: target.handle,
        });
        if (
          revalidated.fingerprint !== target.fingerprint ||
          JSON.stringify(revalidated.descriptor) !== JSON.stringify(target.descriptor)
        ) {
          throw new BrowserApprovalError(
            "Browser target changed while the approval was being claimed",
            409,
          );
        }
        target = revalidated;
      }
      if (claimId) actionAttempted = true;
      await target.handle.click({ timeout: ACTION_TIMEOUT_MS });
      if (body.approvalId && claimId) {
        await settleBrowserActionApproval({
          approvalId: body.approvalId,
          claimId,
          succeeded: true,
        });
        claimId = null;
      }
    }
    await settle(page);
    if (guardedPage) {
      const blocked = await disarmUnapprovedFormSubmitGuard(guardedPage);
      guardedPage = null;
      if (blocked) {
        throw new BrowserApprovalError(
          "This click attempted to submit a form and requires browser_submit approval",
          409,
        );
      }
    }
    // A click can open a new tab; wait for it to be adopted so we snapshot
    // the page the model will act on next, not the one it just left.
    await awaitAdoption(session.id, ADOPTION_WAIT_MS);
    const p = currentPage(session.id, page);
    res.json({ snapshot: await pageSnapshot(p, session.id) });
  } catch (err) {
    if (guardedPage) await disarmUnapprovedFormSubmitGuard(guardedPage);
    if (body.approvalId && claimId) {
      await settleBrowserActionApproval({
        approvalId: body.approvalId,
        claimId,
        succeeded: actionAttempted,
      }).catch(() => undefined);
    }
    if (err instanceof BrowserApprovalError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    res.status(500).json({ error: safeBrowserError(session.id, err) });
  }
});

const fillSchema = z.object({
  selector: z.string().min(1).max(500),
  value: z.string().max(50_000),
});
browserRpcRouter.post("/fill", validateBody(fillSchema), async (req: BrowserRpcReq, res) => {
  const body = req.body as z.infer<typeof fillSchema>;
  const sessionId = req.browserSession!.id;
  try {
    const page = await bumpAndAcquire(req);
    const loc = await locate(page, sessionId, body.selector);
    await loc.fill(body.value, { timeout: ACTION_TIMEOUT_MS });
    res.json({ snapshot: await pageSnapshot(page, sessionId) });
  } catch (err) {
    res.status(500).json({ error: safeBrowserError(req.browserSession!.id, err) });
  }
});

const vaultFillSchema = z
  .object({
    selector: z.string().min(1).max(500),
    itemId: z.string().uuid(),
    field: z.enum(["username", "secret", "totp"]),
  })
  .strict();

browserRpcRouter.post(
  "/vault/fill",
  validateBody(vaultFillSchema),
  async (req: BrowserRpcReq, res) => {
    const body = req.body as z.infer<typeof vaultFillSchema>;
    const session = req.browserSession!;
    const employee = req.browserEmployee!;
    if (body.field === "totp" && req.approvalRequired) {
      return res.status(409).json({
        error:
          "Filling a Vault one-time code can submit the form and requires browser_submit_with_vault_totp approval",
      });
    }
    try {
      const page = await bumpAndAcquire(req);
      const loc = await locate(page, session.id, body.selector);
      const targetHandle = await resolveVaultTarget(loc);
      await describeVaultTarget(targetHandle);
      // Resolve the live Grant only after the target exists, then inspect the
      // target again immediately before filling. A navigation detaches the
      // locator or changes its frame URL and therefore fails closed.
      const resolved = await getVaultItemPayloadForEmployee({
        companyId: session.companyId,
        employeeId: employee.id,
        itemId: body.itemId,
        required: "use",
      });
      const target = await describeVaultTarget(targetHandle);
      if (
        !vaultWebsiteMatchesPage(resolved.payload.websiteUrl, page.url()) ||
        !vaultWebsiteMatchesPage(resolved.payload.websiteUrl, target.frameUrl)
      ) {
        throw new VaultError(
          "Vault origin mismatch: this login can only be used in its exact saved origin",
          403,
        );
      }
      assertVaultBrowserPolicy(employee, page.url(), target.frameUrl);
      if (!vaultFillTargetIsAllowed(resolved.item.type, body.field, target.inputType)) {
        throw new VaultError(
          body.field === "secret"
            ? "Only a Vault login can fill its password into an input with type=password"
            : body.field === "totp"
              ? "A Vault TOTP code can only fill a text, telephone, number, or password input"
              : "That Vault field cannot be filled into the selected element",
          400,
        );
      }
      let totpCode: string | null = null;
      if (body.field === "totp") {
        const freshnessDeadline = Date.now() + 15_000;
        for (;;) {
          const generated = await getVaultTotpCodeForEmployee({
            companyId: session.companyId,
            employeeId: employee.id,
            itemId: body.itemId,
            expectedVersion: resolved.item.version,
          });
          await rememberVaultTotpCode(session.id, generated.code, generated.expiresAt);
          // Generation, recording restriction, and DOM/Grant reads are all
          // asynchronous. Recheck the exact version and target after them,
          // then recompute freshness at the real fill boundary.
          const liveTarget = await describeVaultTarget(targetHandle);
          const liveResolved = await getVaultItemPayloadForEmployee({
            companyId: session.companyId,
            employeeId: employee.id,
            itemId: body.itemId,
            required: "use",
          });
          if (
            liveResolved.item.version !== generated.itemVersion ||
            !vaultWebsiteMatchesPage(liveResolved.payload.websiteUrl, page.url()) ||
            !vaultWebsiteMatchesPage(liveResolved.payload.websiteUrl, liveTarget.frameUrl)
          ) {
            throw new VaultError(
              liveResolved.item.version !== generated.itemVersion
                ? "This Vault login changed before its current one-time code could be filled"
                : "Vault origin mismatch: this login can only be used in its exact saved origin",
              liveResolved.item.version !== generated.itemVersion ? 409 : 403,
            );
          }
          assertVaultBrowserPolicy(employee, page.url(), liveTarget.frameUrl);
          if (!vaultFillTargetIsAllowed(liveResolved.item.type, "totp", liveTarget.inputType)) {
            throw new VaultError(
              "A Vault TOTP code can only fill a text, telephone, number, or password input",
              400,
            );
          }
          const remainingMs = generated.expiresAt.getTime() - Date.now();
          if (remainingMs >= 5_000) {
            totpCode = generated.code;
            break;
          }
          const waitMs = Math.max(50, remainingMs + 50);
          if (Date.now() + waitMs > freshnessDeadline) {
            throw new VaultError(
              "A fresh TOTP window was not available before the Vault fill deadline",
              409,
            );
          }
          await page.waitForTimeout(waitMs);
        }
      }
      const value = body.field === "totp" ? totpCode : resolved.payload[body.field];
      if (!value) throw new VaultError(`This Vault login has no ${body.field} saved`, 400);
      if (body.field === "secret") {
        await rememberVaultSensitiveValue(session.id, value);
      }
      await targetHandle.fill(value, { timeout: ACTION_TIMEOUT_MS });
      await recordAudit({
        companyId: session.companyId,
        actorEmployeeId: employee.id,
        action: "vault.item.use",
        targetType: "vault_item",
        targetId: resolved.item.id,
        targetLabel: "Vault item",
        metadata: { field: body.field },
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({
        ok: true,
        message: `Filled the ${body.field === "secret" ? "stored value" : body.field === "totp" ? "current one-time code" : "username"} field from Vault. The value was not revealed.`,
      });
    } catch (err) {
      if (err instanceof VaultError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      res.status(500).json({
        error:
          body.field === "secret" || body.field === "totp"
            ? `Vault ${body.field === "secret" ? "password" : "one-time code"} fill failed without revealing the value`
            : safeBrowserError(session.id, err),
      });
    }
  },
);

const vaultTotpSubmitSchema = z
  .object({
    approvalId: z.string().uuid().optional(),
    itemId: z.string().uuid(),
    itemVersion: z.number().int().safe().min(1).optional(),
    totpSelector: z.string().min(1).max(500),
    selector: z.string().min(1).max(500),
    key: browserModelPressKeySchema.nullable().optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.approvalId && body.itemVersion === undefined) {
      ctx.addIssue({ code: "custom", path: ["itemVersion"], message: "itemVersion is required" });
    }
  });

function browserApprovalTargetStillMatches(
  expected: BrowserApprovalTargetInspection,
  actual: BrowserApprovalTargetInspection,
): boolean {
  return (
    actual.fingerprint === expected.fingerprint &&
    JSON.stringify(actual.descriptor) === JSON.stringify(expected.descriptor)
  );
}

browserRpcRouter.post(
  "/vault/submit-totp",
  validateBody(vaultTotpSubmitSchema),
  async (req: BrowserRpcReq, res) => {
    const body = req.body as z.infer<typeof vaultTotpSubmitSchema>;
    const session = req.browserSession!;
    const employee = req.browserEmployee!;
    let claimId: string | null = null;
    let submitAttempted = false;
    try {
      if (req.approvalRequired && !body.approvalId) {
        throw new BrowserApprovalError(
          "Submitting a Vault TOTP code requires browser approval",
          409,
        );
      }
      const page = await bumpAndAcquire(req);
      const submitHandle = await resolveVaultTarget(await locate(page, session.id, body.selector));
      const totpHandle = await resolveVaultTarget(
        await locate(page, session.id, body.totpSelector),
      );
      const inspect = () =>
        inspectBrowserApprovalTarget({
          page,
          session,
          employee,
          action: "vault_totp_submit",
          selector: body.selector,
          key: body.key ?? null,
          handle: submitHandle,
          vaultTotp: {
            handle: totpHandle,
            itemId: body.itemId,
            selector: body.totpSelector,
          },
        });
      const assertLiveVaultAccess = async (
        target: BrowserApprovalTargetInspection,
        generatedVersion?: number,
      ) => {
        const resolved = await getVaultItemPayloadForEmployee({
          companyId: session.companyId,
          employeeId: employee.id,
          itemId: body.itemId,
          required: "use",
        });
        if (generatedVersion !== undefined && resolved.item.version !== generatedVersion) {
          throw new BrowserApprovalError(
            "Vault item changed before the current TOTP code could be submitted",
            409,
          );
        }
        if (body.approvalId && resolved.item.version !== body.itemVersion) {
          throw new BrowserApprovalError(
            "Vault item changed after this TOTP submission was approved",
            409,
          );
        }
        assertVaultTotpSubmitTarget({
          employee,
          pageUrl: page.url(),
          websiteUrl: resolved.payload.websiteUrl,
          itemType: resolved.item.type,
          hasTotp: resolved.payload.totp !== null,
          target,
        });
      };

      const approvedTarget = await inspect();
      await assertLiveVaultAccess(approvedTarget);

      if (body.approvalId) {
        const claimed = await claimBrowserActionApproval({
          approvalId: body.approvalId,
          companyId: session.companyId,
          employeeId: employee.id,
          browserSessionId: session.id,
          action: "vault_totp_submit",
          selector: body.selector,
          key: body.key ?? null,
          targetFingerprint: approvedTarget.fingerprint,
          targetDescriptor: approvedTarget.descriptor,
          vaultItemId: body.itemId,
          vaultItemVersion: body.itemVersion,
          vaultTotpSelector: body.totpSelector,
        });
        claimId = claimed.claimId;
      }

      let liveTarget = await inspect();
      if (!browserApprovalTargetStillMatches(approvedTarget, liveTarget)) {
        throw new BrowserApprovalError(
          "Browser target changed while the TOTP approval was being claimed",
          409,
        );
      }
      await assertLiveVaultAccess(liveTarget);

      const freshnessDeadline = Date.now() + 15_000;
      let generated: Awaited<ReturnType<typeof getVaultTotpCodeForEmployee>>;
      for (;;) {
        generated = await getVaultTotpCodeForEmployee({
          companyId: session.companyId,
          employeeId: employee.id,
          itemId: body.itemId,
          ...(body.approvalId ? { expectedVersion: body.itemVersion } : {}),
        });
        await rememberVaultTotpCode(session.id, generated.code, generated.expiresAt);

        // The Vault read above is asynchronous. Recheck both DOM targets,
        // every other form value, the live Grant, the saved origin, and host
        // policy after it completes. If those checks used too much of this
        // TOTP window, wait for the next one and repeat the whole live check.
        liveTarget = await inspect();
        if (!browserApprovalTargetStillMatches(approvedTarget, liveTarget)) {
          throw new BrowserApprovalError(
            "Browser target changed before the current TOTP code could be filled",
            409,
          );
        }
        await assertLiveVaultAccess(liveTarget, generated.itemVersion);
        const remainingMs = generated.expiresAt.getTime() - Date.now();
        if (remainingMs >= 5_000) break;
        const waitMs = Math.max(50, remainingMs + 50);
        if (Date.now() + waitMs > freshnessDeadline) {
          throw new BrowserApprovalError(
            "A fresh TOTP window was not available before the approved submission deadline",
            409,
          );
        }
        await page.waitForTimeout(waitMs);
      }

      // Filling can itself dispatch input/change handlers and some OTP forms
      // auto-submit as soon as the final digit arrives. From this line onward,
      // the claimed approval is therefore terminal and must never be replayed.
      submitAttempted = true;
      await liveTarget.vaultTotpTarget!.handle.fill(generated.code, {
        timeout: ACTION_TIMEOUT_MS,
      });

      // Only the selected TOTP value is normalized in the fingerprint, so a
      // fresh code leaves it stable while any unrelated field or DOM change
      // still invalidates the reviewed action.
      liveTarget = await inspect();
      if (!browserApprovalTargetStillMatches(approvedTarget, liveTarget)) {
        throw new BrowserApprovalError(
          "Browser target changed after the current TOTP code was filled",
          409,
        );
      }
      if (body.key) {
        await liveTarget.handle.press(body.key, { timeout: ACTION_TIMEOUT_MS });
      } else {
        await liveTarget.handle.click({ timeout: ACTION_TIMEOUT_MS });
      }
      if (body.approvalId && claimId) {
        await settleBrowserActionApproval({
          approvalId: body.approvalId,
          claimId,
          succeeded: true,
        });
        claimId = null;
      }
      await recordAudit({
        companyId: session.companyId,
        actorEmployeeId: employee.id,
        action: "vault.item.use",
        targetType: "vault_item",
        targetId: body.itemId,
        targetLabel: "Vault item",
        metadata: { field: "totp", submitted: true },
      });
      await settle(page);
      await awaitAdoption(session.id, ADOPTION_WAIT_MS);
      const current = currentPage(session.id, page);
      res.setHeader("Cache-Control", "no-store");
      res.json({ snapshot: await pageSnapshot(current, session.id) });
    } catch (error) {
      if (body.approvalId && claimId) {
        await settleBrowserActionApproval({
          approvalId: body.approvalId,
          claimId,
          succeeded: submitAttempted,
        }).catch(() => undefined);
      }
      if (error instanceof VaultError || error instanceof BrowserApprovalError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      res.status(500).json({
        error: "Vault TOTP submission failed without revealing the one-time code",
      });
    }
  },
);

const vaultCaptureLoginSchema = z
  .object({
    approvalId: z.string().uuid(),
    selector: z.string().min(1).max(500),
    title: z.string().trim().min(1).max(255),
    username: z.string().trim().max(500).default(""),
    notes: z.string().trim().max(10_000).default(""),
  })
  .strict();

browserRpcRouter.post(
  "/vault/capture-login",
  validateBody(vaultCaptureLoginSchema),
  async (req: BrowserRpcReq, res) => {
    const body = req.body as z.infer<typeof vaultCaptureLoginSchema>;
    const session = req.browserSession!;
    const employee = req.browserEmployee!;
    let claimId: string | null = null;
    let actionAttempted = false;
    // Never on a Member's own machine. Chrome's password manager autofills
    // that field with the human's personal credential, and the approver is any
    // company owner or admin reading a model-supplied title — so the flow
    // would let an employee walk somebody's private password into the company
    // Vault with a plausible label. That credential is not the company's to take.
    if (session.memberBrowserId) {
      return res.status(403).json({
        error:
          "Saving a login to the Vault is not available in a Member's own browser. " +
          "Those credentials belong to the person whose computer it is.",
      });
    }
    try {
      const page = await bumpAndAcquire(req);
      let target = await inspectBrowserApprovalTarget({
        page,
        session,
        employee,
        action: "vault_capture",
        selector: body.selector,
        key: null,
      });
      if (
        target.descriptor.inputType !== "password" ||
        !vaultWebsiteMatchesPage(page.url(), target.descriptor.frameUrl)
      ) {
        throw new VaultError("Vault capture requires a same-origin input with type=password", 400);
      }
      assertVaultBrowserPolicy(employee, page.url(), target.descriptor.frameUrl);
      const claimed = await claimBrowserActionApproval({
        approvalId: body.approvalId,
        companyId: session.companyId,
        employeeId: employee.id,
        browserSessionId: session.id,
        action: "vault_capture",
        selector: body.selector,
        key: null,
        targetFingerprint: target.fingerprint,
        targetDescriptor: target.descriptor,
        vaultTitle: body.title,
        vaultUsername: body.username,
        vaultNotes: body.notes,
      });
      claimId = claimed.claimId;
      const revalidated = await inspectBrowserApprovalTarget({
        page,
        session,
        employee,
        action: "vault_capture",
        selector: body.selector,
        key: null,
        handle: target.handle,
      });
      if (
        revalidated.fingerprint !== target.fingerprint ||
        JSON.stringify(revalidated.descriptor) !== JSON.stringify(target.descriptor) ||
        revalidated.descriptor.inputType !== "password" ||
        !vaultWebsiteMatchesPage(page.url(), revalidated.descriptor.frameUrl)
      ) {
        throw new VaultError("The password target changed before it could be captured", 409);
      }
      target = revalidated;
      assertVaultBrowserPolicy(employee, page.url(), target.descriptor.frameUrl);
      const secret = target.sensitiveValue ?? "";
      if (!secret) throw new VaultError("The selected password field is empty", 400);
      if (secret.length > 10_000) throw new VaultError("The selected password is too long", 400);
      await rememberVaultSensitiveValue(session.id, secret);
      actionAttempted = true;
      const item = await createVaultLoginForEmployee({
        companyId: session.companyId,
        employeeId: employee.id,
        title: body.title,
        username: body.username,
        secret,
        websiteUrl: safeVaultWebsiteUrl(target.descriptor.frameUrl),
        notes: body.notes,
        visibility: "restricted",
      });
      await settleBrowserActionApproval({
        approvalId: body.approvalId,
        claimId,
        succeeded: true,
      });
      claimId = null;
      await recordAudit({
        companyId: session.companyId,
        actorEmployeeId: employee.id,
        action: "vault.item.create",
        targetType: "vault_item",
        targetId: item.id,
        targetLabel: "Vault item",
        metadata: { via: "browser_capture" },
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({
        ok: true,
        itemId: item.id,
        message: `Saved "${item.title}" to Vault with a manage Grant. The captured password was not revealed.`,
      });
    } catch (err) {
      if (claimId) {
        await settleBrowserActionApproval({
          approvalId: body.approvalId,
          claimId,
          succeeded: actionAttempted,
        }).catch(() => undefined);
      }
      if (err instanceof VaultError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      if (err instanceof BrowserApprovalError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      res.status(500).json({
        error: "Vault password capture failed without revealing the selected value",
      });
    }
  },
);

const vaultCaptureTotpSchema = z
  .object({
    selector: z.string().min(1).max(500),
    itemId: z.string().uuid(),
  })
  .strict();

const vaultPrepareTotpSchema = z.object({ itemId: z.string().uuid() }).strict();

browserRpcRouter.post(
  "/vault/prepare-totp",
  validateBody(vaultPrepareTotpSchema),
  async (req: BrowserRpcReq, res) => {
    const body = req.body as z.infer<typeof vaultPrepareTotpSchema>;
    const session = req.browserSession!;
    const employee = req.browserEmployee!;
    if (session.memberBrowserId) {
      return res.status(403).json({
        error:
          "Saving a TOTP setup key is available only in the App-owned Browser, never in a Member browser.",
      });
    }
    try {
      const page = await bumpAndAcquire(req);
      const resolved = await getVaultItemPayloadForEmployee({
        companyId: session.companyId,
        employeeId: employee.id,
        itemId: body.itemId,
        required: "manage",
      });
      if (resolved.item.type !== "login" || resolved.item.createdByEmployeeId !== employee.id) {
        throw new VaultError("AI Employees can only attach TOTP to Vault logins they created", 403);
      }
      if (!vaultWebsiteMatchesPage(resolved.payload.websiteUrl, page.url())) {
        throw new VaultError(
          "Vault origin mismatch: prepare TOTP only on the login's exact saved origin",
          403,
        );
      }
      assertVaultBrowserPolicy(employee, page.url());
      const origin = new URL(page.url()).origin;
      // Arm before the website is asked to reveal enrollment. From this point
      // onward screenshots and the entire Routine recording stay withheld.
      await armVaultTotpSession(session.id);
      vaultTotpCaptureBindings.set(session.id, {
        companyId: session.companyId,
        employeeId: employee.id,
        itemId: body.itemId,
        origin,
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({
        ok: true,
        message:
          "TOTP enrollment is protected. Reveal the website's setup key or QR code, then save it to this Vault login.",
      });
    } catch (error) {
      if (error instanceof VaultError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      res.status(500).json({ error: "The Browser could not prepare protected TOTP enrollment" });
    }
  },
);

browserRpcRouter.post(
  "/vault/capture-totp",
  validateBody(vaultCaptureTotpSchema),
  async (req: BrowserRpcReq, res) => {
    const body = req.body as z.infer<typeof vaultCaptureTotpSchema>;
    const session = req.browserSession!;
    const employee = req.browserEmployee!;
    if (session.memberBrowserId) {
      return res.status(403).json({
        error:
          "Saving a TOTP setup key is available only in the App-owned Browser, never in a Member browser.",
      });
    }
    try {
      const page = await bumpAndAcquire(req);
      const binding = vaultTotpCaptureBindings.get(session.id);
      if (
        !binding ||
        binding.companyId !== session.companyId ||
        binding.employeeId !== employee.id ||
        binding.itemId !== body.itemId ||
        binding.origin !== new URL(page.url()).origin
      ) {
        throw new VaultError(
          "Prepare protected TOTP enrollment for this Vault login before revealing and saving its setup key",
          409,
        );
      }
      const resolved = await getVaultItemPayloadForEmployee({
        companyId: session.companyId,
        employeeId: employee.id,
        itemId: body.itemId,
        required: "manage",
      });
      if (resolved.item.type !== "login" || resolved.item.createdByEmployeeId !== employee.id) {
        throw new VaultError("AI Employees can only attach TOTP to Vault logins they created", 403);
      }
      const locator = await locate(page, session.id, body.selector);
      const handle = await resolveVaultTarget(locator);
      const target = await describeVaultTarget(handle);
      if (
        !vaultWebsiteMatchesPage(resolved.payload.websiteUrl, page.url()) ||
        !vaultWebsiteMatchesPage(resolved.payload.websiteUrl, target.frameUrl)
      ) {
        throw new VaultError(
          "Vault origin mismatch: this login can only store TOTP from its exact saved origin",
          403,
        );
      }
      assertVaultBrowserPolicy(employee, page.url(), target.frameUrl);
      const setupKey = await readTotpSetupKeyFromElement(handle);
      await rememberTotpSetupValue(session.id, setupKey);
      await setVaultTotpForEmployee({
        companyId: session.companyId,
        employeeId: employee.id,
        itemId: body.itemId,
        setupKey,
        expectedVersion: resolved.item.version,
        expectedOrigin: binding.origin,
      });
      vaultTotpCaptureBindings.delete(session.id);
      await recordAudit({
        companyId: session.companyId,
        actorEmployeeId: employee.id,
        action: "vault.item.totp.store",
        targetType: "vault_item",
        targetId: body.itemId,
        targetLabel: "Vault item",
        metadata: { via: "browser_capture" },
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({
        ok: true,
        itemId: body.itemId,
        message:
          "Saved the authenticator setup to this Vault login. The setup key was not revealed.",
      });
    } catch (error) {
      if (error instanceof VaultError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      res.status(400).json({
        error:
          "TOTP capture failed without revealing the setup key. Select the setup-key text, input, QR image, or QR container and try again.",
      });
    }
  },
);

function requireLocalPasskeyBrowser(session: BrowserSession): void {
  if (session.memberBrowserId) {
    throw new VaultError(
      "Vault software passkeys are available only in the App-owned Browser. Genosyn never accesses a Member browser's personal passkeys.",
      403,
    );
  }
}

function pageCdpSession(sessionId: string): {
  send: (method: string, params?: unknown) => Promise<unknown>;
  on?: (event: string, listener: (payload: unknown) => void) => void;
  off?: (event: string, listener: (payload: unknown) => void) => void;
} {
  const cdp = getRuntime(sessionId)?.cdp as
    | {
        send: (method: string, params?: unknown) => Promise<unknown>;
        on?: (event: string, listener: (payload: unknown) => void) => void;
        off?: (event: string, listener: (payload: unknown) => void) => void;
      }
    | undefined;
  if (!cdp) throw new VaultError("The Browser passkey session is unavailable", 409);
  return cdp;
}

const vaultCreatePasskeySchema = z
  .object({
    approvalId: z.string().uuid().optional(),
    itemId: z.string().uuid(),
    itemVersion: z.number().int().safe().min(1).optional(),
    selector: z.string().min(1).max(500),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.approvalId && body.itemVersion === undefined) {
      ctx.addIssue({ code: "custom", path: ["itemVersion"], message: "itemVersion is required" });
    }
  });

const vaultUsePasskeySchema = z
  .object({
    approvalId: z.string().uuid().optional(),
    itemId: z.string().uuid(),
    itemVersion: z.number().int().safe().min(1).optional(),
    passkeyId: z.string().uuid().optional(),
    selector: z.string().min(1).max(500),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.approvalId && body.itemVersion === undefined) {
      ctx.addIssue({ code: "custom", path: ["itemVersion"], message: "itemVersion is required" });
    }
    if (body.approvalId && !body.passkeyId) {
      ctx.addIssue({ code: "custom", path: ["passkeyId"], message: "passkeyId is required" });
    }
  });

function assertVaultPasskeyActionTarget(args: {
  employee: AIEmployee;
  pageUrl: string;
  websiteUrl: string;
  target: BrowserApprovalTargetInspection;
}): void {
  if (!args.target.isTopDocument) {
    throw new VaultError(
      "Vault software passkey actions require a control in the top page, not an iframe",
      403,
    );
  }
  if (
    !vaultWebsiteMatchesPage(args.websiteUrl, args.pageUrl) ||
    !vaultWebsiteMatchesPage(args.websiteUrl, args.target.descriptor.frameUrl)
  ) {
    throw new VaultError(
      "Vault origin mismatch: this passkey can only be used on the login's exact saved origin",
      403,
    );
  }
  assertVaultBrowserPolicy(args.employee, args.pageUrl, args.target.descriptor.frameUrl);
}

browserRpcRouter.post(
  "/vault/passkeys/create",
  validateBody(vaultCreatePasskeySchema),
  async (req: BrowserRpcReq, res) => {
    const body = req.body as z.infer<typeof vaultCreatePasskeySchema>;
    const session = req.browserSession!;
    const employee = req.browserEmployee!;
    let claimId: string | null = null;
    let registrationLeaseId: string | null = null;
    let authenticatorStateId: string | null = null;
    let actionTerminal = false;
    try {
      requireLocalPasskeyBrowser(session);
      if (req.approvalRequired && !body.approvalId) {
        throw new BrowserApprovalError(
          "Creating a Vault software passkey requires browser approval",
          409,
        );
      }
      const page = await bumpAndAcquire(req);
      const targetHandle = await resolveVaultTarget(await locate(page, session.id, body.selector));
      const inspect = () =>
        inspectBrowserApprovalTarget({
          page,
          session,
          employee,
          action: "vault_passkey_create",
          selector: body.selector,
          key: null,
          handle: targetHandle,
        });
      const approvedTarget = await inspect();
      const beforeClaim = await getVaultItemPayloadForEmployee({
        companyId: session.companyId,
        employeeId: employee.id,
        itemId: body.itemId,
        required: "manage",
      });
      if (
        beforeClaim.item.type !== "login" ||
        beforeClaim.item.createdByEmployeeId !== employee.id
      ) {
        throw new VaultError(
          "AI Employees can only attach software passkeys to Vault logins they created",
          403,
        );
      }
      if (body.approvalId && beforeClaim.item.version !== body.itemVersion) {
        throw new BrowserApprovalError(
          "Vault item changed after this passkey creation was approved",
          409,
        );
      }
      assertVaultPasskeyActionTarget({
        employee,
        pageUrl: page.url(),
        websiteUrl: beforeClaim.payload.websiteUrl,
        target: approvedTarget,
      });
      if (body.approvalId) {
        const claimed = await claimBrowserActionApproval({
          approvalId: body.approvalId,
          companyId: session.companyId,
          employeeId: employee.id,
          browserSessionId: session.id,
          action: "vault_passkey_create",
          selector: body.selector,
          key: null,
          targetFingerprint: approvedTarget.fingerprint,
          targetDescriptor: approvedTarget.descriptor,
          vaultItemId: body.itemId,
          vaultItemVersion: body.itemVersion,
        });
        claimId = claimed.claimId;
      }
      const liveTarget = await inspect();
      if (!browserApprovalTargetStillMatches(approvedTarget, liveTarget)) {
        throw new BrowserApprovalError("Browser target changed before passkey creation", 409);
      }
      const live = await getVaultItemPayloadForEmployee({
        companyId: session.companyId,
        employeeId: employee.id,
        itemId: body.itemId,
        required: "manage",
      });
      if (live.item.type !== "login" || live.item.createdByEmployeeId !== employee.id) {
        throw new VaultError(
          "AI Employees can only attach software passkeys to Vault logins they created",
          403,
        );
      }
      if (body.approvalId && live.item.version !== body.itemVersion) {
        throw new BrowserApprovalError("Vault item changed before passkey creation", 409);
      }
      assertVaultPasskeyActionTarget({
        employee,
        pageUrl: page.url(),
        websiteUrl: live.payload.websiteUrl,
        target: liveTarget,
      });

      const registration = await beginVaultPasskeyRegistrationForEmployee({
        companyId: session.companyId,
        employeeId: employee.id,
        itemId: body.itemId,
        expectedVersion: live.item.version,
      });
      registrationLeaseId = registration.registrationLeaseId;
      // Lease acquisition changes the version bound into the Approval, so it
      // is the conservative terminal boundary even before Chrome is injected.
      actionTerminal = true;
      const reservedTarget = await inspect();
      if (!browserApprovalTargetStillMatches(approvedTarget, reservedTarget)) {
        throw new BrowserApprovalError(
          "Browser target changed while passkey creation started",
          409,
        );
      }
      assertVaultPasskeyActionTarget({
        employee,
        pageUrl: page.url(),
        websiteUrl: registration.item.websiteUrl,
        target: reservedTarget,
      });
      const origin = new URL(page.url()).origin;
      const prepared = await prepareVaultPasskeyRegistration(
        session.id,
        pageCdpSession(session.id),
        origin,
      );
      authenticatorStateId = prepared.stateId;
      const injectedTarget = await inspect();
      if (!browserApprovalTargetStillMatches(approvedTarget, injectedTarget)) {
        throw new BrowserApprovalError("Browser target changed before passkey creation", 409);
      }
      assertVaultPasskeyActionTarget({
        employee,
        pageUrl: page.url(),
        websiteUrl: registration.item.websiteUrl,
        target: injectedTarget,
      });
      await clickAndActivateVaultPasskey(
        page,
        injectedTarget.handle,
        session.id,
        prepared.stateId,
        ACTION_TIMEOUT_MS,
      );
      const credential = await prepared.credential;
      const passkey = await finalizeVaultPasskeyRegistrationForEmployee({
        companyId: session.companyId,
        employeeId: employee.id,
        itemId: body.itemId,
        registrationLeaseId: registration.registrationLeaseId,
        credential,
      });
      registrationLeaseId = null;
      authenticatorStateId = null;
      await recordAudit({
        companyId: session.companyId,
        actorEmployeeId: employee.id,
        action: "vault.item.passkey.store",
        targetType: "vault_item",
        targetId: body.itemId,
        targetLabel: "Vault item",
        metadata: { via: "browser_virtual_authenticator", passkeyId: passkey.id },
      });
      if (body.approvalId && claimId) {
        await settleBrowserActionApproval({
          approvalId: body.approvalId,
          claimId,
          succeeded: true,
        });
        claimId = null;
      }
      await settle(page);
      await awaitAdoption(session.id, ADOPTION_WAIT_MS);
      const current = currentPage(session.id, page);
      res.setHeader("Cache-Control", "no-store");
      res.json({ snapshot: await pageSnapshot(current, session.id) });
    } catch (error) {
      if (authenticatorStateId) {
        await clearVaultPasskeyAuthenticator(session.id, authenticatorStateId).catch(
          () => undefined,
        );
        authenticatorStateId = null;
      }
      if (body.approvalId && claimId) {
        await settleBrowserActionApproval({
          approvalId: body.approvalId,
          claimId,
          succeeded: actionTerminal,
        }).catch(() => undefined);
      }
      if (error instanceof VaultError || error instanceof BrowserApprovalError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      res.status(500).json({
        error: "Vault software passkey creation failed without revealing credential material",
      });
    } finally {
      if (authenticatorStateId) {
        await clearVaultPasskeyAuthenticator(session.id, authenticatorStateId).catch(
          () => undefined,
        );
      }
      if (registrationLeaseId) {
        await releaseVaultPasskeyRegistrationForEmployee({
          companyId: session.companyId,
          itemId: body.itemId,
          registrationLeaseId,
        }).catch(() => undefined);
      }
    }
  },
);

browserRpcRouter.post(
  "/vault/passkeys/use",
  validateBody(vaultUsePasskeySchema),
  async (req: BrowserRpcReq, res) => {
    const body = req.body as z.infer<typeof vaultUsePasskeySchema>;
    const session = req.browserSession!;
    const employee = req.browserEmployee!;
    let claimId: string | null = null;
    let lease:
      | { itemId: string; passkeyId: string; leaseId: string; companyId: string }
      | undefined;
    let authenticatorStateId: string | null = null;
    let actionTerminal = false;
    try {
      requireLocalPasskeyBrowser(session);
      if (req.approvalRequired && !body.approvalId) {
        throw new BrowserApprovalError(
          "Using a Vault software passkey requires browser approval",
          409,
        );
      }
      const page = await bumpAndAcquire(req);
      const targetHandle = await resolveVaultTarget(await locate(page, session.id, body.selector));
      const inspect = () =>
        inspectBrowserApprovalTarget({
          page,
          session,
          employee,
          action: "vault_passkey_use",
          selector: body.selector,
          key: null,
          handle: targetHandle,
        });
      const approvedTarget = await inspect();
      const beforeClaim = await getVaultItemPayloadForEmployee({
        companyId: session.companyId,
        employeeId: employee.id,
        itemId: body.itemId,
        required: "use",
      });
      if (beforeClaim.item.type !== "login") {
        throw new VaultError("Software passkeys can only be used from Vault logins", 400);
      }
      const selected = body.passkeyId
        ? beforeClaim.payload.passkeys.find((candidate) => candidate.id === body.passkeyId)
        : beforeClaim.payload.passkeys.length === 1
          ? beforeClaim.payload.passkeys[0]
          : undefined;
      if (!selected) {
        if (!body.passkeyId && beforeClaim.payload.passkeys.length > 1) {
          throw new VaultError("Choose which saved Vault passkey to use", 400);
        }
        throw new VaultError("Vault passkey not found", 404);
      }
      if (body.approvalId && beforeClaim.item.version !== body.itemVersion) {
        throw new BrowserApprovalError(
          "Vault item changed after this passkey use was approved",
          409,
        );
      }
      assertVaultPasskeyActionTarget({
        employee,
        pageUrl: page.url(),
        websiteUrl: beforeClaim.payload.websiteUrl,
        target: approvedTarget,
      });
      if (!vaultPasskeyMatchesPage(selected.rpId, page.url())) {
        throw new VaultError("This passkey belongs to a different relying party", 403);
      }
      if (body.approvalId) {
        const claimed = await claimBrowserActionApproval({
          approvalId: body.approvalId,
          companyId: session.companyId,
          employeeId: employee.id,
          browserSessionId: session.id,
          action: "vault_passkey_use",
          selector: body.selector,
          key: null,
          targetFingerprint: approvedTarget.fingerprint,
          targetDescriptor: approvedTarget.descriptor,
          vaultItemId: body.itemId,
          vaultItemVersion: body.itemVersion,
          vaultPasskeyId: selected.id,
        });
        claimId = claimed.claimId;
      }
      const liveTarget = await inspect();
      if (!browserApprovalTargetStillMatches(approvedTarget, liveTarget)) {
        throw new BrowserApprovalError("Browser target changed before passkey use", 409);
      }
      const resolved = await getVaultPasskeyForEmployee({
        companyId: session.companyId,
        employeeId: employee.id,
        itemId: body.itemId,
        passkeyId: selected.id,
        expectedVersion: body.approvalId ? body.itemVersion : beforeClaim.item.version,
      });
      lease = {
        companyId: session.companyId,
        itemId: body.itemId,
        passkeyId: resolved.passkey.id,
        leaseId: resolved.leaseId,
      };
      actionTerminal = true;
      const leasedTarget = await inspect();
      if (!browserApprovalTargetStillMatches(approvedTarget, leasedTarget)) {
        throw new BrowserApprovalError("Browser target changed while passkey use started", 409);
      }
      assertVaultPasskeyActionTarget({
        employee,
        pageUrl: page.url(),
        websiteUrl: resolved.payload.websiteUrl,
        target: leasedTarget,
      });
      if (!vaultPasskeyMatchesPage(resolved.passkey.rpId, page.url())) {
        throw new VaultError("This passkey belongs to a different relying party", 403);
      }
      const passkeyId = resolved.passkey.id;
      const leaseId = resolved.leaseId;
      const prepared = await prepareVaultPasskeyAuthentication({
        sessionId: session.id,
        cdp: pageCdpSession(session.id),
        expectedOrigin: new URL(page.url()).origin,
        credential: resolved.passkey,
      });
      authenticatorStateId = prepared.stateId;
      const injectedTarget = await inspect();
      if (!browserApprovalTargetStillMatches(approvedTarget, injectedTarget)) {
        throw new BrowserApprovalError("Browser target changed before passkey use", 409);
      }
      assertVaultPasskeyActionTarget({
        employee,
        pageUrl: page.url(),
        websiteUrl: resolved.payload.websiteUrl,
        target: injectedTarget,
      });
      await clickAndActivateVaultPasskey(
        page,
        injectedTarget.handle,
        session.id,
        prepared.stateId,
        ACTION_TIMEOUT_MS,
      );
      const credential = await prepared.assertion;
      await recordVaultPasskeyUseForEmployee({
        companyId: session.companyId,
        employeeId: employee.id,
        itemId: body.itemId,
        passkeyId,
        leaseId,
        credential,
      });
      lease = undefined;
      authenticatorStateId = null;
      await recordAudit({
        companyId: session.companyId,
        actorEmployeeId: employee.id,
        action: "vault.item.use",
        targetType: "vault_item",
        targetId: body.itemId,
        targetLabel: "Vault item",
        metadata: { field: "passkey", passkeyId },
      });
      if (body.approvalId && claimId) {
        await settleBrowserActionApproval({
          approvalId: body.approvalId,
          claimId,
          succeeded: true,
        });
        claimId = null;
      }
      await settle(page);
      await awaitAdoption(session.id, ADOPTION_WAIT_MS);
      const current = currentPage(session.id, page);
      res.setHeader("Cache-Control", "no-store");
      res.json({ snapshot: await pageSnapshot(current, session.id) });
    } catch (error) {
      if (authenticatorStateId) {
        await clearVaultPasskeyAuthenticator(session.id, authenticatorStateId).catch(
          () => undefined,
        );
        authenticatorStateId = null;
      }
      if (body.approvalId && claimId) {
        await settleBrowserActionApproval({
          approvalId: body.approvalId,
          claimId,
          succeeded: actionTerminal,
        }).catch(() => undefined);
      }
      if (error instanceof VaultError || error instanceof BrowserApprovalError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      res.status(500).json({
        error: "Vault software passkey use failed without revealing credential material",
      });
    } finally {
      if (authenticatorStateId) {
        await clearVaultPasskeyAuthenticator(session.id, authenticatorStateId).catch(
          () => undefined,
        );
      }
      if (lease) {
        await releaseVaultPasskeyUseForEmployee({
          companyId: lease.companyId,
          itemId: lease.itemId,
          passkeyId: lease.passkeyId,
          leaseId: lease.leaseId,
        }).catch(() => undefined);
      }
    }
  },
);

const pressSchema = z
  .object({
    key: browserModelPressKeySchema,
    selector: z.string().max(500).optional(),
    approvalId: z.string().uuid().optional(),
  })
  .strict();
browserRpcRouter.post("/press", validateBody(pressSchema), async (req: BrowserRpcReq, res) => {
  const body = req.body as z.infer<typeof pressSchema>;
  const session = req.browserSession!;
  const employee = req.browserEmployee!;
  let claimId: string | null = null;
  let actionAttempted = false;
  let guardedPage: Page | null = null;
  try {
    const page = await bumpAndAcquire(req);
    if (req.approvalRequired && browserKeyMaySubmit(body.key) && !body.approvalId) {
      throw new BrowserApprovalError(
        "Pressing Enter or Space can submit a form and requires browser_submit approval",
        409,
      );
    }
    if (body.approvalId) {
      if (!body.selector) {
        throw new BrowserApprovalError(
          "An approved browser key action must remain bound to its selector",
          409,
        );
      }
      let target = await inspectBrowserApprovalTarget({
        page,
        session,
        employee,
        action: "submit",
        selector: body.selector,
        key: body.key,
      });
      const claimed = await claimBrowserActionApproval({
        approvalId: body.approvalId,
        companyId: session.companyId,
        employeeId: employee.id,
        browserSessionId: session.id,
        action: "submit",
        selector: body.selector,
        key: body.key,
        targetFingerprint: target.fingerprint,
        targetDescriptor: target.descriptor,
      });
      claimId = claimed.claimId;
      const revalidated = await inspectBrowserApprovalTarget({
        page,
        session,
        employee,
        action: "submit",
        selector: body.selector,
        key: body.key,
        handle: target.handle,
      });
      if (
        revalidated.fingerprint !== target.fingerprint ||
        JSON.stringify(revalidated.descriptor) !== JSON.stringify(target.descriptor)
      ) {
        throw new BrowserApprovalError(
          "Browser target changed while the approval was being claimed",
          409,
        );
      }
      target = revalidated;
      actionAttempted = true;
      await target.handle.press(body.key, { timeout: ACTION_TIMEOUT_MS });
      await settleBrowserActionApproval({
        approvalId: body.approvalId,
        claimId,
        succeeded: true,
      });
      claimId = null;
    } else {
      if (req.approvalRequired) {
        await armUnapprovedFormSubmitGuard(page);
        guardedPage = page;
      }
      if (body.selector && body.selector.length > 0) {
        const loc = await locate(page, session.id, body.selector);
        await loc.press(body.key, { timeout: ACTION_TIMEOUT_MS });
      } else {
        await page.keyboard.press(body.key);
      }
    }
    await settle(page);
    if (guardedPage) {
      const blocked = await disarmUnapprovedFormSubmitGuard(guardedPage);
      guardedPage = null;
      if (blocked) {
        throw new BrowserApprovalError(
          "This key action attempted to submit a form and requires browser_submit approval",
          409,
        );
      }
    }
    await awaitAdoption(session.id, ADOPTION_WAIT_MS);
    const p = currentPage(session.id, page);
    res.json({ snapshot: await pageSnapshot(p, session.id) });
  } catch (err) {
    if (guardedPage) await disarmUnapprovedFormSubmitGuard(guardedPage);
    if (body.approvalId && claimId) {
      await settleBrowserActionApproval({
        approvalId: body.approvalId,
        claimId,
        succeeded: actionAttempted,
      }).catch(() => undefined);
    }
    if (err instanceof BrowserApprovalError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    res.status(500).json({ error: safeBrowserError(session.id, err) });
  }
});

const selectSchema = z.object({
  selector: z.string().min(1).max(500),
  value: z.string().max(500),
});
browserRpcRouter.post("/select", validateBody(selectSchema), async (req: BrowserRpcReq, res) => {
  const body = req.body as z.infer<typeof selectSchema>;
  const sessionId = req.browserSession!.id;
  try {
    const page = await bumpAndAcquire(req);
    const loc = await locate(page, sessionId, body.selector);
    // Try the option's `value` attribute first, then its visible label —
    // the model usually quotes whichever it saw in the snapshot. Both share
    // one ACTION_TIMEOUT_MS budget so a genuinely stuck element can't cost
    // 2×, and the first error is surfaced if the label retry also misses.
    const started = Date.now();
    try {
      await loc.selectOption(body.value, { timeout: ACTION_TIMEOUT_MS });
    } catch (firstErr) {
      const remaining = Math.max(500, ACTION_TIMEOUT_MS - (Date.now() - started));
      try {
        await loc.selectOption({ label: body.value }, { timeout: remaining });
      } catch {
        throw firstErr;
      }
    }
    await settle(page);
    res.json({ snapshot: await pageSnapshot(page, sessionId) });
  } catch (err) {
    res.status(500).json({ error: safeBrowserError(req.browserSession!.id, err) });
  }
});

const hoverSchema = z.object({ selector: z.string().min(1).max(500) });
browserRpcRouter.post("/hover", validateBody(hoverSchema), async (req: BrowserRpcReq, res) => {
  const body = req.body as z.infer<typeof hoverSchema>;
  const sessionId = req.browserSession!.id;
  try {
    const page = await bumpAndAcquire(req);
    const loc = await locate(page, sessionId, body.selector);
    await loc.hover({ timeout: ACTION_TIMEOUT_MS });
    await settle(page);
    res.json({ snapshot: await pageSnapshot(page, sessionId) });
  } catch (err) {
    res.status(500).json({ error: safeBrowserError(req.browserSession!.id, err) });
  }
});

const scrollSchema = z.object({
  direction: z.enum(["up", "down"]).optional(),
  selector: z.string().max(500).optional(),
});
browserRpcRouter.post("/scroll", validateBody(scrollSchema), async (req: BrowserRpcReq, res) => {
  const body = req.body as z.infer<typeof scrollSchema>;
  const sessionId = req.browserSession!.id;
  try {
    const page = await bumpAndAcquire(req);
    if (body.selector && body.selector.length > 0) {
      const loc = await locate(page, sessionId, body.selector);
      await loc.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
    } else {
      // A wheel gesture (not scrollBy) so infinite-scroll listeners fire.
      const dy = body.direction === "up" ? -640 : 640;
      await page.mouse.wheel(0, dy);
    }
    await settle(page);
    res.json({ snapshot: await pageSnapshot(page, sessionId) });
  } catch (err) {
    res.status(500).json({ error: safeBrowserError(req.browserSession!.id, err) });
  }
});

browserRpcRouter.post("/back", async (req: BrowserRpcReq, res) => {
  const sessionId = req.browserSession!.id;
  try {
    const page = await bumpAndAcquire(req);
    const result = await page.goBack({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    if (result === null) {
      pushSessionNotice(sessionId, "There is no earlier page in this tab's history — staying put.");
    } else {
      await settle(page);
    }
    res.json({ snapshot: await pageSnapshot(page, sessionId) });
  } catch (err) {
    res.status(500).json({ error: safeBrowserError(req.browserSession!.id, err) });
  }
});

const waitSchema = z
  .object({
    selector: z.string().max(500).optional(),
    ms: z.number().int().min(1).max(WAIT_MAX_MS).optional(),
  })
  .refine((v) => v.selector || v.ms, { message: "Pass `selector`, `ms`, or both" });
browserRpcRouter.post("/wait", validateBody(waitSchema), async (req: BrowserRpcReq, res) => {
  const body = req.body as z.infer<typeof waitSchema>;
  const sessionId = req.browserSession!.id;
  try {
    const page = await bumpAndAcquire(req);
    if (body.ms) await page.waitForTimeout(body.ms);
    if (body.selector && body.selector.length > 0) {
      const loc = page.locator(body.selector).first();
      await loc.waitFor({ state: "visible", timeout: WAIT_MAX_MS });
    }
    res.json({ snapshot: await pageSnapshot(page, sessionId) });
  } catch (err) {
    res.status(500).json({ error: safeBrowserError(req.browserSession!.id, err) });
  }
});

browserRpcRouter.post("/screenshot", async (req: BrowserRpcReq, res) => {
  const sessionId = req.browserSession!.id;
  if (vaultTaintedSessions.has(sessionId)) {
    return res.status(409).json({
      error:
        "Screenshot unavailable after a password, one-time code, or authenticator setup key is present in this browser session; use the redacted page snapshot instead",
    });
  }
  try {
    const page = await bumpAndAcquire(req);
    if (vaultTaintedSessions.has(sessionId)) {
      return res.status(409).json({
        error:
          "Screenshot unavailable after a password, one-time code, or authenticator setup key is present in this browser session; use the redacted page snapshot instead",
      });
    }
    // Capture once, inspect those exact lossless bytes, then transcode those
    // same bytes for the model. A safety capture followed by a second JPEG
    // capture would leave a race in which a setup QR could appear only in the
    // returned image. Mask every password input in every frame as well. This
    // protects a password typed by a human immediately before the first
    // semantic snapshot has had a chance to observe and taint the session.
    const passwordMasks = page.frames().map((frame) => frame.locator('input[type="password"]'));
    const png = await page.screenshot({
      type: "png",
      fullPage: false,
      mask: passwordMasks,
      maskColor: "#000000",
    });
    const qrValue = await decodeQrFromImage(png);
    if (qrValue !== null) {
      const setupKey = findTotpSetupKeyInText(qrValue);
      if (setupKey) await rememberTotpSetupValue(sessionId, setupKey);
      return res.status(409).json({
        error:
          "Screenshot unavailable because it contains a QR code that could conceal authenticator setup data; use the redacted page snapshot instead",
      });
    }
    const buf = await transcodeImageToJpeg(png, 60);
    res.json({ data: buf.toString("base64"), mimeType: "image/jpeg" });
  } catch (err) {
    res.status(500).json({ error: safeBrowserError(req.browserSession!.id, err) });
  }
});

browserRpcRouter.post("/close", async (req: BrowserRpcReq, res) => {
  const session = req.browserSession!;
  // Only tear down if no viewer is watching — humans actively in the
  // panel shouldn't be stomped by a model that decides to call
  // browser_close at the end of its turn.
  const runtime = getRuntime(session.id);
  if (!runtime) {
    clearVaultSensitiveValuesForSession(session.id);
    return res.json({ ok: true });
  }
  if (runtime.activeHolders > 0) {
    return res.json({ ok: true, kept: "viewer-active" });
  }
  await releasePage(session.id, "shutdown");
  clearVaultSensitiveValuesForSession(session.id);
  res.json({ ok: true });
});
