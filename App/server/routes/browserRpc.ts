import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { BrowserSession } from "../db/entities/BrowserSession.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import type { VaultItemType } from "../db/entities/VaultItem.js";
import { validateBody } from "../middleware/validate.js";
import {
  resolveBrowserSessionToken,
  markSessionLive,
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
  createVaultLoginForEmployee,
  getVaultItemPayloadForEmployee,
  VaultError,
} from "../services/vault.js";
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
  req.browserSession = row;
  req.browserEmployee = emp;
  next();
}

browserRpcRouter.use(requireBrowserSession);

// ---------- helpers ----------

type Page = {
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
};

type BrowserApprovalTargetInspection = {
  handle: ElementHandle;
  descriptor: BrowserApprovalTargetDescriptor;
  fingerprint: string;
  /** Returned only inside this server process and never serialized. */
  sensitiveValue: string | null;
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
    (element, context) => {
      const input = element instanceof HTMLInputElement ? element : null;
      const button = element instanceof HTMLButtonElement ? element : null;
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
                  control.type.toLowerCase() === "file"
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
      const frameUrl =
        element.ownerDocument.defaultView?.location.href ?? element.ownerDocument.URL;
      return {
        descriptor: {
          tagName,
          inputType,
          frameUrl,
          formAction: effectiveAction,
          formMethod: effectiveMethod?.toUpperCase() ?? null,
          submitsForm,
        },
        targetMaterial: {
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
        },
        sensitiveValue: context.action === "vault_capture" && input ? input.value : null,
      };
    },
    { action: args.action, key: args.key },
  );
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
  return { handle, descriptor, fingerprint, sensitiveValue: inspected.sensitiveValue };
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

export function vaultFillTargetIsAllowed(
  itemType: VaultItemType,
  field: "username" | "secret",
  inputType: string | null,
): boolean {
  if (field !== "secret") return true;
  return itemType === "login" && inputType?.toLowerCase() === "password";
}

function rememberVaultSensitiveValue(sessionId: string, value: string): void {
  if (!value) return;
  vaultTaintedSessions.add(sessionId);
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
    return;
  }
  // Keep the bounded value set for the whole BrowserSession. Password reveal
  // controls can change an input to type=text long after the original fill;
  // expiring the scrub value would then disclose it in a later snapshot.
  values.set(value, Date.now());
}

export function clearVaultSensitiveValuesForSession(sessionId: string): void {
  vaultSensitiveValuesBySession.delete(sessionId);
  vaultTaintedSessions.delete(sessionId);
  vaultSensitiveOverflowSessions.delete(sessionId);
}

registerBrowserSessionCleanup(clearVaultSensitiveValuesForSession);
export function observeBrowserSensitiveValue(
  sessionId: string,
  value: string,
  kind: "password-present" | "password-value" | "active-input-value",
): void {
  if (kind === "password-present") {
    vaultTaintedSessions.add(sessionId);
    return;
  }
  if (kind === "password-value" || vaultTaintedSessions.has(sessionId)) {
    rememberVaultSensitiveValue(sessionId, value);
  }
}

registerBrowserSensitiveValueListener(observeBrowserSensitiveValue);

export function redactVaultSensitiveText(sessionId: string, text: string): string {
  if (vaultSensitiveOverflowSessions.has(sessionId)) {
    return "[redacted because this BrowserSession exceeded the sensitive-value safety limit]";
  }
  let redacted = text;
  for (const value of vaultSensitiveValuesBySession.get(sessionId)?.keys() ?? []) {
    const escaped = JSON.stringify(value).slice(1, -1);
    for (const candidate of new Set([value, escaped])) {
      if (candidate) redacted = redacted.split(candidate).join("[redacted Vault value]");
    }
  }
  return redacted;
}

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

function parseAllowList(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("#"));
}

/**
 * Allow-list matching rules (documented in the UI hint and the Browser docs
 * page — keep all three in sync). A bare host is an EXACT match so an
 * operator can pin one host precisely; use the `*.` form for subdomains:
 *   - `mail.google.com` → that exact host, and nothing else
 *   - `*.example.com`   → the apex `example.com` and every subdomain
 *   - `app.*.example.com` → a general glob, matched label-safely (each `*`
 *                           spans one label, never a dot)
 */
function hostMatches(hostname: string, pattern: string): boolean {
  const h = hostname.toLowerCase();
  const p = pattern.toLowerCase();
  if (!p.includes("*")) {
    return h === p;
  }
  if (p.startsWith("*.")) {
    const suffix = p.slice(2);
    if (h === suffix) return true;
    if (h.endsWith("." + suffix)) return true;
    return false;
  }
  // General glob. `*` matches within a single DNS label only — it must not
  // cross a dot, or `example.*` would admit `example.attacker.com`. Escaping
  // every metachar first also keeps the pattern ReDoS-free.
  const escaped = p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^.]*");
  return new RegExp(`^${escaped}$`).test(h);
}

function urlAllowed(
  url: string,
  allowList: string[],
): { ok: true } | { ok: false; reason: string } {
  if (allowList.length === 0) return { ok: true };
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return { ok: false, reason: "URL is not parseable" };
  }
  for (const pattern of allowList) {
    if (hostMatches(host, pattern)) return { ok: true };
  }
  return {
    ok: false,
    reason: `Host \`${host}\` is not in the allow list. Allowed: ${allowList.join(", ")}`,
  };
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
        rememberVaultSensitiveValue(sessionId, value);
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
    if (observation.present) vaultTaintedSessions.add(sessionId);
    for (const value of observation.values) rememberVaultSensitiveValue(sessionId, value);
  }
}

async function bumpAndAcquire(req: BrowserRpcReq): Promise<Page> {
  const session = req.browserSession!;
  markActivity(session.id);
  const page = (await acquirePage(session.id)) as Page;
  // Observe password fields before any model action can click a reveal
  // control or otherwise mutate their type/value. Values stay scrubbed for
  // the lifetime of this BrowserSession.
  await rememberCurrentPasswordValues(page, session.id);
  await markSessionLive(session.id);
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
    action: z.enum(["submit", "vault_capture"]),
    selector: z.string().min(1).max(500),
    key: browserModelPressKeySchema.nullable().optional(),
  })
  .strict();

browserRpcRouter.post(
  "/approval/describe-target",
  validateBody(describeApprovalTargetSchema),
  async (req: BrowserRpcReq, res) => {
    const body = req.body as z.infer<typeof describeApprovalTargetSchema>;
    const session = req.browserSession!;
    const employee = req.browserEmployee!;
    try {
      const page = await bumpAndAcquire(req);
      const target = await inspectBrowserApprovalTarget({
        page,
        session,
        employee,
        action: body.action,
        selector: body.selector,
        key: body.key ?? null,
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
      }
      res.setHeader("Cache-Control", "no-store");
      res.json({
        pageUrl: safeBrowserApprovalTargetUrl(page.url()),
        targetFingerprint: target.fingerprint,
        targetDescriptor: target.descriptor,
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
    if (!employee.browserApprovalRequired && !body.approvalId) {
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
    field: z.enum(["username", "secret"]),
  })
  .strict();

browserRpcRouter.post(
  "/vault/fill",
  validateBody(vaultFillSchema),
  async (req: BrowserRpcReq, res) => {
    const body = req.body as z.infer<typeof vaultFillSchema>;
    const session = req.browserSession!;
    const employee = req.browserEmployee!;
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
            : "That Vault field cannot be filled into the selected element",
          400,
        );
      }
      const value = resolved.payload[body.field];
      if (!value) throw new VaultError(`This Vault login has no ${body.field} saved`, 400);
      if (body.field === "secret") rememberVaultSensitiveValue(session.id, value);
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
        message: `Filled the ${body.field === "secret" ? "stored value" : "username"} field from Vault. The value was not revealed.`,
      });
    } catch (err) {
      if (err instanceof VaultError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      res.status(500).json({
        error:
          body.field === "secret"
            ? "Vault password fill failed without revealing the stored value"
            : safeBrowserError(session.id, err),
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
      rememberVaultSensitiveValue(session.id, secret);
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
    if (employee.browserApprovalRequired && browserKeyMaySubmit(body.key) && !body.approvalId) {
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
      if (employee.browserApprovalRequired) {
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
        "Screenshot unavailable after a password is present in this browser session; use the redacted page snapshot instead",
    });
  }
  try {
    const page = await bumpAndAcquire(req);
    if (vaultTaintedSessions.has(sessionId)) {
      return res.status(409).json({
        error:
          "Screenshot unavailable after a password is present in this browser session; use the redacted page snapshot instead",
      });
    }
    // JPEG at the same quality as the live-view screencast — 3-5x smaller
    // than PNG in the model's context for visually identical content.
    // Mask every password input in every frame at capture time. This also
    // protects a password typed by a human immediately before the first
    // semantic snapshot has had a chance to observe and taint the session.
    const passwordMasks = page.frames().map((frame) => frame.locator('input[type="password"]'));
    const buf = await page.screenshot({
      type: "jpeg",
      quality: 60,
      fullPage: false,
      mask: passwordMasks,
      maskColor: "#000000",
    });
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
