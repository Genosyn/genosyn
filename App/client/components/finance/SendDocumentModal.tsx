import React from "react";
import { Mail, Paperclip, UserPlus } from "lucide-react";
import {
  api,
  type DocumentEmailDetails,
  type DocumentSendResult,
  type RecipientSuggestion,
  type RecipientSuggestionList as SuggestionPayload,
} from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import {
  alwaysCcAddresses,
  availableSuggestions,
  contactNameFor,
  suggestionRecipient,
  unsavedRecipients,
} from "@/lib/recipientSuggestions";
import {
  addRecipients,
  parseRecipients,
  type Recipient,
  recipientAddresses,
  type RecipientField,
  type RecipientFields,
  recipientProblem,
  removeRecipient,
} from "@/lib/recipientTokens";
import { Button } from "../ui/Button";
import { useDialog } from "../ui/Dialog";
import { FormError } from "../ui/FormError";
import { Modal } from "../ui/Modal";
import { Textarea } from "../ui/Textarea";
import { RecipientInput, type RecipientInputHandle } from "./RecipientInput";
import { RecipientSuggestionList, type SuggestionsState } from "./RecipientSuggestionList";

/** Every one the dialog can show; the server's own ceiling. */
const SUGGESTIONS_FETCHED = 100;

/**
 * The dialog that emails an invoice or an estimate to the customer: who it
 * is from, who it goes to, a note, and whether the PDF goes with it.
 *
 * To starts with the customer's billing email; To and Cc are chips
 * (`RecipientInput`), and below them the customer's people
 * (`GET /customers/:slug/recipient-suggestions`) are one click from Cc, or
 * from To with their To button. An address typed that is none of the
 * customer's people yet can be saved to its contacts, so it is suggested next
 * time. The email goes to exactly the To and Cc shown — plus Finance →
 * Settings → Always Cc, on an invoice — and the server checks every address
 * again.
 *
 * The dialog closes on every send it got an answer for; a send that went out
 * without its PDF, or did not go out, says why in the error modal, since the
 * dialog is gone.
 */
export function SendDocumentModal({
  companyId,
  kind,
  title,
  number,
  customer,
  details,
  sendPath,
  initialMessage = "",
  submitLabel,
  onClose,
  onFinished,
}: {
  companyId: string;
  kind: "invoice" | "estimate";
  title: string;
  /** The document number, which names its PDF. */
  number: string;
  customer: { slug: string; name: string } | null;
  details: DocumentEmailDetails;
  /** `/api/companies/:cid/invoices/:slug/send` or its estimate twin. */
  sendPath: string;
  /** A note to start from, such as the one that says the document was updated. */
  initialMessage?: string;
  submitLabel: string;
  onClose: () => void;
  /** The send was answered — delivered or not — and the dialog has closed. */
  onFinished: (result: DocumentSendResult) => void;
}) {
  const dialog = useDialog();
  const [fields, setFields] = React.useState<RecipientFields>(() => ({
    to: parseRecipients(details.toAddress),
    cc: [],
  }));
  const [toText, setToText] = React.useState("");
  const [ccText, setCcText] = React.useState("");
  const [message, setMessage] = React.useState(initialMessage);
  const [attachPdf, setAttachPdf] = React.useState(true);
  const [busy, setBusy] = React.useState<null | "send" | "save">(null);
  const [error, setError] = React.useState<string | null>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const toRef = React.useRef<RecipientInputHandle>(null);
  const ccRef = React.useRef<RecipientInputHandle>(null);
  const invalidNoteId = React.useId();

  const alwaysCc = React.useMemo(
    () => alwaysCcAddresses(details.alwaysCcAddress),
    [details.alwaysCcAddress],
  );

  const [suggestions, setSuggestions] = React.useState<RecipientSuggestion[]>([]);
  const [domain, setDomain] = React.useState<string | null>(null);
  const [suggestionsState, setSuggestionsState] = React.useState<SuggestionsState>(
    customer ? { status: "loading" } : { status: "ready", total: 0 },
  );
  const customerSlug = customer?.slug ?? null;
  const loadSuggestions = React.useCallback(async () => {
    if (!customerSlug) return;
    try {
      const result = await api.get<SuggestionPayload>(
        `/api/companies/${companyId}/customers/${encodeURIComponent(customerSlug)}/recipient-suggestions?limit=${SUGGESTIONS_FETCHED}`,
      );
      setSuggestions(result.suggestions);
      setDomain(result.domain);
      setSuggestionsState({ status: "ready", total: result.suggestions.length });
    } catch (err) {
      setSuggestionsState({ status: "error", message: errorMessage(err) });
    }
  }, [companyId, customerSlug]);
  React.useEffect(() => {
    void loadSuggestions();
  }, [loadSuggestions]);

  const available = React.useMemo(
    () => availableSuggestions(suggestions, fields, alwaysCc),
    [suggestions, fields, alwaysCc],
  );
  // Only once the customer's people are known can anyone be called new.
  const unsaved =
    customer && suggestionsState.status === "ready"
      ? unsavedRecipients(fields, suggestions, alwaysCc)
      : [];
  const invalidChips = [...fields.to, ...fields.cc].filter((item) => !item.valid);

  function add(field: RecipientField, incoming: Recipient[]) {
    setError(null);
    setFields((current) => addRecipients(current, field, incoming));
  }

  function remove(field: RecipientField, email: string) {
    setError(null);
    setFields((current) => removeRecipient(current, field, email));
  }

  async function saveContacts() {
    if (!customer || unsaved.length === 0) return;
    setSaveError(null);
    setBusy("save");
    try {
      for (const item of unsaved) {
        await api.post(
          `/api/companies/${companyId}/customers/${encodeURIComponent(customer.slug)}/contacts`,
          {
            name: contactNameFor(item),
            email: item.email,
          },
        );
      }
      await loadSuggestions();
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    // Whatever is still being typed goes on the email too, as it would on blur.
    let final = fields;
    if (toText.trim()) final = addRecipients(final, "to", parseRecipients(toText));
    if (ccText.trim()) final = addRecipients(final, "cc", parseRecipients(ccText));
    setFields(final);
    setToText("");
    setCcText("");
    const problem = recipientProblem(final);
    if (problem) {
      setError(problem);
      if (final.to.length === 0 || final.to.some((item) => !item.valid)) toRef.current?.focus();
      else ccRef.current?.focus();
      return;
    }
    setBusy("send");
    try {
      const result = await api.post<{ send: DocumentSendResult }>(sendPath, {
        to: recipientAddresses(final.to),
        cc: recipientAddresses(final.cc),
        message: message.trim(),
        attachPdf,
      });
      // The dialog closes on every outcome and the History feed logs it; only
      // a partial or failed send carries a reason worth stopping the Member for.
      if (result.send.status === "sent") {
        if (result.send.pdfRequested && !result.send.pdfAttached) {
          void dialog.error("The PDF attachment could not be generated.", {
            title: "Email sent without the PDF",
          });
        }
      } else if (result.send.status === "skipped") {
        void dialog.error("Set one in Settings → Notification email, then send again.", {
          title: "No email transport configured",
        });
      } else {
        void dialog.error(result.send.errorMessage || "Unknown error", {
          title: `Couldn’t email the ${kind}`,
        });
      }
      onFinished(result.send);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const rowClass = "grid grid-cols-1 gap-1 px-4 py-3 sm:grid-cols-[5rem_1fr] sm:gap-3";

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      // Wide enough for a chip line and a suggestion's role on one line each.
      size="lg"
      onSubmit={send}
      // An open match list owns the first Escape.
      onEscape={() => toRef.current?.closeMenu() || ccRef.current?.closeMenu() || false}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy !== null}>
            Cancel
          </Button>
          <Button
            type="submit"
            loading={busy === "send"}
            disabled={busy !== null || (fields.to.length === 0 && !toText.trim())}
          >
            <Mail size={14} /> {busy === "send" ? "Sending…" : submitLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="overflow-visible rounded-lg border border-slate-200 bg-slate-50 text-sm dark:border-slate-700 dark:bg-slate-800/50">
          <dl className="divide-y divide-slate-200 dark:divide-slate-700">
            <div className={rowClass}>
              <dt className="text-slate-500 dark:text-slate-400">From</dt>
              <dd className="break-all font-medium text-slate-900 dark:text-slate-100">
                {details.fromAddress || "No sender configured"}
              </dd>
            </div>
            {details.replyTo && (
              <div className={rowClass}>
                <dt className="text-slate-500 dark:text-slate-400">Reply to</dt>
                <dd className="break-all text-slate-700 dark:text-slate-200">{details.replyTo}</dd>
              </div>
            )}
            {details.alwaysCcAddress && (
              <div className={rowClass}>
                <dt className="text-slate-500 dark:text-slate-400">Always Cc</dt>
                <dd className="break-all text-slate-700 dark:text-slate-200">
                  {details.alwaysCcAddress}
                </dd>
              </div>
            )}
            <div className={rowClass}>
              <dt className="text-slate-500 sm:pt-2 dark:text-slate-400">To</dt>
              <dd className="min-w-0">
                <RecipientInput
                  ref={toRef}
                  label="To"
                  recipients={fields.to}
                  text={toText}
                  onTextChange={setToText}
                  onAdd={(incoming) => add("to", incoming)}
                  onRemove={(email) => remove("to", email)}
                  suggestions={available}
                  placeholder="name@example.com"
                  describedBy={invalidChips.length ? invalidNoteId : undefined}
                  disabled={busy === "send"}
                />
              </dd>
            </div>
            <div className={rowClass}>
              <dt className="text-slate-500 sm:pt-2 dark:text-slate-400">Cc</dt>
              <dd className="min-w-0">
                <RecipientInput
                  ref={ccRef}
                  label="Cc"
                  recipients={fields.cc}
                  text={ccText}
                  onTextChange={setCcText}
                  onAdd={(incoming) => add("cc", incoming)}
                  onRemove={(email) => remove("cc", email)}
                  suggestions={available}
                  placeholder="Optional"
                  describedBy={invalidChips.length ? invalidNoteId : undefined}
                  disabled={busy === "send"}
                />
                {invalidChips.length > 0 && (
                  <p id={invalidNoteId} className="mt-1 text-xs text-red-600 dark:text-red-400">
                    {invalidChips.length === 1
                      ? `“${invalidChips[0].email}” isn’t a valid email address — click it to fix it, or remove it.`
                      : `${invalidChips.length} entries aren’t valid email addresses — click one to fix it, or remove it.`}
                  </p>
                )}
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {details.alwaysCcAddress
                    ? "Additional recipients only; Always Cc from Finance → Settings is included too. "
                    : ""}
                  Type or paste addresses, separated by commas.
                </p>
                {unsaved.length > 0 && customer && (
                  <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-600 dark:text-slate-300">
                    <span className="min-w-0">
                      {unsaved.length === 1
                        ? `${unsaved[0].email} isn’t one of ${customer.name}’s contacts yet.`
                        : `${unsaved.length} addresses aren’t ${customer.name}’s contacts yet.`}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => void saveContacts()}
                      loading={busy === "save"}
                      disabled={busy !== null}
                    >
                      <UserPlus size={13} />
                      {unsaved.length === 1 ? "Save as contact" : "Save as contacts"}
                    </Button>
                  </div>
                )}
                <FormError message={saveError} className="mt-2" />
              </dd>
            </div>
          </dl>
          {customer && (
            <div className="border-t border-slate-200 px-4 py-3 dark:border-slate-700">
              <RecipientSuggestionList
                customerName={customer.name}
                domain={domain}
                suggestions={available}
                state={suggestionsState}
                onAdd={(suggestion, field) => add(field, [suggestionRecipient(suggestion)])}
                onRetry={() => {
                  setSuggestionsState({ status: "loading" });
                  void loadSuggestions();
                }}
                afterLast={ccRef}
              />
            </div>
          )}
        </div>

        {!details.configured && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
            No email transport is configured. This attempt will be logged, but no email will be
            delivered.
          </div>
        )}

        <Textarea
          label="Message (optional)"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Add a short note for the customer…"
          maxLength={4000}
          rows={4}
        />

        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 px-3 py-3 dark:border-slate-700">
          <input
            type="checkbox"
            checked={attachPdf}
            onChange={(e) => setAttachPdf(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-800"
          />
          <span className="flex min-w-0 gap-2">
            <Paperclip size={16} className="mt-0.5 shrink-0 text-slate-400" />
            <span>
              <span className="block text-sm font-medium text-slate-800 dark:text-slate-100">
                Attach {kind} as PDF
              </span>
              <span className="block text-xs text-slate-500 dark:text-slate-400">
                {number || kind}.pdf
              </span>
            </span>
          </span>
        </label>

        <FormError message={error} />
      </div>
    </Modal>
  );
}
