import React from "react";
import { AlertCircle, X } from "lucide-react";
import { passwordManagerProps } from "@/lib/passwordManagers";
import {
  matchSuggestions,
  type RecipientOption,
  suggestionLabel,
  suggestionRecipient,
} from "@/lib/recipientSuggestions";
import {
  editableRecipient,
  formatRecipient,
  parseRecipients,
  type Recipient,
  recipientKey,
  recipientLabel,
  splitRecipientText,
  takeTypedRecipients,
} from "@/lib/recipientTokens";
import { clsx } from "./ui/clsx";

/**
 * Something the caller knows about one recipient that the Member should see
 * before sending — a do-not-email address, a domain a Policy blocks. Keyed by
 * {@link recipientKey}. The chip turns red and says why on hover; nothing is
 * removed for the Member.
 */
export type RecipientFlag = { reason: string };

export type RecipientInputHandle = {
  /** Close the match list. True when it was open, so the modal's Escape stops there. */
  closeMenu: () => boolean;
  focus: () => void;
};

/**
 * A To or Cc line as chips: one per recipient, with a box at the end to type
 * or paste more. Separators, a space after a finished address, Enter, Tab and
 * leaving the field turn what was typed into chips (`recipientTokens.ts` reads
 * it); an entry that is not an address stays as a red chip to fix — click it
 * to edit. While typing, the customer's people who match drop down below;
 * arrow keys move through them and Enter adds one.
 *
 * From the keyboard: Backspace in the empty box removes the last chip, and
 * ArrowLeft walks back into the chips, where Backspace or Delete removes one
 * and ArrowRight comes back. Chips stay out of the Tab order, so Tab moves
 * from field to field.
 *
 * The typed text belongs to the caller (`text`), so the dialog can turn it
 * into chips itself when the Member sends without leaving the field.
 *
 * Shared by Finance's send dialog (the customer's people) and the email
 * composer (the mailbox's correspondents), so suggestions are anything with
 * an address and a name. `variant="bare"` drops the field's own border for a
 * composer that rules its To, Cc and Bcc rows itself.
 */
export const RecipientInput = React.forwardRef<
  RecipientInputHandle,
  {
    /** "To", "Cc" or "Bcc": names the field for assistive technology. */
    label: string;
    recipients: Recipient[];
    text: string;
    onTextChange: (text: string) => void;
    onAdd: (recipients: Recipient[]) => void;
    onRemove: (email: string) => void;
    /** People not on the email yet, best first. */
    suggestions: RecipientOption[];
    /** The quiet line under a suggestion's name; defaults to its role. */
    describeSuggestion?: (suggestion: RecipientOption) => string;
    /** Recipients to mark, by {@link recipientKey}. */
    flags?: ReadonlyMap<string, RecipientFlag>;
    placeholder?: string;
    describedBy?: string;
    disabled?: boolean;
    autoFocus?: boolean;
    variant?: "field" | "bare";
    className?: string;
    /** The box's accessible name, when "<label> recipients" would read wrong. */
    inputLabel?: string;
  }
>(function RecipientInput(
  {
    label,
    recipients,
    text,
    onTextChange,
    onAdd,
    onRemove,
    suggestions,
    describeSuggestion,
    flags,
    placeholder,
    describedBy,
    disabled,
    autoFocus,
    variant = "field",
    className,
    inputLabel,
  },
  ref,
) {
  const fieldRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const chipRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  // What is in the box right now. Tab finishes the entry and then leaves the
  // field in the same breath, and the blur that follows must not finish it
  // again from the render before.
  const textRef = React.useRef(text);
  textRef.current = text;
  const listId = React.useId();
  const [focused, setFocused] = React.useState(false);
  const [dismissed, setDismissed] = React.useState(false);
  const [active, setActive] = React.useState(0);

  const matches = React.useMemo(() => matchSuggestions(suggestions, text), [suggestions, text]);
  const menuOpen = focused && !dismissed && matches.length > 0;
  const highlighted = menuOpen ? Math.min(active, matches.length - 1) : -1;

  React.useImperativeHandle(ref, () => ({
    closeMenu: () => {
      if (!menuOpen) return false;
      setDismissed(true);
      return true;
    },
    focus: () => inputRef.current?.focus(),
  }));

  function setText(next: string) {
    textRef.current = next;
    onTextChange(next);
  }

  function changeText(next: string) {
    const { recipients: finished, rest } = takeTypedRecipients(next);
    if (finished.length > 0) onAdd(finished);
    setText(rest);
    setDismissed(false);
    setActive(0);
  }

  function commitText() {
    const typed = textRef.current;
    if (!typed.trim()) return;
    setText("");
    onAdd(parseRecipients(typed));
  }

  function pick(suggestion: RecipientOption) {
    setText("");
    onAdd([suggestionRecipient(suggestion)]);
    setActive(0);
    inputRef.current?.focus();
  }

  function edit(index: number) {
    const chip = recipients[index];
    if (!chip) return;
    onRemove(chip.email);
    // Whatever was half-typed stays after the chip being fixed.
    const written = editableRecipient(chip);
    const typed = textRef.current;
    setText(typed.trim() ? `${written}, ${typed}` : written);
    window.requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(written.length, written.length);
    });
  }

  function focusChip(index: number) {
    if (index < 0) return;
    if (index >= recipients.length) {
      inputRef.current?.focus();
      return;
    }
    chipRefs.current[index]?.focus();
  }

  function removeAt(index: number, focusAfter: "previous" | "input") {
    const chip = recipients[index];
    if (!chip) return;
    // Focus that was in the field stays in it; a tap from elsewhere — on a
    // phone, above all — does not pull the keyboard up.
    const hadFocus = fieldRef.current?.contains(document.activeElement) ?? false;
    onRemove(chip.email);
    if (!hadFocus) return;
    window.requestAnimationFrame(() => {
      if (focusAfter === "previous" && index > 0) chipRefs.current[index - 1]?.focus();
      else inputRef.current?.focus();
    });
  }

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    const input = event.currentTarget;
    switch (event.key) {
      case "ArrowDown":
        if (matches.length === 0) return;
        event.preventDefault();
        setDismissed(false);
        setActive(menuOpen ? (highlighted + 1) % matches.length : 0);
        return;
      case "ArrowUp":
        if (!menuOpen) return;
        event.preventDefault();
        setActive((highlighted - 1 + matches.length) % matches.length);
        return;
      case "Enter":
        // Enter here never sends the email: it finishes the recipient.
        event.preventDefault();
        if (menuOpen && highlighted >= 0) pick(matches[highlighted]);
        else commitText();
        return;
      case "Tab":
        // Tab takes what was typed — the highlighted match, if any — and moves on.
        if (menuOpen && highlighted >= 0 && text.trim()) pick(matches[highlighted]);
        else commitText();
        return;
      case "Escape":
        if (menuOpen) setDismissed(true);
        return;
      case "Backspace":
        if (text === "" && recipients.length > 0) {
          event.preventDefault();
          onRemove(recipients[recipients.length - 1].email);
        }
        return;
      case "ArrowLeft":
        if (input.selectionStart === 0 && input.selectionEnd === 0 && recipients.length > 0) {
          event.preventDefault();
          focusChip(recipients.length - 1);
        }
        return;
    }
  }

  function onChipKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    switch (event.key) {
      case "ArrowLeft":
        event.preventDefault();
        focusChip(Math.max(index - 1, 0));
        return;
      case "ArrowRight":
        event.preventDefault();
        focusChip(index + 1);
        return;
      case "Backspace":
        event.preventDefault();
        removeAt(index, "previous");
        return;
      case "Delete":
        event.preventDefault();
        removeAt(index, "input");
        return;
      case "Escape":
        event.preventDefault();
        inputRef.current?.focus();
        return;
    }
  }

  function onPaste(event: React.ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData("text");
    if (!pasted) return;
    const input = event.currentTarget;
    const start = input.selectionStart ?? text.length;
    const end = input.selectionEnd ?? text.length;
    const combined = text.slice(0, start) + pasted + text.slice(end);
    // A list becomes chips at once; a single fragment goes in to keep typing.
    const addresses = pasted.split(/\s+/).filter((word) => word.includes("@")).length;
    if (/[,;\n\r]/.test(pasted) || addresses > 1 || splitRecipientText(combined).length > 1) {
      event.preventDefault();
      setText("");
      onAdd(parseRecipients(combined));
    }
  }

  const optionId = (index: number) => `${listId}-option-${index}`;

  return (
    <div className={clsx("relative", className)}>
      <div
        ref={fieldRef}
        className={clsx(
          "flex min-h-9 w-full flex-wrap items-center gap-1.5",
          variant === "field" &&
            "rounded-lg border bg-white px-2 py-1.5 shadow-sm dark:bg-slate-900 focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-500/20 dark:focus-within:ring-indigo-500/25",
          variant === "field" &&
            (recipients.some((chip) => !chip.valid)
              ? "border-red-400 dark:border-red-800"
              : "border-slate-200 dark:border-slate-700"),
          variant === "bare" && "py-1",
          disabled && "opacity-60",
        )}
        // A click on the field's empty space puts the cursor in the box.
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            event.preventDefault();
            inputRef.current?.focus();
          }
        }}
      >
        {recipients.map((chip, index) => {
          const flag = chip.valid ? flags?.get(recipientKey(chip.email)) : undefined;
          const problem = !chip.valid || Boolean(flag);
          return (
            <span
              key={`${chip.email}-${index}`}
              className={clsx(
                "inline-flex max-w-full items-center gap-1 rounded-md py-0.5 pl-2 pr-0.5 text-sm",
                problem
                  ? "bg-red-50 text-red-700 ring-1 ring-inset ring-red-200 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-500/30"
                  : "bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-100",
              )}
              data-recipient={chip.email}
              data-valid={chip.valid ? "true" : "false"}
              data-flagged={flag ? "true" : undefined}
            >
              {problem && <AlertCircle size={12} className="shrink-0" aria-hidden />}
              <button
                type="button"
                tabIndex={-1}
                // The cursor stays in the box: these act on the chip, they are not a stop.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => edit(index)}
                disabled={disabled}
                title={
                  flag
                    ? `${formatRecipient(chip)} — ${flag.reason}`
                    : `${formatRecipient(chip)} — click to edit`
                }
                className="min-w-0 truncate text-left"
              >
                {recipientLabel(chip)}
              </button>
              <button
                type="button"
                tabIndex={-1}
                ref={(node) => {
                  chipRefs.current[index] = node;
                }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => removeAt(index, "input")}
                onKeyDown={(event) => onChipKeyDown(event, index)}
                disabled={disabled}
                aria-label={`Remove ${formatRecipient(chip)}`}
                className={clsx(
                  "shrink-0 rounded p-0.5 focus-visible:outline-none focus-visible:ring-2",
                  problem
                    ? "text-red-400 hover:bg-red-100 hover:text-red-700 focus-visible:ring-red-500/40 dark:hover:bg-red-500/20"
                    : "text-slate-400 hover:bg-slate-200 hover:text-slate-700 focus-visible:ring-focus dark:hover:bg-slate-700 dark:hover:text-slate-200",
                )}
              >
                <X size={12} />
              </button>
            </span>
          );
        })}
        <input
          ref={inputRef}
          type="text"
          inputMode="email"
          role="combobox"
          aria-label={inputLabel ?? `${label} recipients`}
          aria-autocomplete="list"
          aria-expanded={menuOpen}
          aria-controls={listId}
          aria-activedescendant={highlighted >= 0 ? optionId(highlighted) : undefined}
          aria-describedby={describedBy}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          {...passwordManagerProps({})}
          value={text}
          disabled={disabled}
          autoFocus={autoFocus}
          placeholder={recipients.length === 0 ? placeholder : undefined}
          onChange={(event) => changeText(event.target.value)}
          onKeyDown={onInputKeyDown}
          onPaste={onPaste}
          onFocus={() => {
            setFocused(true);
            setDismissed(false);
          }}
          onBlur={() => {
            setFocused(false);
            commitText();
          }}
          className="h-6 min-w-[6rem] flex-1 bg-transparent text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none dark:text-slate-100 dark:placeholder:text-slate-500"
        />
      </div>
      <ul
        id={listId}
        role="listbox"
        aria-label={`People to add to ${label}`}
        hidden={!menuOpen}
        className="absolute left-0 right-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"
      >
        {menuOpen &&
          matches.map((suggestion, index) => (
            <li
              key={suggestion.email}
              id={optionId(index)}
              role="option"
              aria-selected={index === highlighted}
              // Keep focus in the box, so picking does not count as leaving it.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => pick(suggestion)}
              className={clsx(
                "cursor-pointer px-3 py-1.5",
                index === highlighted && "bg-slate-100 dark:bg-slate-800",
              )}
            >
              <span className="block truncate text-sm text-slate-900 dark:text-slate-100">
                {suggestionLabel(suggestion)}
                {(describeSuggestion?.(suggestion) ?? suggestion.role) && (
                  <span className="ml-1.5 text-xs text-slate-500 dark:text-slate-400">
                    {describeSuggestion?.(suggestion) ?? suggestion.role}
                  </span>
                )}
              </span>
              {suggestion.name && (
                <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                  {suggestion.email}
                </span>
              )}
            </li>
          ))}
      </ul>
    </div>
  );
});
