/**
 * Keep password managers to the fields that are theirs.
 *
 * 1Password, LastPass, Bitwarden and Dashlane decorate any field that looks
 * like an email, a name or a phone number with their own button and menu, and
 * offer the person's own sign-in wherever they see a password box. In Genosyn
 * almost none of those fields are the person's: a customer's email, a vendor's
 * phone, an SMTP password, a Vault secret, a new teammate's account. So every
 * field is marked for password managers to ignore, except the person's own
 * Genosyn sign-in — their email, password, or one-time code on the sign-in,
 * sign-up, password and two-factor screens — which carries `data-credential`.
 *
 * The shared `Input` and `Textarea` render the marks themselves;
 * {@link installPasswordManagerGuard} adds them to every other field as it
 * appears, so a plain `<input>` written anywhere in the app is covered too.
 */

/** The attribute each password manager reads to leave a field alone. */
export const PASSWORD_MANAGER_IGNORE = {
  "data-1p-ignore": "true",
  "data-lpignore": "true",
  "data-bwignore": "true",
  "data-form-type": "other",
} as const;

/** Marks the person's own Genosyn sign-in field, on it or on a form around it. */
export const CREDENTIAL_ATTRIBUTE = "data-credential";
/** React renders `data-credential={false}` as the string "false"; that is no mark. */
const CREDENTIAL_SELECTOR = `[${CREDENTIAL_ATTRIBUTE}]:not([${CREDENTIAL_ATTRIBUTE}="false"])`;

/** Input types no password manager decorates. */
const NOT_TYPED_IN = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/** The slice of a DOM element this needs; tests pass a stand-in. */
export type FieldElement = {
  readonly tagName: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  closest(selectors: string): unknown;
};

/** A node that may hold fields: an element, or text that holds none. */
export type FieldTree = {
  readonly nodeType: number;
  querySelectorAll?: (selectors: string) => ArrayLike<FieldElement>;
};

/** Render-time marks for a field's props: none when they mark a sign-in field. */
export function passwordManagerProps(props: object): Partial<typeof PASSWORD_MANAGER_IGNORE> {
  const credential = (props as Record<string, unknown>)[CREDENTIAL_ATTRIBUTE];
  return credential === undefined || credential === null || credential === false
    ? PASSWORD_MANAGER_IGNORE
    : {};
}

function isTypedIn(field: FieldElement): boolean {
  const tag = field.tagName.toLowerCase();
  if (tag === "textarea") return true;
  if (tag !== "input") return false;
  return !NOT_TYPED_IN.has((field.getAttribute("type") ?? "text").trim().toLowerCase());
}

/** Mark one field for password managers to ignore, or unmark a sign-in field. */
export function syncPasswordManagerMarks(field: FieldElement): void {
  if (!isTypedIn(field)) return;
  const credential = field.closest(CREDENTIAL_SELECTOR) !== null;
  for (const [name, value] of Object.entries(PASSWORD_MANAGER_IGNORE)) {
    if (credential) {
      if (field.getAttribute(name) !== null) field.removeAttribute(name);
    } else if (field.getAttribute(name) !== value) {
      field.setAttribute(name, value);
    }
  }
}

/** Mark `node` and every field inside it. */
export function syncPasswordManagerMarksWithin(node: FieldTree): void {
  // Text and comment nodes — streamed chat, live transcripts — hold no fields.
  if (node.nodeType !== 1) return;
  syncPasswordManagerMarks(node as unknown as FieldElement);
  const fields = node.querySelectorAll?.("input, textarea") ?? [];
  for (let i = 0; i < fields.length; i++) syncPasswordManagerMarks(fields[i]);
}

/**
 * Mark every field under `root` now and each one React adds later, before the
 * person can focus it. Returns a function that stops watching.
 */
export function installPasswordManagerGuard(root: Node = document.body): () => void {
  const sync = (node: Node) => syncPasswordManagerMarksWithin(node as unknown as FieldTree);
  sync(root);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") sync(record.target);
      else record.addedNodes.forEach(sync);
    }
  });
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    // A field that changes type, or a form that becomes a sign-in form.
    attributeFilter: ["type", CREDENTIAL_ATTRIBUTE],
  });
  return () => observer.disconnect();
}
