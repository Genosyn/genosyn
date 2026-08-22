import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  clampSidePanelWidth,
  initialSidePanelWidth,
  maxSidePanelWidth,
  nudgedSidePanelWidth,
  readStoredSidePanelWidth,
  sidePanelChromeWidth,
  writeStoredSidePanelWidth,
  SIDE_PANEL_DEFAULT_WIDTH,
  SIDE_PANEL_MIN_COMPANION_WIDTH,
  SIDE_PANEL_MIN_SIDE_BY_SIDE_VIEWPORT,
  SIDE_PANEL_MIN_WIDTH,
  type SidePanelWidthStorage,
} from "./sidePanelWidth";

/**
 * The arithmetic behind a docked panel's width. It is small enough to look
 * obviously right and has been wrong in every one of these ways: a panel that
 * ate the conversation, a stored width from a desktop monitor squashing a
 * laptop, an arrow key that resized the wrong way, and — the one that keeps
 * coming back — measuring against the window rather than against the space
 * the page has actually left over.
 *
 * Chat sits behind two fixed `w-64` rails from `md` up (the app's contextual
 * sidebar and the conversation list), so the numbers below are written out in
 * full rather than derived from the implementation: a test that recomputes the
 * formula it is checking cannot notice the formula being wrong.
 */

const RAILS = 512;

function fakeStorage(initial: Record<string, string> = {}): SidePanelWidthStorage & {
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

function hostileStorage(): SidePanelWidthStorage {
  return {
    getItem() {
      throw new Error("storage is disabled");
    },
    setItem() {
      throw new Error("storage is disabled");
    },
  };
}

describe("sidePanelChromeWidth", () => {
  test("counts both of chat's rails once they are showing", () => {
    assert.equal(sidePanelChromeWidth(1440), RAILS);
    assert.equal(sidePanelChromeWidth(768), RAILS);
  });

  test("counts nothing below the breakpoint that shows them", () => {
    assert.equal(sidePanelChromeWidth(767), 0);
    assert.equal(sidePanelChromeWidth(375), 0);
  });
});

describe("maxSidePanelWidth", () => {
  test("leaves the rails and a readable conversation alone", () => {
    assert.equal(maxSidePanelWidth(1920), 1048); // 1920 - 512 - 360
    assert.equal(maxSidePanelWidth(1440), 568);
    assert.equal(maxSidePanelWidth(1280), 408);
  });

  test("stops counting the rails once chat has stopped showing them", () => {
    assert.equal(maxSidePanelWidth(767), 407); // 767 - 0 - 360
  });

  test("never returns less than a usable panel", () => {
    assert.equal(maxSidePanelWidth(1024), SIDE_PANEL_MIN_WIDTH);
    assert.equal(maxSidePanelWidth(900), SIDE_PANEL_MIN_WIDTH);
    assert.equal(maxSidePanelWidth(375), SIDE_PANEL_MIN_WIDTH);
  });
});

describe("SIDE_PANEL_MIN_SIDE_BY_SIDE_VIEWPORT", () => {
  test("is the narrowest window where everything fits at its minimum", () => {
    assert.equal(SIDE_PANEL_MIN_SIDE_BY_SIDE_VIEWPORT, 1232); // 512 + 360 + 360
  });

  test("is exactly where the panel stops having to be squeezed", () => {
    // At the threshold the panel gets its minimum and the conversation gets
    // its minimum. One pixel below, something would have to give.
    assert.equal(maxSidePanelWidth(SIDE_PANEL_MIN_SIDE_BY_SIDE_VIEWPORT), SIDE_PANEL_MIN_WIDTH);
    assert.equal(
      SIDE_PANEL_MIN_SIDE_BY_SIDE_VIEWPORT - RAILS - SIDE_PANEL_MIN_WIDTH,
      SIDE_PANEL_MIN_COMPANION_WIDTH,
    );
  });
});

describe("clampSidePanelWidth", () => {
  test("leaves a comfortable width alone", () => {
    assert.equal(clampSidePanelWidth(520, 1920), 520);
  });

  test("never takes the conversation below its minimum", () => {
    assert.equal(clampSidePanelWidth(1200, 1280), 408);
    assert.equal(clampSidePanelWidth(700, 1440), 568);
  });

  test("a width remembered from a wide monitor does not squash a laptop", () => {
    assert.equal(clampSidePanelWidth(900, 1280), 408);
  });

  test("never shrinks below a usable panel", () => {
    assert.equal(clampSidePanelWidth(80, 1920), SIDE_PANEL_MIN_WIDTH);
    assert.equal(clampSidePanelWidth(-10, 1920), SIDE_PANEL_MIN_WIDTH);
  });

  test("keeps the panel usable when the window cannot fit both", () => {
    // Better one readable column than two slivers; at these sizes the caller
    // takes the whole screen anyway.
    assert.equal(clampSidePanelWidth(500, 900), SIDE_PANEL_MIN_WIDTH);
    assert.equal(clampSidePanelWidth(200, 375), SIDE_PANEL_MIN_WIDTH);
  });

  test("is exact at the boundary", () => {
    const viewport = SIDE_PANEL_MIN_SIDE_BY_SIDE_VIEWPORT;
    assert.equal(clampSidePanelWidth(SIDE_PANEL_MIN_WIDTH, viewport), SIDE_PANEL_MIN_WIDTH);
    assert.equal(clampSidePanelWidth(SIDE_PANEL_MIN_WIDTH + 1, viewport), SIDE_PANEL_MIN_WIDTH);
  });

  test("leaves the width alone when there is no window to measure", () => {
    assert.equal(clampSidePanelWidth(9000, null), 9000);
    assert.equal(clampSidePanelWidth(9000, Number.NaN), 9000);
  });
});

describe("readStoredSidePanelWidth", () => {
  test("returns the remembered width", () => {
    assert.equal(readStoredSidePanelWidth(fakeStorage({ w: "640" }), "w"), 640);
  });

  test("falls back when nothing has been stored", () => {
    assert.equal(readStoredSidePanelWidth(fakeStorage(), "w"), SIDE_PANEL_DEFAULT_WIDTH);
    assert.equal(readStoredSidePanelWidth(fakeStorage({ w: "" }), "w"), SIDE_PANEL_DEFAULT_WIDTH);
  });

  test("ignores a value that is not a width", () => {
    for (const raw of ["wide", "NaN", "{}", "-40"]) {
      assert.equal(
        readStoredSidePanelWidth(fakeStorage({ w: raw }), "w"),
        SIDE_PANEL_DEFAULT_WIDTH,
        raw,
      );
    }
  });

  test("ignores a stored width narrower than a panel should be", () => {
    assert.equal(readStoredSidePanelWidth(fakeStorage({ w: "40" }), "w"), SIDE_PANEL_DEFAULT_WIDTH);
  });

  test("honours a caller's own fallback", () => {
    assert.equal(readStoredSidePanelWidth(fakeStorage(), "w", 700), 700);
  });

  test("survives storage being unavailable or disabled", () => {
    assert.equal(readStoredSidePanelWidth(null, "w"), SIDE_PANEL_DEFAULT_WIDTH);
    assert.equal(readStoredSidePanelWidth(undefined, "w"), SIDE_PANEL_DEFAULT_WIDTH);
    assert.equal(readStoredSidePanelWidth(hostileStorage(), "w"), SIDE_PANEL_DEFAULT_WIDTH);
  });

  test("reads back what was written", () => {
    const storage = fakeStorage();
    writeStoredSidePanelWidth(storage, "w", 612.6);
    assert.equal(readStoredSidePanelWidth(storage, "w"), 613);
  });
});

describe("initialSidePanelWidth", () => {
  test("opens at the width it was left at when that still fits", () => {
    assert.equal(
      initialSidePanelWidth(fakeStorage({ w: "700" }), "w", SIDE_PANEL_DEFAULT_WIDTH, 1920),
      700,
    );
  });

  test("fits a width remembered from a bigger monitor to this one", () => {
    // The whole point of the mount-time fit: 900 was legal on 1920 and is not
    // on 1280, and the panel must not open squashing the conversation.
    assert.equal(
      initialSidePanelWidth(fakeStorage({ w: "900" }), "w", SIDE_PANEL_DEFAULT_WIDTH, 1280),
      408,
    );
  });

  test("fits the default too, on a window the default does not suit", () => {
    assert.equal(initialSidePanelWidth(fakeStorage(), "w", SIDE_PANEL_DEFAULT_WIDTH, 1280), 408);
    assert.equal(initialSidePanelWidth(fakeStorage(), "w", SIDE_PANEL_DEFAULT_WIDTH, 1920), 520);
  });

  test("falls back to the default when storage is unusable", () => {
    assert.equal(
      initialSidePanelWidth(hostileStorage(), "w", SIDE_PANEL_DEFAULT_WIDTH, 1920),
      SIDE_PANEL_DEFAULT_WIDTH,
    );
    assert.equal(
      initialSidePanelWidth(null, "w", SIDE_PANEL_DEFAULT_WIDTH, null),
      SIDE_PANEL_DEFAULT_WIDTH,
    );
  });
});

describe("writeStoredSidePanelWidth", () => {
  test("stores whole pixels", () => {
    const storage = fakeStorage();
    writeStoredSidePanelWidth(storage, "w", 480.4);
    assert.equal(storage.values.w, "480");
  });

  test("does not throw when storage refuses", () => {
    assert.doesNotThrow(() => writeStoredSidePanelWidth(hostileStorage(), "w", 480));
    assert.doesNotThrow(() => writeStoredSidePanelWidth(null, "w", 480));
  });
});

describe("nudgedSidePanelWidth", () => {
  test("grows towards the left, the way dragging that edge does", () => {
    assert.equal(nudgedSidePanelWidth(520, "ArrowLeft", false, 1920), 544);
  });

  test("shrinks towards the right", () => {
    assert.equal(nudgedSidePanelWidth(520, "ArrowRight", false, 1920), 496);
  });

  test("takes bigger steps with shift held", () => {
    assert.equal(nudgedSidePanelWidth(520, "ArrowLeft", true, 1920), 600);
    assert.equal(nudgedSidePanelWidth(520, "ArrowRight", true, 1920), 440);
  });

  test("stops at the same bounds a drag does", () => {
    assert.equal(
      nudgedSidePanelWidth(SIDE_PANEL_MIN_WIDTH, "ArrowRight", true, 1920),
      SIDE_PANEL_MIN_WIDTH,
    );
    assert.equal(nudgedSidePanelWidth(560, "ArrowLeft", true, 1440), 568);
  });

  test("a nudge and its opposite cancel out in open water", () => {
    const grown = nudgedSidePanelWidth(520, "ArrowLeft", false, 1920);
    assert.equal(nudgedSidePanelWidth(grown, "ArrowRight", false, 1920), 520);
  });
});
