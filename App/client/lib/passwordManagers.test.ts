import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import {
  CREDENTIAL_ATTRIBUTE,
  PASSWORD_MANAGER_IGNORE,
  passwordManagerProps,
  syncPasswordManagerMarks,
  syncPasswordManagerMarksWithin,
  type FieldElement,
} from "./passwordManagers";

/**
 * Password managers fill the person's own Genosyn sign-in and nothing else.
 *
 * 1Password used to pop up its menu in a customer's Email field. Every field
 * now carries the marks password managers read to leave it alone — rendered
 * by the shared Input and Textarea, added to plain inputs as they appear —
 * except the sign-in fields that carry `data-credential`.
 */

const MARKS = Object.keys(PASSWORD_MANAGER_IGNORE);

/** Just enough of a DOM element: attributes, a parent, children. */
class FakeElement implements FieldElement {
  readonly nodeType = 1;
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  writes = 0;

  constructor(tagName: string, attributes: Record<string, string> = {}) {
    this.tagName = tagName.toUpperCase();
    for (const [name, value] of Object.entries(attributes)) this.attributes.set(name, value);
  }

  append(...children: FakeElement[]): this {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
    return this;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.writes += 1;
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.writes += 1;
    this.attributes.delete(name);
  }

  /** Only the selector the guard uses: a `data-credential` that is not "false". */
  closest(selectors: string): FakeElement | null {
    assert.match(selectors, new RegExp(CREDENTIAL_ATTRIBUTE));
    const mark = this.getAttribute(CREDENTIAL_ATTRIBUTE);
    if (mark !== null && mark !== "false") return this;
    return this.parent?.closest(selectors) ?? null;
  }

  querySelectorAll(selectors: string): FakeElement[] {
    assert.equal(selectors, "input, textarea");
    const found: FakeElement[] = [];
    const walk = (node: FakeElement) => {
      for (const child of node.children) {
        if (child.tagName === "INPUT" || child.tagName === "TEXTAREA") found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
}

const marksOf = (field: FakeElement) =>
  Object.fromEntries(MARKS.map((name) => [name, field.getAttribute(name)]));
const ignored = Object.fromEntries(Object.entries(PASSWORD_MANAGER_IGNORE));
const unmarked = Object.fromEntries(MARKS.map((name) => [name, null]));

describe("marking a field", () => {
  test("a customer's Email field is left alone by every password manager", () => {
    const email = new FakeElement("input", { type: "email", name: "email" });
    syncPasswordManagerMarks(email);
    assert.deepEqual(marksOf(email), {
      "data-1p-ignore": "true",
      "data-lpignore": "true",
      "data-bwignore": "true",
      "data-form-type": "other",
    });
  });

  test("every field a person types in is marked; toggles and pickers are not", () => {
    for (const type of ["text", "email", "tel", "url", "search", "number", "password", "date", ""]) {
      const field = new FakeElement("input", type ? { type } : {});
      syncPasswordManagerMarks(field);
      assert.deepEqual(marksOf(field), ignored, `type="${type}"`);
    }
    const textarea = new FakeElement("textarea");
    syncPasswordManagerMarks(textarea);
    assert.deepEqual(marksOf(textarea), ignored);
    for (const type of [
      "checkbox",
      "radio",
      "file",
      "range",
      "color",
      "hidden",
      "submit",
      "button",
      "reset",
      "image",
      " Checkbox ",
    ]) {
      const field = new FakeElement("input", { type });
      syncPasswordManagerMarks(field);
      assert.deepEqual(marksOf(field), unmarked, `type="${type}"`);
    }
    const select = new FakeElement("select");
    syncPasswordManagerMarks(select);
    assert.deepEqual(marksOf(select), unmarked);
  });

  test("the person's own sign-in field stays theirs, marked on it or on its form", () => {
    const password = new FakeElement("input", { type: "password", [CREDENTIAL_ATTRIBUTE]: "" });
    syncPasswordManagerMarks(password);
    assert.deepEqual(marksOf(password), unmarked);

    const email = new FakeElement("input", { type: "email" });
    new FakeElement("form", { [CREDENTIAL_ATTRIBUTE]: "true" }).append(
      new FakeElement("div").append(email),
    );
    syncPasswordManagerMarks(email);
    assert.deepEqual(marksOf(email), unmarked);
  });

  test('data-credential="false" — what React writes for {false} — is no mark', () => {
    const field = new FakeElement("input", { type: "email", [CREDENTIAL_ATTRIBUTE]: "false" });
    syncPasswordManagerMarks(field);
    assert.deepEqual(marksOf(field), ignored);
  });

  test("a field that becomes a sign-in field loses its marks", () => {
    const field = new FakeElement("input", { type: "email" });
    syncPasswordManagerMarks(field);
    assert.deepEqual(marksOf(field), ignored);
    field.attributes.set(CREDENTIAL_ATTRIBUTE, "true");
    syncPasswordManagerMarks(field);
    assert.deepEqual(marksOf(field), unmarked);
  });

  test("marking again writes nothing", () => {
    const field = new FakeElement("input", { type: "tel" });
    syncPasswordManagerMarks(field);
    const writes = field.writes;
    syncPasswordManagerMarks(field);
    syncPasswordManagerMarks(field);
    assert.equal(field.writes, writes);
  });
});

describe("marking what React adds", () => {
  test("marks the fields inside a new subtree, and sign-in fields there stay unmarked", () => {
    const name = new FakeElement("input");
    const email = new FakeElement("input", { type: "email" });
    const notes = new FakeElement("textarea");
    const archived = new FakeElement("input", { type: "checkbox" });
    const signIn = new FakeElement("input", { type: "password", [CREDENTIAL_ATTRIBUTE]: "" });
    const page = new FakeElement("div").append(
      new FakeElement("form").append(name, new FakeElement("label").append(email), notes),
      archived,
      signIn,
    );
    syncPasswordManagerMarksWithin(page);
    for (const field of [name, email, notes]) assert.deepEqual(marksOf(field), ignored);
    assert.deepEqual(marksOf(archived), unmarked);
    assert.deepEqual(marksOf(signIn), unmarked);
  });

  test("marks a field added on its own", () => {
    const phone = new FakeElement("input", { type: "tel" });
    syncPasswordManagerMarksWithin(phone);
    assert.deepEqual(marksOf(phone), ignored);
  });

  test("passes over text — streamed chat and transcripts hold no fields", () => {
    let touched = false;
    syncPasswordManagerMarksWithin({
      nodeType: 3,
      querySelectorAll: () => {
        touched = true;
        return [];
      },
    });
    assert.equal(touched, false);
  });
});

describe("the shared fields", () => {
  const render = (element: React.ReactElement) => renderToStaticMarkup(element);

  test("Input renders the marks, so they are there before anyone can focus it", () => {
    const html = render(React.createElement(Input, { label: "Email", type: "email" }));
    for (const [name, value] of Object.entries(PASSWORD_MANAGER_IGNORE)) {
      assert.match(html, new RegExp(`${name}="${value}"`));
    }
  });

  test("a sign-in Input renders none", () => {
    const html = render(
      React.createElement(Input, {
        label: "Password",
        type: "password",
        autoComplete: "current-password",
        [CREDENTIAL_ATTRIBUTE]: true,
      } as React.ComponentProps<typeof Input>),
    );
    assert.match(html, /data-credential="true"/);
    for (const name of MARKS) assert.doesNotMatch(html, new RegExp(name));
  });

  test("a sign-in mark left undefined, as a conditional one can be, still marks the field", () => {
    const html = render(
      React.createElement(Input, {
        label: "Recovery code",
        [CREDENTIAL_ATTRIBUTE]: undefined,
      } as React.ComponentProps<typeof Input>),
    );
    assert.match(html, /data-1p-ignore="true"/);
    assert.doesNotMatch(html, /data-credential/);
  });

  test("Textarea renders the marks too", () => {
    const html = render(React.createElement(Textarea, { label: "Notes" }));
    assert.match(html, /data-1p-ignore="true"/);
    assert.match(html, /data-lpignore="true"/);
  });

  test("the props helper agrees with the DOM on what counts as a sign-in mark", () => {
    assert.deepEqual(passwordManagerProps({}), PASSWORD_MANAGER_IGNORE);
    assert.deepEqual(passwordManagerProps({ [CREDENTIAL_ATTRIBUTE]: undefined }), PASSWORD_MANAGER_IGNORE);
    assert.deepEqual(passwordManagerProps({ [CREDENTIAL_ATTRIBUTE]: null }), PASSWORD_MANAGER_IGNORE);
    assert.deepEqual(passwordManagerProps({ [CREDENTIAL_ATTRIBUTE]: false }), PASSWORD_MANAGER_IGNORE);
    assert.deepEqual(passwordManagerProps({ [CREDENTIAL_ATTRIBUTE]: true }), {});
    assert.deepEqual(passwordManagerProps({ [CREDENTIAL_ATTRIBUTE]: "" }), {});
  });
});

describe("across the app", () => {
  const clientDir = fileURLToPath(new URL("..", import.meta.url));
  const read = (relative: string) => readFileSync(path.join(clientDir, relative), "utf8");

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return sources(full);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
    });
  }

  /** The screens where the person signs in to Genosyn or manages that sign-in. */
  const SIGN_IN_PAGES = [
    "pages/Login.tsx",
    "pages/Signup.tsx",
    "pages/Forgot.tsx",
    "pages/Reset.tsx",
    "pages/AccountSecurity.tsx",
    "pages/AccountProfile.tsx",
  ];

  test("the app guards plain inputs from its first render", () => {
    const entry = read("main.tsx");
    const guard = entry.indexOf("installPasswordManagerGuard(");
    assert.ok(guard > 0, "main.tsx installs the guard");
    assert.ok(guard < entry.indexOf(".render("), "before React renders anything");
  });

  test("every sign-in field still lets a password manager fill it", () => {
    for (const page of SIGN_IN_PAGES) {
      const fields = read(page).match(/<Input\b[\s\S]*?\/>/g) ?? [];
      const signIn = fields.filter((field) =>
        /autoComplete=(?:"(?:email|current-password|new-password|one-time-code)"|\{[^}]*"one-time-code"[^}]*\})/.test(
          field,
        ),
      );
      assert.ok(signIn.length > 0, `${page} has sign-in fields`);
      for (const field of signIn) {
        assert.match(field, /data-credential/, `${page}: ${field.replace(/\s+/g, " ").slice(0, 120)}`);
      }
    }
  });

  test("nothing else is marked as a sign-in field", () => {
    const marked = sources(clientDir)
      .filter((file) => read(path.relative(clientDir, file)).includes(CREDENTIAL_ATTRIBUTE))
      .map((file) => path.relative(clientDir, file).split(path.sep).join("/"))
      .filter((file) => file !== "lib/passwordManagers.ts")
      .sort();
    // A customer's email, an SMTP password, a Vault secret or a new teammate's
    // account is not the person's own sign-in: password managers stay out.
    assert.deepEqual(marked, [...SIGN_IN_PAGES].sort());
  });
});
