import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { placeMenu } from "./menuPlacement";

/**
 * Where a Menu opens. The window is 1280×720 unless a case says otherwise, and
 * the menu is an invoice row's ⋯ menu — Duplicate, Make recurring, Archive,
 * Void: 138px tall, 176px wide, right-aligned to a 24px trigger. The numbers
 * are written out rather than derived, so a wrong formula cannot agree with
 * itself.
 */

const WINDOW = { width: 1280, height: 720 };
const ROW_MENU = { height: 138, width: 176, align: "right", side: "bottom" } as const;
/** A floating bar's menu, which asks to open above it. */
const BAR_MENU = { height: 138, width: 220, align: "left", side: "top" } as const;

/** A row's ⋯ button whose top edge is `top`. */
function rowTrigger(top: number) {
  return { top, bottom: top + 24, left: 1206, right: 1230 };
}

describe("placeMenu", () => {
  test("opens below a trigger with room under it", () => {
    assert.deepEqual(placeMenu({ ...ROW_MENU, trigger: rowTrigger(300), viewport: WINDOW }), {
      top: 328,
      left: 1054,
      maxHeight: 384,
    });
  });

  test("opens above the last row of a page instead of running off the window", () => {
    // Below the trigger there are 40px left; downward, everything after
    // Duplicate was cut off, and the page cannot scroll a fixed menu back.
    const placement = placeMenu({ ...ROW_MENU, trigger: rowTrigger(644), viewport: WINDOW });
    assert.deepEqual(placement, { bottom: 80, left: 1054, maxHeight: 576 });
    // Its bottom edge sits just above the trigger, at 640.
    assert.equal(WINDOW.height - (placement.bottom ?? 0), 640);
  });

  test("opens above even when only its last item would be cut off", () => {
    assert.deepEqual(placeMenu({ ...ROW_MENU, trigger: rowTrigger(581), viewport: WINDOW }), {
      bottom: 143,
      left: 1054,
      maxHeight: 569,
    });
  });

  test("fitting nowhere, takes the roomier side and scrolls there", () => {
    const short = { width: 1280, height: 300 };
    const tall = { ...ROW_MENU, height: 200 };
    // 134px below, 118px above: stays below.
    assert.deepEqual(placeMenu({ ...tall, trigger: rowTrigger(130), viewport: short }), {
      top: 158,
      left: 1054,
      maxHeight: 134,
    });
    // 104px below, 148px above: goes above.
    assert.deepEqual(placeMenu({ ...tall, trigger: rowTrigger(160), viewport: short }), {
      bottom: 144,
      left: 1054,
      maxHeight: 148,
    });
  });

  test("a long list stops at 80% of the window and scrolls", () => {
    assert.deepEqual(
      placeMenu({ ...ROW_MENU, height: 2000, trigger: rowTrigger(40), viewport: WINDOW }),
      { top: 68, left: 1054, maxHeight: 576 },
    );
  });

  test('side="top" opens above a floating bar at the foot of the window', () => {
    const bar = { top: 660, bottom: 692, left: 600, right: 700 };
    assert.deepEqual(placeMenu({ ...BAR_MENU, trigger: bar, viewport: WINDOW }), {
      bottom: 64,
      left: 600,
      maxHeight: 576,
    });
  });

  test('side="top" opens below when there is no room above', () => {
    const header = { top: 40, bottom: 72, left: 600, right: 700 };
    assert.deepEqual(placeMenu({ ...BAR_MENU, trigger: header, viewport: WINDOW }), {
      top: 76,
      left: 600,
      maxHeight: 576,
    });
  });

  test("stays inside the window sideways", () => {
    const menu = { height: 138, width: 220, side: "bottom", viewport: WINDOW } as const;
    const nearRight = { top: 300, bottom: 324, left: 1200, right: 1224 };
    assert.equal(placeMenu({ ...menu, align: "left", trigger: nearRight }).left, 1052);
    const nearLeft = { top: 300, bottom: 324, left: 76, right: 100 };
    assert.equal(placeMenu({ ...menu, align: "right", trigger: nearLeft }).left, 8);
  });
});
