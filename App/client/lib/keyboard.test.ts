import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { submitFormOnModEnter, type ModEnterEvent } from "./keyboard.js";

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
