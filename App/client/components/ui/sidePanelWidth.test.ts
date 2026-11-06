import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  APP_PANEL_MAX_WIDTH,
  draggedWidth,
  fitWidth,
  nudgedWidth,
  RAIL_DEFAULT_WIDTH,
  RAIL_MAX_WIDTH,
  RAIL_MAX_WIDTH_IN_ROW,
  RAIL_MIN_WIDTH,
  readStoredWidth,
  SIDE_PANEL_BESIDE_RAIL_MAX_WIDTH,
  SIDE_PANEL_DEFAULT_WIDTH,
  SIDE_PANEL_MAX_WIDTH,
  SIDE_PANEL_MIN_COMPANION_WIDTH,
  SIDE_PANEL_MIN_SIDE_BY_SIDE_VIEWPORT,
  SIDE_PANEL_MIN_WIDTH,
  writeStoredWidth,
  type WidthStorage,
} from "./sidePanelWidth";

/**
 * The arithmetic behind a column a person drags. It is small enough to look
 * obviously right and has been wrong in these ways: a stored width from a
 * desktop monitor squashing a laptop, an arrow key that resized the wrong way,
 * and — the one that keeps coming back — measuring against the window rather
 * than against the space the page has actually left over. That last one is why
 * the limits are CSS: `scripts/test-panel-widths.ts` drags the real thing in
 * Chrome, and these pin the expressions it depends on.
 */

function fakeStorage(initial: Record<string, string> = {}): WidthStorage & {
  values: Record<string, string>;
} {
  const values = { ...initial };
  return {
    values,
    getItem: (key: string) => (key in values ? values[key] : null),
    setItem: (key: string, value: string) => {
      values[key] = value;
    },
  };
}

function hostileStorage(): WidthStorage {
  return {
    getItem() {
      throw new Error("storage is disabled");
    },
    setItem() {
      throw new Error("storage is disabled");
    },
  };
}

describe("SIDE_PANEL_MIN_SIDE_BY_SIDE_VIEWPORT", () => {
  test("is the narrowest window where everything fits at its usual size", () => {
    assert.equal(SIDE_PANEL_MIN_SIDE_BY_SIDE_VIEWPORT, 1232); // 256 + 256 + 360 + 360
  });

  test("is exactly where Ask AI stops having to be squeezed beside a usual rail", () => {
    // At the threshold, what Ask AI's max-width leaves is its minimum.
    assert.equal(
      SIDE_PANEL_MIN_SIDE_BY_SIDE_VIEWPORT -
        RAIL_DEFAULT_WIDTH -
        (RAIL_DEFAULT_WIDTH + SIDE_PANEL_MIN_COMPANION_WIDTH),
      SIDE_PANEL_MIN_WIDTH,
    );
  });
});

describe("the limits a column meets on screen", () => {
  test("a panel leaves the page beside it a readable column", () => {
    assert.equal(SIDE_PANEL_MAX_WIDTH, "calc(100% - 360px)");
  });

  test("a panel sharing its row with a rail leaves room for the rail as well", () => {
    assert.equal(SIDE_PANEL_BESIDE_RAIL_MAX_WIDTH, "calc(100% - var(--rail-width, 0px) - 360px)");
  });

  test("Ask AI also leaves room for a column inside the page", () => {
    assert.equal(APP_PANEL_MAX_WIDTH, "calc(100% - var(--rail-width, 0px) - 616px)");
  });

  test("a rail stops at its maximum, or sooner on a narrow window", () => {
    assert.equal(RAIL_MAX_WIDTH_IN_ROW, "min(480px, calc(100% - 360px))");
  });

  test("a rail's usual width is inside the range it can be dragged across", () => {
    assert.ok(RAIL_MIN_WIDTH < RAIL_DEFAULT_WIDTH && RAIL_DEFAULT_WIDTH < RAIL_MAX_WIDTH);
  });
});

describe("fitWidth", () => {
  test("leaves a width in range alone", () => {
    assert.equal(fitWidth(300, RAIL_MIN_WIDTH, RAIL_MAX_WIDTH), 300);
  });

  test("stops at either end", () => {
    assert.equal(fitWidth(80, RAIL_MIN_WIDTH, RAIL_MAX_WIDTH), RAIL_MIN_WIDTH);
    assert.equal(fitWidth(-10, RAIL_MIN_WIDTH, RAIL_MAX_WIDTH), RAIL_MIN_WIDTH);
    assert.equal(fitWidth(900, RAIL_MIN_WIDTH, RAIL_MAX_WIDTH), RAIL_MAX_WIDTH);
  });

  test("has no ceiling of its own unless given one", () => {
    assert.equal(fitWidth(9000, SIDE_PANEL_MIN_WIDTH), 9000);
    assert.equal(fitWidth(80, SIDE_PANEL_MIN_WIDTH), SIDE_PANEL_MIN_WIDTH);
  });
});

describe("readStoredWidth", () => {
  const read = (storage: WidthStorage | null | undefined) =>
    readStoredWidth(storage, "w", SIDE_PANEL_DEFAULT_WIDTH, SIDE_PANEL_MIN_WIDTH);

  test("returns the remembered width", () => {
    assert.equal(read(fakeStorage({ w: "640" })), 640);
  });

  test("falls back when nothing has been stored", () => {
    assert.equal(read(fakeStorage()), SIDE_PANEL_DEFAULT_WIDTH);
    assert.equal(read(fakeStorage({ w: "" })), SIDE_PANEL_DEFAULT_WIDTH);
  });

  test("ignores a value that is not a width", () => {
    for (const raw of ["wide", "NaN", "{}", "-40"]) {
      assert.equal(read(fakeStorage({ w: raw })), SIDE_PANEL_DEFAULT_WIDTH, raw);
    }
  });

  test("ignores a stored width narrower than the column should be", () => {
    assert.equal(read(fakeStorage({ w: "40" })), SIDE_PANEL_DEFAULT_WIDTH);
  });

  test("a minimum is the column's own: a rail may be narrower than a panel", () => {
    const storage = fakeStorage({ w: "220" });
    assert.equal(read(storage), SIDE_PANEL_DEFAULT_WIDTH);
    assert.equal(readStoredWidth(storage, "w", RAIL_DEFAULT_WIDTH, RAIL_MIN_WIDTH), 220);
  });

  test("brings a width past the column's maximum back to it", () => {
    assert.equal(
      readStoredWidth(
        fakeStorage({ w: "900" }),
        "w",
        RAIL_DEFAULT_WIDTH,
        RAIL_MIN_WIDTH,
        RAIL_MAX_WIDTH,
      ),
      RAIL_MAX_WIDTH,
    );
  });

  test("honours a caller's own fallback", () => {
    assert.equal(readStoredWidth(fakeStorage(), "w", 700, SIDE_PANEL_MIN_WIDTH), 700);
  });

  test("survives storage being unavailable or disabled", () => {
    assert.equal(read(null), SIDE_PANEL_DEFAULT_WIDTH);
    assert.equal(read(undefined), SIDE_PANEL_DEFAULT_WIDTH);
    assert.equal(read(hostileStorage()), SIDE_PANEL_DEFAULT_WIDTH);
  });

  test("reads back what was written", () => {
    const storage = fakeStorage();
    writeStoredWidth(storage, "w", 612.6);
    assert.equal(read(storage), 613);
  });
});

describe("writeStoredWidth", () => {
  test("stores whole pixels", () => {
    const storage = fakeStorage();
    writeStoredWidth(storage, "w", 480.4);
    assert.equal(storage.values.w, "480");
  });

  test("does not throw when storage refuses", () => {
    assert.doesNotThrow(() => writeStoredWidth(hostileStorage(), "w", 480));
    assert.doesNotThrow(() => writeStoredWidth(null, "w", 480));
  });
});

describe("draggedWidth", () => {
  test("a panel's left edge grows it as the pointer moves left", () => {
    assert.equal(draggedWidth(460, -200, "left"), 660);
    assert.equal(draggedWidth(460, 60, "left"), 400);
  });

  test("a rail's right edge grows it as the pointer moves right", () => {
    assert.equal(draggedWidth(256, 100, "right"), 356);
    assert.equal(draggedWidth(256, -40, "right"), 216);
  });
});

describe("nudgedWidth", () => {
  test("on a left edge, ← grows and → shrinks, the way dragging that edge does", () => {
    assert.equal(nudgedWidth(520, "ArrowLeft", false, "left"), 544);
    assert.equal(nudgedWidth(520, "ArrowRight", false, "left"), 496);
  });

  test("on a right edge, → grows and ← shrinks", () => {
    assert.equal(nudgedWidth(256, "ArrowRight", false, "right"), 280);
    assert.equal(nudgedWidth(256, "ArrowLeft", false, "right"), 232);
  });

  test("takes bigger steps with shift held", () => {
    assert.equal(nudgedWidth(520, "ArrowLeft", true, "left"), 600);
    assert.equal(nudgedWidth(520, "ArrowRight", true, "left"), 440);
    assert.equal(nudgedWidth(256, "ArrowRight", true, "right"), 336);
  });

  test("a nudge and its opposite cancel out", () => {
    for (const edge of ["left", "right"] as const) {
      const moved = nudgedWidth(320, "ArrowLeft", false, edge);
      assert.equal(nudgedWidth(moved, "ArrowRight", false, edge), 320);
    }
  });
});
