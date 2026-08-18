import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  PdfGeometryError,
  displayPointToUser,
  displayRectToUserBox,
  displaySize,
  normalizePageRotation,
  pointInBox,
  userPointToDisplay,
  type PageBox,
  type PageRotation,
} from "./pdfGeometry.js";

const ROTATIONS: PageRotation[] = [0, 90, 180, 270];

/** US Letter portrait, origin at 0,0 — the ordinary case. */
function letter(rotation: PageRotation): PageBox {
  return { x: 0, y: 0, width: 612, height: 792, rotation };
}

/** A cropped page whose box does not start at the origin. */
function cropped(rotation: PageRotation): PageBox {
  return { x: 20, y: 35, width: 612, height: 792, rotation };
}

function closeTo(actual: number, expected: number, message: string): void {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${message}: expected ${expected}, got ${actual}`,
  );
}

describe("normalizePageRotation", () => {
  test("passes through the four quarter turns", () => {
    for (const rotation of ROTATIONS) {
      assert.equal(normalizePageRotation(rotation), rotation);
    }
  });

  test("wraps full and negative turns onto the same four", () => {
    assert.equal(normalizePageRotation(360), 0);
    assert.equal(normalizePageRotation(720), 0);
    assert.equal(normalizePageRotation(-90), 270);
    assert.equal(normalizePageRotation(-180), 180);
    assert.equal(normalizePageRotation(-270), 90);
    assert.equal(normalizePageRotation(450), 90);
  });

  test("tolerates a generator's float noise", () => {
    assert.equal(normalizePageRotation(90.000000001), 90);
    assert.equal(normalizePageRotation(-0.000000001), 0);
  });

  test("refuses a rotation that is not a quarter turn", () => {
    // Guessing here would silently drop a name into the margin, so the file
    // is rejected instead.
    assert.throws(() => normalizePageRotation(45), PdfGeometryError);
    assert.throws(() => normalizePageRotation(90.5), PdfGeometryError);
    assert.throws(() => normalizePageRotation(Number.NaN), PdfGeometryError);
    assert.throws(() => normalizePageRotation(Number.POSITIVE_INFINITY), PdfGeometryError);
  });
});

describe("displaySize", () => {
  test("swaps width and height on a quarter turn only", () => {
    assert.deepEqual(displaySize(letter(0)), { width: 612, height: 792 });
    assert.deepEqual(displaySize(letter(180)), { width: 612, height: 792 });
    assert.deepEqual(displaySize(letter(90)), { width: 792, height: 612 });
    assert.deepEqual(displaySize(letter(270)), { width: 792, height: 612 });
  });
});

describe("displayPointToUser", () => {
  test("unrotated: top-left of the display is the top-left of user space", () => {
    assert.deepEqual(displayPointToUser(letter(0), { x: 0, y: 0 }), { x: 0, y: 792 });
    assert.deepEqual(displayPointToUser(letter(0), { x: 612, y: 792 }), { x: 612, y: 0 });
    assert.deepEqual(displayPointToUser(letter(0), { x: 72, y: 92 }), { x: 72, y: 700 });
  });

  test("each quarter turn sends the displayed top-left to the right corner", () => {
    // Rotating the sheet clockwise moves the user-space corner that ends up
    // under the reader's top-left. These four are the whole contract.
    assert.deepEqual(displayPointToUser(letter(0), { x: 0, y: 0 }), { x: 0, y: 792 });
    assert.deepEqual(displayPointToUser(letter(90), { x: 0, y: 0 }), { x: 0, y: 0 });
    assert.deepEqual(displayPointToUser(letter(180), { x: 0, y: 0 }), { x: 612, y: 0 });
    assert.deepEqual(displayPointToUser(letter(270), { x: 0, y: 0 }), { x: 612, y: 792 });
  });

  test("the displayed page's own corners stay inside user space", () => {
    for (const rotation of ROTATIONS) {
      const box = letter(rotation);
      const display = displaySize(box);
      const corners = [
        { x: 0, y: 0 },
        { x: display.width, y: 0 },
        { x: 0, y: display.height },
        { x: display.width, y: display.height },
      ];
      for (const corner of corners) {
        const user = displayPointToUser(box, corner);
        assert.ok(
          user.x >= -1e-9 && user.x <= box.width + 1e-9,
          `rotation ${rotation}: x ${user.x} outside 0..${box.width}`,
        );
        assert.ok(
          user.y >= -1e-9 && user.y <= box.height + 1e-9,
          `rotation ${rotation}: y ${user.y} outside 0..${box.height}`,
        );
      }
    }
  });

  test("a non-zero page box offsets every result", () => {
    for (const rotation of ROTATIONS) {
      const plain = displayPointToUser(letter(rotation), { x: 100, y: 150 });
      const offset = displayPointToUser(cropped(rotation), { x: 100, y: 150 });
      closeTo(offset.x - plain.x, 20, `rotation ${rotation} x offset`);
      closeTo(offset.y - plain.y, 35, `rotation ${rotation} y offset`);
    }
  });
});

describe("userPointToDisplay", () => {
  test("round-trips every rotation over a grid, cropped and not", () => {
    // A grid rather than random points: same coverage, reproducible failure.
    for (const rotation of ROTATIONS) {
      for (const box of [letter(rotation), cropped(rotation)]) {
        const display = displaySize(box);
        for (let i = 0; i <= 10; i += 1) {
          for (let j = 0; j <= 10; j += 1) {
            const point = { x: (display.width * i) / 10, y: (display.height * j) / 10 };
            const back = userPointToDisplay(box, displayPointToUser(box, point));
            closeTo(back.x, point.x, `rotation ${rotation} x at ${i},${j}`);
            closeTo(back.y, point.y, `rotation ${rotation} y at ${i},${j}`);
          }
        }
      }
    }
  });

  test("round-trips from the user-space side too", () => {
    for (const rotation of ROTATIONS) {
      const box = cropped(rotation);
      for (const point of [
        { x: 20, y: 35 },
        { x: 200, y: 400 },
        { x: 632, y: 827 },
      ]) {
        const back = displayPointToUser(box, userPointToDisplay(box, point));
        closeTo(back.x, point.x, `rotation ${rotation} user x`);
        closeTo(back.y, point.y, `rotation ${rotation} user y`);
      }
    }
  });
});

describe("displayRectToUserBox", () => {
  test("anchors on the rectangle's displayed bottom-left", () => {
    const box = displayRectToUserBox(letter(0), { x: 72, y: 92, width: 200, height: 20 });
    assert.deepEqual(box, { x: 72, y: 680, width: 200, height: 20, rotation: 0 });
  });

  test("matches the shipped signing conversion on every rotation", () => {
    // These are the four cases `normalizedFieldBoxForPage` has served the
    // signature editor with; the shared implementation must not move them.
    const rect = { x: 72, y: 92, width: 200, height: 20 };
    const left = rect.x;
    const top = rect.y;
    const bottom = top + rect.height;
    const crop = { x: 20, y: 35, width: 612, height: 792 };
    const expected: Record<PageRotation, { x: number; y: number }> = {
      0: { x: crop.x + left, y: crop.y + crop.height - bottom },
      90: { x: crop.x + bottom, y: crop.y + left },
      180: { x: crop.x + crop.width - left, y: crop.y + bottom },
      270: { x: crop.x + crop.width - bottom, y: crop.y + crop.height - left },
    };
    for (const rotation of ROTATIONS) {
      const actual = displayRectToUserBox(cropped(rotation), rect);
      closeTo(actual.x, expected[rotation].x, `rotation ${rotation} box x`);
      closeTo(actual.y, expected[rotation].y, `rotation ${rotation} box y`);
      assert.equal(actual.rotation, rotation);
      assert.equal(actual.width, rect.width);
      assert.equal(actual.height, rect.height);
    }
  });
});

describe("pointInBox", () => {
  test("local origin is the box anchor at every rotation", () => {
    for (const rotation of ROTATIONS) {
      const box = displayRectToUserBox(cropped(rotation), {
        x: 72,
        y: 92,
        width: 200,
        height: 20,
      });
      const origin = pointInBox(box, 0, 0);
      closeTo(origin.x, box.x, `rotation ${rotation} origin x`);
      closeTo(origin.y, box.y, `rotation ${rotation} origin y`);
    }
  });

  test("walking the box's local axes traces its displayed rectangle", () => {
    for (const rotation of ROTATIONS) {
      const rect = { x: 72, y: 92, width: 200, height: 20 };
      const page = cropped(rotation);
      const box = displayRectToUserBox(page, rect);
      // Local top-right must come back as the display rect's top-right.
      const corner = userPointToDisplay(page, pointInBox(box, rect.width, rect.height));
      closeTo(corner.x, rect.x + rect.width, `rotation ${rotation} corner x`);
      closeTo(corner.y, rect.y, `rotation ${rotation} corner y`);
    }
  });
});
