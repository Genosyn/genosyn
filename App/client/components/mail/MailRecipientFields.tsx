import React from "react";
import { Link } from "react-router-dom";
import { AlertCircle } from "lucide-react";
import { type MailBlockedRecipient, type MailRecipientSuggestion, mailApi } from "@/lib/mail";
import {
  addMailRecipients,
  allMailRecipients,
  MAIL_FIELD_LABELS,
  type MailRecipientField,
  type MailRecipients,
  removeEverywhere,
  removeMailRecipient,
} from "@/lib/mailRecipients";
import { type RecipientOption } from "@/lib/recipientSuggestions";
import { parseRecipients, type Recipient, recipientKey } from "@/lib/recipientTokens";
import { RecipientInput, type RecipientFlag, type RecipientInputHandle } from "../RecipientInput";
import { clsx } from "../ui/clsx";

/**
 * The To, Cc and Bcc lines of every email composer — a reply, a new message,
 * a draft being edited, an AI Employee's email under review.
 *
 * Each line is chips (`RecipientInput`): type or paste to add, click a chip to
 * edit it, × or Backspace to take someone off. While typing, people on the
 * thread come first, then the mailbox's own correspondents. Cc and Bcc stay
 * folded behind two small buttons until they are used. Putting someone on a
 * line takes them off the others, so moving a person to Bcc is just adding
 * them there.
 *
 * Anyone the send would be refused for — the do-not-email list, a Policy's
 * blocked domain — turns red the moment they are added
 * ({@link useMailRecipientCheck}), with the reason and a Remove button under
 * the lines, instead of a failed send after the Member pressed it.
 */

export type MailRecipientFieldsHandle = {
  /** Turn anything still typed into chips, and return the lines as they now stand. */
  commit: () => MailRecipients;
  focus: (field?: MailRecipientField) => void;
  /** Close an open suggestion list; true when one was open (so Escape stops there). */
  closeMenus: () => boolean;
};

const SUGGESTION_DEBOUNCE_MS = 150;
const CHECK_DEBOUNCE_MS = 250;

export const MailRecipientFields = React.forwardRef<
  MailRecipientFieldsHandle,
  {
    companyId: string;
    companySlug: string;
    accountId: string;
    value: MailRecipients;
    onChange: (next: MailRecipients) => void;
    /** People on the thread, offered before the address book. */
    participants?: Recipient[];
    /** The mailbox's own address, never suggested. */
    selfAddress: string;
    blocked: MailBlockedRecipient[];
    /** Which line takes the cursor when the composer opens. */
    autoFocus?: MailRecipientField;
    disabled?: boolean;
    className?: string;
  }
>(function MailRecipientFields(
  {
    companyId,
    companySlug,
    accountId,
    value,
    onChange,
    participants = [],
    selfAddress,
    blocked,
    autoFocus,
    disabled,
    className,
  },
  ref,
) {
  const [texts, setTexts] = React.useState<Record<MailRecipientField, string>>({
    to: "",
    cc: "",
    bcc: "",
  });
  const [opened, setOpened] = React.useState<Record<"cc" | "bcc", boolean>>({
    cc: false,
    bcc: false,
  });
  const [pendingFocus, setPendingFocus] = React.useState<{ field: MailRecipientField } | null>(
    null,
  );
  const inputs = {
    to: React.useRef<RecipientInputHandle>(null),
    cc: React.useRef<RecipientInputHandle>(null),
    bcc: React.useRef<RecipientInputHandle>(null),
  };
  // The latest props, for the handle: commit() runs from a click handler that
  // may fire before the next render.
  const latest = React.useRef({ value, texts });
  latest.current = { value, texts };

  const showCc = opened.cc || value.cc.length > 0 || texts.cc.trim() !== "";
  const showBcc = opened.bcc || value.bcc.length > 0 || texts.bcc.trim() !== "";

  const flags = React.useMemo(() => {
    const map = new Map<string, RecipientFlag>();
    for (const item of blocked) map.set(recipientKey(item.email), { reason: item.detail });
    return map;
  }, [blocked]);

  React.useImperativeHandle(ref, () => ({
    commit: () => {
      let next = latest.current.value;
      const typed = latest.current.texts;
      for (const field of ["to", "cc", "bcc"] as const) {
        if (typed[field].trim())
          next = addMailRecipients(next, field, parseRecipients(typed[field]));
      }
      if (next !== latest.current.value) onChange(next);
      setTexts({ to: "", cc: "", bcc: "" });
      return next;
    },
    focus: (field = "to") => {
      if (field !== "to") setOpened((current) => ({ ...current, [field]: true }));
      setPendingFocus({ field });
    },
    closeMenus: () =>
      (["to", "cc", "bcc"] as const).some((field) => inputs[field].current?.closeMenu() ?? false),
  }));

  const taken = React.useMemo(
    () =>
      new Set([
        recipientKey(selfAddress),
        ...allMailRecipients(value).map((item) => recipientKey(item.email)),
      ]),
    [selfAddress, value],
  );

  const open = (field: "cc" | "bcc") => {
    setOpened((current) => ({ ...current, [field]: true }));
    setPendingFocus({ field });
  };

  // Focus lands in the same commit that shows the line. A frame later it
  // could arrive after the Member had already moved on, and pull the cursor
  // back out of whatever they were typing in.
  React.useLayoutEffect(() => {
    if (!pendingFocus) return;
    inputs[pendingFocus.field].current?.focus();
    setPendingFocus(null);
    // inputs are refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFocus]);

  const row = (field: MailRecipientField) => (
    <RecipientRow
      key={field}
      field={field}
      inputRef={inputs[field]}
      companyId={companyId}
      accountId={accountId}
      recipients={value[field]}
      text={texts[field]}
      onTextChange={(text) => setTexts((current) => ({ ...current, [field]: text }))}
      onAdd={(incoming) => onChange(addMailRecipients(value, field, incoming))}
      onRemove={(email) => onChange(removeMailRecipient(value, field, email))}
      participants={participants}
      taken={taken}
      flags={flags}
      autoFocus={autoFocus === field}
      disabled={disabled}
      trailing={
        field === "to" && (!showCc || !showBcc) ? (
          <span className="flex shrink-0 items-center gap-0.5 pt-1">
            {!showCc && <FieldToggle label="Cc" onClick={() => open("cc")} disabled={disabled} />}
            {!showBcc && (
              <FieldToggle label="Bcc" onClick={() => open("bcc")} disabled={disabled} />
            )}
          </span>
        ) : null
      }
    />
  );

  return (
    <div className={className}>
      <div className="divide-y divide-slate-100 dark:divide-slate-800">
        {row("to")}
        {showCc && row("cc")}
        {showBcc && row("bcc")}
      </div>
      <BlockedRecipientsNotice
        blocked={blocked}
        companySlug={companySlug}
        onRemove={(email) => {
          const lost = focusLeavingWith();
          onChange(removeEverywhere(value, email));
          // Pressed from the keyboard, the button leaves with the warning:
          // the cursor goes back to the To line rather than onto the page.
          if (lost) setPendingFocus({ field: "to" });
        }}
        onRemoveAll={() => {
          const lost = focusLeavingWith();
          let next = value;
          for (const item of blocked) next = removeEverywhere(next, item.email);
          onChange(next);
          if (lost) setPendingFocus({ field: "to" });
        }}
      />
    </div>
  );
});

/** Whether focus sits on a button inside the warning that is about to go. */
function focusLeavingWith(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement && active.closest("[data-blocked-notice]") !== null;
}

function FieldToggle({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={`Add ${label} recipients`}
      className="touch-target relative rounded-md px-1.5 py-0.5 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
    >
      {label}
    </button>
  );
}

function RecipientRow({
  field,
  inputRef,
  companyId,
  accountId,
  recipients,
  text,
  onTextChange,
  onAdd,
  onRemove,
  participants,
  taken,
  flags,
  autoFocus,
  disabled,
  trailing,
}: {
  field: MailRecipientField;
  inputRef: React.RefObject<RecipientInputHandle>;
  companyId: string;
  accountId: string;
  recipients: Recipient[];
  text: string;
  onTextChange: (text: string) => void;
  onAdd: (incoming: Recipient[]) => void;
  onRemove: (email: string) => void;
  participants: Recipient[];
  taken: Set<string>;
  flags: ReadonlyMap<string, RecipientFlag>;
  autoFocus?: boolean;
  disabled?: boolean;
  trailing: React.ReactNode;
}) {
  const remote = useMailAddressBook(companyId, accountId, text);
  const { suggestions, detail } = React.useMemo(
    () => mergeSuggestions(participants, remote, taken),
    [participants, remote, taken],
  );
  const label = MAIL_FIELD_LABELS[field];
  return (
    <div className="flex items-start gap-2">
      <span className="w-12 shrink-0 pt-2 text-xs font-medium text-slate-500 dark:text-slate-400">
        {label}
      </span>
      <RecipientInput
        ref={inputRef}
        label={label}
        variant="bare"
        className="min-w-0 flex-1"
        recipients={recipients}
        text={text}
        onTextChange={onTextChange}
        onAdd={onAdd}
        onRemove={onRemove}
        suggestions={suggestions}
        describeSuggestion={(suggestion) => detail.get(recipientKey(suggestion.email)) ?? ""}
        flags={flags}
        autoFocus={autoFocus}
        disabled={disabled}
      />
      {trailing}
    </div>
  );
}

/** The thread's people first, then the address book; nobody already on the email. */
export function mergeSuggestions(
  participants: Recipient[],
  remote: MailRecipientSuggestion[],
  taken: Set<string>,
): { suggestions: RecipientOption[]; detail: Map<string, string> } {
  const suggestions: RecipientOption[] = [];
  const detail = new Map<string, string>();
  const seen = new Set<string>();
  for (const person of participants) {
    const key = recipientKey(person.email);
    if (!key || taken.has(key) || seen.has(key)) continue;
    seen.add(key);
    suggestions.push({ email: person.email, name: person.name });
    detail.set(key, "On this thread");
  }
  for (const person of remote) {
    const key = recipientKey(person.email);
    if (!key || taken.has(key)) continue;
    if (seen.has(key)) {
      // A name the thread lacked can come from the address book.
      const known = suggestions.find((item) => recipientKey(item.email) === key);
      if (known && !known.name && person.name) known.name = person.name;
      continue;
    }
    seen.add(key);
    suggestions.push({ email: person.email, name: person.name });
    if (person.count > 1) detail.set(key, `${person.count} emails`);
  }
  return { suggestions, detail };
}

/** The mailbox's correspondents matching what is typed, fetched as the Member types. */
export function useMailAddressBook(
  companyId: string,
  accountId: string,
  text: string,
): MailRecipientSuggestion[] {
  const [found, setFound] = React.useState<MailRecipientSuggestion[]>([]);
  const query = text.trim();
  React.useEffect(() => {
    // A finished address has nothing left to look up.
    if (!accountId || !query || /[,;\s]/.test(query)) {
      setFound([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      mailApi
        .recipientSuggestions(companyId, accountId, query)
        .then((result) => {
          if (!cancelled) setFound(result.suggestions);
        })
        .catch(() => {
          // Suggestions are a convenience; typing the address still works.
          if (!cancelled) setFound([]);
        });
    }, SUGGESTION_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [companyId, accountId, query]);
  return found;
}

/**
 * Who the send would be refused for, re-checked as the lines change. Reads
 * only — the server checks again on send, so a failed check here costs a
 * warning, never a wrong send.
 */
export function useMailRecipientCheck(
  companyId: string,
  accountId: string,
  fields: MailRecipients,
): MailBlockedRecipient[] {
  const [result, setResult] = React.useState<{ key: string; blocked: MailBlockedRecipient[] }>({
    key: "",
    blocked: [],
  });
  const addresses = (items: Recipient[]) =>
    items.filter((item) => item.valid).map((item) => item.email.trim());
  const to = addresses(fields.to).join(", ");
  const cc = addresses(fields.cc).join(", ");
  const bcc = addresses(fields.bcc).join(", ");
  const key = `${accountId}|${to}|${cc}|${bcc}`;
  const empty = !accountId || (!to && !cc && !bcc);
  React.useEffect(() => {
    if (empty) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      mailApi
        .recipientCheck(companyId, accountId, { to, cc, bcc })
        .then((response) => {
          if (!cancelled) setResult({ key, blocked: response.blocked });
        })
        .catch(() => {
          if (!cancelled) setResult({ key, blocked: [] });
        });
    }, CHECK_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [companyId, accountId, key, to, cc, bcc, empty]);
  if (empty) return [];
  // Between a change and its answer, keep showing only warnings still on the email.
  const present = new Set(allMailRecipients(fields).map((item) => recipientKey(item.email)));
  return result.blocked.filter((item) => present.has(recipientKey(item.email)));
}

function BlockedRecipientsNotice({
  blocked,
  companySlug,
  onRemove,
  onRemoveAll,
}: {
  blocked: MailBlockedRecipient[];
  companySlug: string;
  onRemove: (email: string) => void;
  onRemoveAll: () => void;
}) {
  if (blocked.length === 0) return null;
  const suppressed = blocked.some((item) => item.reason !== "policy");
  return (
    <div
      role="alert"
      data-blocked-notice
      className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200"
    >
      <div className="flex items-start gap-2">
        <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <p>
            {blocked.length === 1
              ? "This email can’t go to one of its recipients:"
              : `This email can’t go to ${blocked.length} of its recipients:`}
          </p>
          <ul className="space-y-1">
            {blocked.map((item) => (
              <li key={item.email} className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium break-all">{item.email}</span>
                <span className="text-red-700 dark:text-red-300">{item.detail}</span>
                <button
                  type="button"
                  // The cursor stays where the Member was writing.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onRemove(item.email)}
                  className="font-medium underline underline-offset-2 hover:text-red-950 dark:hover:text-red-100"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-x-3 pt-0.5 text-xs">
            {blocked.length > 1 && (
              <button
                type="button"
                onClick={onRemoveAll}
                className="font-medium underline underline-offset-2 hover:text-red-950 dark:hover:text-red-100"
              >
                Remove all {blocked.length}
              </button>
            )}
            {suppressed && (
              <Link
                to={`/c/${companySlug}/revenue/suppressions`}
                className={clsx(
                  "underline underline-offset-2 hover:text-red-950 dark:hover:text-red-100",
                )}
              >
                Manage the do-not-email list
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
