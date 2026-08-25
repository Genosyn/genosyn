/**
 * Human-like browser input.
 *
 * The browser tools used to enter text with Playwright's `fill()`, which sets
 * an input's value in a single shot, and to click with `click()`, which jumps
 * the pointer straight to the element's centre. Both are invisible to a human
 * watching the live view, and both are loud to the sites that watch instead: a
 * sign-in form that receives a username and password with zero
 * `keydown`/`keyup` events, from a pointer that teleports, is a textbook
 * automation signature. X, Google and the major anti-bot vendors score exactly
 * this telemetry, which is why an AI Employee's login gets challenged from the
 * same IP address a human signs in from cleanly. The browser itself is honest —
 * real headed Chrome, nothing spoofed (see {@link ./browserProfile}) — so the
 * only thing left contradicting "a person is using this" was *how* the input
 * arrived.
 *
 * This module re-enters that input the way a person does. Text is typed one
 * character at a time with small randomised gaps, so the field fills through
 * real key events with plausible cadence. A click is preceded by a short
 * pointer approach across the page and pressed with a realistic dwell between
 * down and up.
 *
 * Three properties are load-bearing and must survive any change here:
 *
 *  * **It changes only how the value arrives, never what.** A Vault secret is
 *    typed into the same field `fill()` would have set, is never returned or
 *    logged, and stays under the same password-taint redaction. The caller's
 *    ordering — taint the value, then enter it — is preserved because this is a
 *    drop-in for the `fill()`/`click()` call, nothing more.
 *  * **Playwright's actionability guarantees are preserved.** The final press is
 *    left to `click()`, which still waits for the element to be visible, stable,
 *    enabled and hit-testable. The pointer approach is decoration in front of
 *    that, not a replacement for it.
 *  * **It never makes an action less reliable than the plain one.** Every helper
 *    feature-detects the richer methods it needs and falls back to the original
 *    `fill()` / `click()` when they are absent (a partial test double, an exotic
 *    Playwright build) or when the human path throws part-way. A humanised fill
 *    that fails re-issues `fill(value)`, which sets the complete, correct value
 *    regardless of what was typed first.
 *
 * It is camouflage, not challenge-solving: none of this touches a captcha or
 * defeats a proof-of-work. When a site still challenges, the session stops and
 * a human takes over — same contract as the rest of the browser layer.
 */

import { config } from "../../config.js";

/**
 * The parts of Playwright's Page / Locator / ElementHandle the helpers reach
 * for. Every method is optional so a Locator, an ElementHandle, and a partial
 * test double all satisfy the shape; the helpers check before calling. Kept
 * structural to avoid pulling Playwright's full types into this layer, matching
 * the rest of the browser services.
 */
type BoundingBox = { x: number; y: number; width: number; height: number };

export type HumanKeyboard = {
  type?: (text: string, opts?: { delay?: number }) => Promise<void>;
  press?: (key: string, opts?: { delay?: number }) => Promise<void>;
};

export type HumanMouse = {
  move?: (x: number, y: number, opts?: { steps?: number }) => Promise<void>;
  // Unused here, but a real Playwright mouse carries it; naming it keeps this
  // type structurally compatible with the callers' fuller Page shape.
  wheel?: (dx: number, dy: number) => Promise<void>;
};

export type HumanPage = {
  keyboard?: HumanKeyboard;
  mouse?: HumanMouse;
};

export type HumanInputTarget = {
  fill: (value: string, opts?: unknown) => Promise<void>;
  click: (opts?: unknown) => Promise<void>;
  focus?: (opts?: unknown) => Promise<void>;
  hover?: (opts?: unknown) => Promise<void>;
  pressSequentially?: (text: string, opts?: { delay?: number; timeout?: number }) => Promise<void>;
  type?: (text: string, opts?: { delay?: number }) => Promise<void>;
  boundingBox?: () => Promise<BoundingBox | null>;
  scrollIntoViewIfNeeded?: (opts?: unknown) => Promise<void>;
};

/** A Locator, an ElementHandle, or a page keyboard — anything that presses a key. */
export type HumanPresser = {
  press: (key: string, opts?: unknown) => Promise<void>;
};

/**
 * Longer than any real credential, code, or search box. A field genuinely
 * receiving more than this is not the login telemetry we are hiding from, and
 * hand-typing it would blow the action budget — so it goes in with one `fill()`.
 */
const HUMAN_TYPE_MAX_CHARS = 80;

/** Per-keystroke gap. A spread, not a constant — a metronome is its own tell. */
const KEY_DELAY_MIN_MS = 18;
const KEY_DELAY_MAX_MS = 95;
/** Once in a while a person pauses mid-word; this is that, kept rare and short. */
const KEY_HESITATION_CHANCE = 0.06;
const KEY_HESITATION_MIN_MS = 120;
const KEY_HESITATION_MAX_MS = 340;

/** The pause between arriving at a control and pressing it. */
const PRE_CLICK_MIN_MS = 40;
const PRE_CLICK_MAX_MS = 150;
/** How long the mouse button — or a key — is held down. */
const CLICK_DWELL_MIN_MS = 45;
const CLICK_DWELL_MAX_MS = 120;

/**
 * A person does not jump from one field to the next in zero time; they read the
 * label, find the box, and move. This is that gap, kept short so it reads as
 * focus rather than lag. Every ceiling stays well under the action budget, and
 * it is deliberately kept OFF the time-boxed one-time-code paths — a pause there
 * would burn the code's freshness window and fail the submit closed.
 */
const THINK_PAUSE_MIN_MS = 120;
const THINK_PAUSE_MAX_MS = 600;

let humanInputEnabledForTests: boolean | null = null;

/**
 * Force the humanised path on or off for a test, bypassing config. Pass `null`
 * to restore the configured behaviour. Useful both to assert the human path
 * fires and to keep a timing-sensitive test on the instant path.
 */
export function setHumanInputEnabledForTests(value: boolean | null): void {
  humanInputEnabledForTests = value;
}

/** Whether input should be humanised. Defaults on; `config.browser.humanize`
 *  turns it off for a trusted environment that wants raw speed. */
export function humanInputEnabled(): boolean {
  if (humanInputEnabledForTests !== null) return humanInputEnabledForTests;
  return config.browser.humanize !== false;
}

function randBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randInt(min: number, max: number): number {
  return Math.round(randBetween(min, max));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Enter `value` into `target` the way a person would: focus, clear, then type
 * character by character with jittered gaps. Falls back to the exact original
 * `target.fill(value, opts)` when humanising is off, the value is too long to
 * hand-type, or the human path throws — so the field always ends holding
 * `value` and nothing else.
 */
export async function humanFill(
  page: HumanPage | null,
  target: HumanInputTarget,
  value: string,
  opts?: unknown,
): Promise<void> {
  if (!humanInputEnabled() || value.length === 0 || value.length > HUMAN_TYPE_MAX_CHARS) {
    await target.fill(value, opts);
    return;
  }
  try {
    if (target.focus) await target.focus();
    // Start from an empty field. `fill("")` clears without emitting the
    // credential; the characters that matter for telemetry are the ones typed
    // in below.
    await target.fill("", opts);

    const keyboard = page?.keyboard;
    if (keyboard?.type) {
      for (const char of value) {
        await keyboard.type(char);
        await sleep(randInt(KEY_DELAY_MIN_MS, KEY_DELAY_MAX_MS));
        if (Math.random() < KEY_HESITATION_CHANCE) {
          await sleep(randInt(KEY_HESITATION_MIN_MS, KEY_HESITATION_MAX_MS));
        }
      }
      return;
    }
    // No page keyboard reachable (e.g. an ElementHandle without a page handle):
    // use the locator/handle's own sequential typer, which still emits real key
    // events, with a single randomised cadence for the whole string.
    if (target.pressSequentially) {
      await target.pressSequentially(value, { delay: randInt(KEY_DELAY_MIN_MS, KEY_DELAY_MAX_MS) });
      return;
    }
    if (target.type) {
      await target.type(value, { delay: randInt(KEY_DELAY_MIN_MS, KEY_DELAY_MAX_MS) });
      return;
    }
    await target.fill(value, opts);
  } catch {
    // Any failure part-way through must not leave a half-typed credential.
    // `fill(value)` sets the whole value in one shot — the plain, always-correct
    // behaviour this helper stands in for.
    await target.fill(value, opts);
  }
}

/**
 * Click `target` after a short pointer approach and with a realistic press
 * dwell. The approach is best-effort decoration; the click itself is the
 * unchanged `target.click(opts)`, so actionability waits and error behaviour
 * are exactly as before.
 */
export async function humanClick(
  page: HumanPage | null,
  target: HumanInputTarget,
  opts?: Record<string, unknown>,
): Promise<void> {
  if (!humanInputEnabled()) {
    await target.click(opts);
    return;
  }
  try {
    if (target.scrollIntoViewIfNeeded) await target.scrollIntoViewIfNeeded(opts);
  } catch {
    // click() will scroll it into view itself; the approach is optional.
  }
  try {
    const mouse = page?.mouse;
    if (mouse?.move && target.boundingBox) {
      const box = await target.boundingBox();
      if (box && box.width > 0 && box.height > 0) {
        // Aim for a believable spot inside the control rather than dead centre,
        // and travel there over several steps so the move emits a trail of
        // `mousemove` events instead of a jump.
        const x = box.x + box.width * randBetween(0.3, 0.7);
        const y = box.y + box.height * randBetween(0.3, 0.7);
        await mouse.move(x, y, { steps: randInt(12, 24) });
        await sleep(randInt(PRE_CLICK_MIN_MS, PRE_CLICK_MAX_MS));
      }
    }
  } catch {
    // A browser that won't report geometry still gets a normal click below.
  }
  await target.click({ ...(opts ?? {}), delay: randInt(CLICK_DWELL_MIN_MS, CLICK_DWELL_MAX_MS) });
}

/**
 * Hover `target`, approaching it with a short pointer move first. Falls back to
 * the plain `target.hover(opts)` when humanising is off or geometry is
 * unavailable.
 */
export async function humanHover(
  page: HumanPage | null,
  target: HumanInputTarget,
  opts?: Record<string, unknown>,
): Promise<void> {
  if (!humanInputEnabled() || !target.hover) {
    if (target.hover) await target.hover(opts);
    return;
  }
  try {
    const mouse = page?.mouse;
    if (mouse?.move && target.boundingBox) {
      const box = await target.boundingBox();
      if (box && box.width > 0 && box.height > 0) {
        const x = box.x + box.width * randBetween(0.3, 0.7);
        const y = box.y + box.height * randBetween(0.3, 0.7);
        await mouse.move(x, y, { steps: randInt(12, 24) });
        await sleep(randInt(PRE_CLICK_MIN_MS, PRE_CLICK_MAX_MS));
      }
    }
  } catch {
    // fall through to the plain hover
  }
  await target.hover(opts);
}

/**
 * Press a key with a realistic hold between down and up, instead of the
 * instantaneous default. Used for the Enter/submit keystroke that ends a login
 * — the last step of the flow that was still arriving raw.
 *
 * `key` is a key *name* (`Enter`, `Control+A`), never a secret, so there is
 * nothing to redact. This is a straight drop-in for `presser.press(key, opts)`:
 * it adds only a `delay`, and it deliberately does NOT catch — a press that
 * fails must surface exactly as the plain one did, so the form-submit approval
 * bracketing and settle logic around these calls still run.
 */
export async function humanPress(
  presser: HumanPresser,
  key: string,
  opts?: Record<string, unknown>,
): Promise<void> {
  if (!humanInputEnabled()) {
    await presser.press(key, opts);
    return;
  }
  await presser.press(key, {
    ...(opts ?? {}),
    delay: randInt(CLICK_DWELL_MIN_MS, CLICK_DWELL_MAX_MS),
  });
}

/**
 * A short, randomised gap before an action, so a sequence of tool calls does
 * not arrive as an inhumanly even machine-gun of input. No-op when humanising
 * is off.
 *
 * Callers MUST NOT place this on a time-boxed one-time-code path: a one-time
 * code is generated against a freshness deadline and any pause before it is
 * entered or submitted can expire the window and fail the action closed. Guard
 * the call at the site (skip it when the field is a TOTP) rather than teaching
 * this helper about Vault.
 */
export async function humanThinkPause(): Promise<void> {
  if (!humanInputEnabled()) return;
  await sleep(randInt(THINK_PAUSE_MIN_MS, THINK_PAUSE_MAX_MS));
}
