import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  isCreateTaskShortcut,
  submitFormOnModEnter,
  type ModEnterEvent,
  type ShortcutKeyEvent,
} from "./keyboard.js";

describe("isCreateTaskShortcut", () => {
  const press = (changes: Partial<ShortcutKeyEvent>): boolean =>
    isCreateTaskShortcut({
      key: "t",
      code: "KeyT",
      altKey: true,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      ...changes,
    });

  test("Alt+T on Windows and Linux", () => {
    assert.equal(press({}), true);
  });

  test("⌥T on a Mac, which reports the character it would type", () => {
    assert.equal(press({ key: "†" }), true);
    assert.equal(press({ key: "Dead" }), true);
  });

  test("a layout whose T key is not a Latin letter", () => {
    assert.equal(press({ key: "е" }), true);
  });

  test("the letter wins over the key's position on a Latin layout", () => {
    assert.equal(press({ key: "t", code: "KeyK" }), true, "Dvorak's T");
    assert.equal(press({ key: "y", code: "KeyT" }), false, "Dvorak's Y");
  });

  test("not T on its own, or with any other modifier", () => {
    assert.equal(press({ altKey: false }), false);
    assert.equal(press({ metaKey: true }), false, "⌘⌥T");
    assert.equal(press({ ctrlKey: true }), false, "AltGr on Windows types a character");
    assert.equal(press({ shiftKey: true }), false);
  });

  test("not another key with Alt", () => {
    assert.equal(press({ key: "r", code: "KeyR" }), false);
    assert.equal(press({ key: "®", code: "KeyR" }), false);
  });
});

/**
 * ⌘/Ctrl+Enter submits the form a multi-line box sits in — a journal note, a
 * memory, a handoff brief — so it needs no reach for the button.
 */

function keyEvent(
  changes: Partial<Omit<ModEnterEvent, "currentTarget">> & { form?: boolean } = {},
) {
  let submitted = 0;
  let prevented = 0;
  const { form = true, ...rest } = changes;
  const event: ModEnterEvent = {
    key: "Enter",
    metaKey: true,
    ctrlKey: false,
    nativeEvent: { isComposing: false },
    currentTarget: { form: form ? { requestSubmit: () => void (submitted += 1) } : null },
    preventDefault: () => void (prevented += 1),
    ...rest,
  };
  return { event, submitted: () => submitted, prevented: () => prevented };
}

describe("submitFormOnModEnter", () => {
  test("⌘Enter and Ctrl+Enter submit the box's form", () => {
    for (const modifier of [{ metaKey: true }, { metaKey: false, ctrlKey: true }]) {
      const press = keyEvent(modifier);
      assert.equal(submitFormOnModEnter(press.event), true);
      assert.equal(press.submitted(), 1);
      assert.equal(press.prevented(), 1, "no newline is added on the way");
    }
  });

  test("a plain Enter is a newline, as it always was", () => {
    const press = keyEvent({ metaKey: false, ctrlKey: false });
    assert.equal(submitFormOnModEnter(press.event), false);
    assert.equal(press.submitted(), 0);
    assert.equal(press.prevented(), 0);
  });

  test("other keys with a modifier are left alone", () => {
    const press = keyEvent({ key: "s" });
    assert.equal(submitFormOnModEnter(press.event), false);
    assert.equal(press.submitted(), 0);
  });

  test("never mid-composition: that Enter belongs to the input method", () => {
    const press = keyEvent({ nativeEvent: { isComposing: true } });
    assert.equal(submitFormOnModEnter(press.event), false);
    assert.equal(press.submitted(), 0);
    assert.equal(press.prevented(), 0);
  });

  test("a box outside any form does nothing", () => {
    const press = keyEvent({ form: false });
    assert.equal(submitFormOnModEnter(press.event), false);
    assert.equal(press.prevented(), 0);
  });
});
