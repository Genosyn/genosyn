import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  humanClick,
  humanFill,
  humanHover,
  humanInputEnabled,
  humanPress,
  humanThinkPause,
  setHumanInputEnabledForTests,
  type HumanInputTarget,
  type HumanPage,
} from "./humanInput.js";

/**
 * These cover the two properties the login-block fix rests on:
 *
 *   1. When humanising is on, a credential arrives through real per-character
 *      key events (not a single value set), and a click is preceded by a
 *      pointer move — the telemetry a manual sign-in produces and the old
 *      `fill()`/`click()` did not.
 *   2. The helper is never less reliable than the plain call: it degrades to
 *      `fill()` / `click()` when the richer methods are missing, when a value is
 *      too long to hand-type, and when the human path throws part-way — and it
 *      does exactly the plain call when humanising is off.
 */

type Call = { name: string; args: unknown[] };

function recorder() {
  const calls: Call[] = [];
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push({ name, args });
    };
  return { calls, record };
}

/** A page whose keyboard records every typed character, like real Playwright. */
function fakePageWithKeyboard() {
  const typed: string[] = [];
  const moves: Array<{ x: number; y: number; steps?: number }> = [];
  const page: HumanPage = {
    keyboard: {
      type: async (text: string) => {
        typed.push(text);
      },
    },
    mouse: {
      move: async (x: number, y: number, opts?: { steps?: number }) => {
        moves.push({ x, y, steps: opts?.steps });
      },
    },
  };
  return { page, typed, moves };
}

afterEach(() => {
  setHumanInputEnabledForTests(null);
});

describe("humanFill", () => {
  test("types character by character through the page keyboard when enabled", async () => {
    setHumanInputEnabledForTests(true);
    const { page, typed } = fakePageWithKeyboard();
    const { calls, record } = recorder();
    const target: HumanInputTarget = {
      fill: record("fill"),
      click: record("click"),
      focus: record("focus"),
    };

    await humanFill(page, target, "aXy");

    // The credential went in as three key events, not one value set.
    assert.deepEqual(typed, ["a", "X", "y"]);
    // It focused first and cleared with fill(""), but never fill("aXy").
    assert.ok(calls.some((c) => c.name === "focus"));
    const fills = calls.filter((c) => c.name === "fill");
    assert.deepEqual(
      fills.map((c) => c.args[0]),
      [""],
    );
  });

  test("falls back to pressSequentially when no page keyboard is reachable", async () => {
    setHumanInputEnabledForTests(true);
    const seq: Array<{ text: string; delay?: number }> = [];
    const target: HumanInputTarget = {
      fill: async () => {},
      click: async () => {},
      focus: async () => {},
      pressSequentially: async (text, opts) => {
        seq.push({ text, delay: opts?.delay });
      },
    };

    await humanFill(null, target, "secret1");

    assert.equal(seq.length, 1);
    assert.equal(seq[0].text, "secret1");
    assert.ok(typeof seq[0].delay === "number" && seq[0].delay! > 0);
  });

  test("sets the value in one shot when humanising is off", async () => {
    setHumanInputEnabledForTests(false);
    const { page, typed } = fakePageWithKeyboard();
    const { calls, record } = recorder();
    const target: HumanInputTarget = { fill: record("fill"), click: record("click") };

    await humanFill(page, target, "hunter2");

    assert.deepEqual(typed, []);
    assert.deepEqual(
      calls.filter((c) => c.name === "fill").map((c) => c.args[0]),
      ["hunter2"],
    );
  });

  test("does not hand-type an over-long value", async () => {
    setHumanInputEnabledForTests(true);
    const { page, typed } = fakePageWithKeyboard();
    const long = "x".repeat(200);
    const fills: string[] = [];
    const target: HumanInputTarget = {
      fill: async (v: string) => {
        fills.push(v);
      },
      click: async () => {},
      focus: async () => {},
    };

    await humanFill(page, target, long);

    assert.deepEqual(typed, []);
    assert.deepEqual(fills, [long]);
  });

  test("recovers to a whole-value fill if typing throws part-way", async () => {
    setHumanInputEnabledForTests(true);
    const fills: string[] = [];
    const page: HumanPage = {
      keyboard: {
        type: async () => {
          throw new Error("keyboard exploded");
        },
      },
    };
    const target: HumanInputTarget = {
      fill: async (v: string) => {
        fills.push(v);
      },
      click: async () => {},
      focus: async () => {},
    };

    await humanFill(page, target, "code42");

    // The clear ("") plus the recovery fill("code42") — the field ends correct.
    assert.ok(fills.includes("code42"));
    assert.equal(fills.at(-1), "code42");
  });
});

describe("humanClick", () => {
  test("approaches with the pointer then clicks with a dwell when enabled", async () => {
    setHumanInputEnabledForTests(true);
    const { page, moves } = fakePageWithKeyboard();
    let clickOpts: Record<string, unknown> | undefined;
    const target: HumanInputTarget = {
      fill: async () => {},
      click: async (opts?: unknown) => {
        clickOpts = opts as Record<string, unknown>;
      },
      boundingBox: async () => ({ x: 100, y: 200, width: 80, height: 30 }),
      scrollIntoViewIfNeeded: async () => {},
    };

    await humanClick(page, target, { timeout: 1000 });

    assert.equal(moves.length, 1);
    // Aimed inside the box, not at an arbitrary point.
    assert.ok(moves[0].x >= 100 && moves[0].x <= 180);
    assert.ok(moves[0].y >= 200 && moves[0].y <= 230);
    // The final click kept the caller's timeout and gained a press dwell.
    assert.equal(clickOpts?.timeout, 1000);
    assert.ok(typeof clickOpts?.delay === "number" && (clickOpts!.delay as number) > 0);
  });

  test("clicks without a pointer move when geometry is unavailable", async () => {
    setHumanInputEnabledForTests(true);
    const { page, moves } = fakePageWithKeyboard();
    let clicked = false;
    const target: HumanInputTarget = {
      fill: async () => {},
      click: async () => {
        clicked = true;
      },
      boundingBox: async () => null,
    };

    await humanClick(page, target, { timeout: 500 });

    assert.equal(moves.length, 0);
    assert.equal(clicked, true);
  });

  test("passes the options straight through when humanising is off", async () => {
    setHumanInputEnabledForTests(false);
    const { page, moves } = fakePageWithKeyboard();
    let clickOpts: Record<string, unknown> | undefined;
    const target: HumanInputTarget = {
      fill: async () => {},
      click: async (opts?: unknown) => {
        clickOpts = opts as Record<string, unknown>;
      },
      boundingBox: async () => ({ x: 0, y: 0, width: 10, height: 10 }),
    };

    await humanClick(page, target, { timeout: 700 });

    assert.equal(moves.length, 0);
    assert.deepEqual(clickOpts, { timeout: 700 });
  });
});

describe("humanHover", () => {
  test("approaches then hovers when enabled", async () => {
    setHumanInputEnabledForTests(true);
    const { page, moves } = fakePageWithKeyboard();
    let hovered = false;
    const target: HumanInputTarget = {
      fill: async () => {},
      click: async () => {},
      hover: async () => {
        hovered = true;
      },
      boundingBox: async () => ({ x: 10, y: 10, width: 40, height: 20 }),
    };

    await humanHover(page, target, { timeout: 500 });

    assert.equal(moves.length, 1);
    assert.equal(hovered, true);
  });
});

describe("humanPress", () => {
  test("presses with a randomized key dwell when enabled", async () => {
    setHumanInputEnabledForTests(true);
    const calls: Array<{ key: string; opts?: Record<string, unknown> }> = [];
    const presser = {
      press: async (key: string, opts?: unknown) => {
        calls.push({ key, opts: opts as Record<string, unknown> });
      },
    };

    await humanPress(presser, "Enter", { timeout: 1000 });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].key, "Enter");
    assert.equal(calls[0].opts?.timeout, 1000);
    assert.ok(typeof calls[0].opts?.delay === "number" && (calls[0].opts!.delay as number) > 0);
  });

  test("presses with the caller's options unchanged when disabled", async () => {
    setHumanInputEnabledForTests(false);
    let seen: Record<string, unknown> | undefined;
    const presser = {
      press: async (_key: string, opts?: unknown) => {
        seen = opts as Record<string, unknown>;
      },
    };

    await humanPress(presser, "Enter", { timeout: 500 });

    assert.deepEqual(seen, { timeout: 500 });
  });
});

describe("humanThinkPause", () => {
  test("pauses when enabled and is a no-op when disabled", async () => {
    setHumanInputEnabledForTests(false);
    const t0 = Date.now();
    await humanThinkPause();
    assert.ok(Date.now() - t0 < 60, "disabled pause should return promptly");

    setHumanInputEnabledForTests(true);
    const t1 = Date.now();
    await humanThinkPause();
    assert.ok(Date.now() - t1 >= 100, "enabled pause should actually wait");
  });
});

describe("humanInputEnabled", () => {
  test("defaults on, and the test override wins in both directions", () => {
    setHumanInputEnabledForTests(null);
    assert.equal(humanInputEnabled(), true);
    setHumanInputEnabledForTests(false);
    assert.equal(humanInputEnabled(), false);
    setHumanInputEnabledForTests(true);
    assert.equal(humanInputEnabled(), true);
  });
});
