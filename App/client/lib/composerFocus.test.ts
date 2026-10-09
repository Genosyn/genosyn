import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { shouldFocusOnArrival, type ArrivalFocusContext } from "./composerFocus.js";

/**
 * Arriving at a chat thread, a channel or the Ask AI panel puts the cursor in
 * its message box — the click that every first message used to start with —
 * but only where that helps: with a keyboard at hand, and never taking focus
 * from a field someone is typing in or from a dialog.
 */

const box = { disabled: false, isConnected: true };
const desk: ArrivalFocusContext = {
  finePointer: true,
  active: null,
  activeIsTyping: false,
  dialogOpen: false,
};

describe("shouldFocusOnArrival", () => {
  test("focuses the box on a device with a mouse or trackpad", () => {
    assert.equal(shouldFocusOnArrival(box, desk), true);
  });

  test("never on a touch-first device, where it would raise the on-screen keyboard", () => {
    assert.equal(shouldFocusOnArrival(box, { ...desk, finePointer: false }), false);
    assert.equal(
      shouldFocusOnArrival(box, { ...desk, finePointer: false }, { overTyping: true }),
      false,
    );
  });

  test("never takes focus from a field the person is typing in", () => {
    const typing = { ...desk, active: {} as Element, activeIsTyping: true };
    assert.equal(shouldFocusOnArrival(box, typing), false);
  });

  test("an explicit open (Ask AI) may take focus from another field, never from a dialog", () => {
    const typing = { ...desk, active: {} as Element, activeIsTyping: true };
    assert.equal(shouldFocusOnArrival(box, typing, { overTyping: true }), true);
    assert.equal(
      shouldFocusOnArrival(box, { ...typing, dialogOpen: true }, { overTyping: true }),
      false,
    );
  });

  test("never while a dialog owns the screen", () => {
    assert.equal(shouldFocusOnArrival(box, { ...desk, dialogOpen: true }), false);
  });

  test("a focused button, link or the page body does not stop it", () => {
    assert.equal(shouldFocusOnArrival(box, { ...desk, active: {} as Element }), true);
  });

  test("nothing to do without a box, a disabled one, one off the page, or one already focused", () => {
    assert.equal(shouldFocusOnArrival(null, desk), false);
    assert.equal(shouldFocusOnArrival({ ...box, disabled: true }, desk), false);
    assert.equal(shouldFocusOnArrival({ ...box, isConnected: false }, desk), false);
    const focused = { ...box };
    assert.equal(
      shouldFocusOnArrival(focused, { ...desk, active: focused as unknown as Element }),
      false,
    );
  });
});
