import React from "react";
import {
  AlertTriangle,
  ArrowDown,
  Check,
  CheckCircle2,
  Download,
  ExternalLink,
  FileSignature,
  LockKeyhole,
  PenLine,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { useParams } from "react-router-dom";
import { Logo } from "@/components/Logo";
import { PdfCanvasRenderer } from "@/components/signatures/PdfCanvasRenderer";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import { Textarea } from "@/components/ui/Textarea";
import { api } from "@/lib/api";
import {
  SIGNATURE_FIELD_LABELS,
  canRetryPublicSignatureFinalization,
  firstIncompleteRequiredSignatureField,
  formatSignatureDate,
  publicSignatureRecipientIsComplete,
  signatureCalendarDateForOffset,
  signatureFieldValueIsComplete,
  type PublicSigningEnvelope,
  type SignatureField,
} from "@/lib/signing";

type FieldValue = string | boolean;
type CompletionResult = { completed: boolean; envelopeId: string; recipientId: string };

function signingFieldElementId(fieldId: string): string {
  return `public-signing-field-${fieldId}`;
}

function signerTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

function normalizePublic(value: unknown): PublicSigningEnvelope {
  const raw = (value ?? {}) as PublicSigningEnvelope;
  return {
    ...raw,
    fields: Array.isArray(raw.fields) ? raw.fields : [],
  };
}

export default function PublicSigning() {
  const { token = "" } = useParams<{ token: string }>();
  const base = `/api/sign/${encodeURIComponent(token)}`;
  const [data, setData] = React.useState<PublicSigningEnvelope | null>(null);
  const [values, setValues] = React.useState<Record<string, FieldValue>>({});
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [declineError, setDeclineError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [editorFrozen, setEditorFrozen] = React.useState(false);
  const [consent, setConsent] = React.useState(false);
  const [completed, setCompleted] = React.useState(false);
  const [signerDirty, setSignerDirty] = React.useState(false);
  const [captureDirty, setCaptureDirty] = React.useState(false);
  const [captureField, setCaptureField] = React.useState<SignatureField | null>(null);
  const [declineOpen, setDeclineOpen] = React.useState(false);
  const [declineReason, setDeclineReason] = React.useState("");
  const [activeFieldId, setActiveFieldId] = React.useState<string | null>(null);
  const [missingFieldId, setMissingFieldId] = React.useState<string | null>(null);
  const [adoptedMarks, setAdoptedMarks] = React.useState<
    Partial<Record<"signature" | "initials", string>>
  >({});
  const finishPanelRef = React.useRef<HTMLElement | null>(null);
  const consentInputRef = React.useRef<HTMLInputElement | null>(null);
  const finishButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const viewSent = React.useRef(false);
  const valuesRef = React.useRef<Record<string, FieldValue>>({});
  const consentValueRef = React.useRef(false);
  const completionLockRef = React.useRef(false);
  const requestScopeRef = React.useRef(0);
  const completionIsLocked = React.useCallback(() => completionLockRef.current, []);
  const handleCaptureEditingChange = React.useCallback((dirty: boolean) => {
    if (!completionLockRef.current) setCaptureDirty(dirty);
  }, []);

  React.useEffect(() => {
    const requestScope = ++requestScopeRef.current;
    let cancelled = false;
    completionLockRef.current = false;
    consentValueRef.current = false;
    valuesRef.current = {};
    viewSent.current = false;
    setLoading(true);
    setSubmitting(false);
    setEditorFrozen(false);
    setConsent(false);
    setCaptureDirty(false);
    setCaptureField(null);
    setError(null);
    void api
      .get<unknown>(base)
      .then((response) => {
        if (cancelled || requestScopeRef.current !== requestScope) return;
        const next = normalizePublic(response);
        setData(next);
        setCompleted(next.recipient.status === "completed" || next.envelope.status === "completed");
        const initial: Record<string, FieldValue> = {};
        for (const field of next.fields) {
          if (typeof field.value === "string" || typeof field.value === "boolean") {
            initial[field.id] = field.value;
          } else if (field.type === "name") {
            initial[field.id] = next.recipient.name;
          } else if (field.type === "email") {
            initial[field.id] = next.recipient.email;
          } else if (field.type === "date") {
            const now = new Date();
            initial[field.id] = signatureCalendarDateForOffset(now, now.getTimezoneOffset());
          } else if (field.type === "checkbox") {
            initial[field.id] = false;
          }
        }
        valuesRef.current = initial;
        setValues(initial);
        setAdoptedMarks({});
        setSignerDirty(false);
        if (!viewSent.current && next.recipient.status !== "completed") {
          viewSent.current = true;
          void api.post(`${base}/view`).catch(() => undefined);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled && requestScopeRef.current === requestScope) {
          setError(cause instanceof Error ? cause.message : "This signing link is unavailable.");
        }
      })
      .finally(() => {
        if (!cancelled && requestScopeRef.current === requestScope) setLoading(false);
      });
    return () => {
      cancelled = true;
      if (requestScopeRef.current === requestScope) requestScopeRef.current += 1;
    };
  }, [base]);

  React.useEffect(() => {
    if ((!signerDirty && !captureDirty) || completed || data?.recipient.status === "declined") {
      return;
    }
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [captureDirty, completed, data?.recipient.status, signerDirty]);

  function fieldComplete(
    field: SignatureField,
    candidateValues: Record<string, FieldValue> = values,
  ): boolean {
    return signatureFieldValueIsComplete(field, candidateValues[field.id]);
  }

  function updateFieldValue(field: SignatureField, value: FieldValue) {
    if (completionLockRef.current) return;
    const nextValues = { ...valuesRef.current, [field.id]: value };
    valuesRef.current = nextValues;
    setValues(nextValues);
    setSignerDirty(true);
    setActiveFieldId(field.id);
    if (missingFieldId === field.id && signatureFieldValueIsComplete(field, value)) {
      setMissingFieldId(null);
      setError(null);
    }
  }

  function updateConsent(value: boolean) {
    if (completionLockRef.current) return;
    consentValueRef.current = value;
    setConsent(value);
    setSignerDirty(true);
    if (value) setError(null);
  }

  function navigateToField(field: SignatureField) {
    setActiveFieldId(field.id);
    window.requestAnimationFrame(() => {
      const element = document.getElementById(signingFieldElementId(field.id));
      if (!element) return;
      element.focus({ preventScroll: true });
      element.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "center",
      });
    });
  }

  function navigateToFinish() {
    const panel = finishPanelRef.current;
    if (!panel) return;
    panel.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "start",
    });
    window.requestAnimationFrame(() => {
      (consent ? finishButtonRef.current : consentInputRef.current)?.focus({ preventScroll: true });
    });
  }

  async function finish() {
    if (!data || completionLockRef.current) return;
    const now = new Date();
    const completionValues = { ...valuesRef.current };
    for (const field of data.fields) {
      if (field.type === "date") {
        completionValues[field.id] = signatureCalendarDateForOffset(now, now.getTimezoneOffset());
      }
    }
    const firstMissing = firstIncompleteRequiredSignatureField(data.fields, completionValues);
    if (firstMissing) {
      setMissingFieldId(firstMissing.id);
      setError(
        `Complete the required ${SIGNATURE_FIELD_LABELS[firstMissing.type].toLowerCase()} field on page ${firstMissing.pageNumber}.`,
      );
      navigateToField(firstMissing);
      return;
    }
    setMissingFieldId(null);
    if (!consentValueRef.current) {
      setError("Confirm that you agree to use electronic records and signatures.");
      navigateToFinish();
      return;
    }

    // Freeze synchronously before dispatch. React state alone would leave a
    // small window where another input event could mutate a value that is not
    // part of the already-snapshotted completion request.
    const requestScope = requestScopeRef.current;
    completionLockRef.current = true;
    valuesRef.current = completionValues;
    setValues(completionValues);
    setEditorFrozen(true);
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.post<CompletionResult>(`${base}/complete`, {
        consent: true,
        timezoneOffsetMinutes: now.getTimezoneOffset(),
        timeZone: signerTimeZone(),
        values: data.fields
          .filter((field) => completionValues[field.id] !== undefined)
          .map((field) => {
            const value = completionValues[field.id];
            return {
              fieldId: field.id,
              value:
                typeof value === "string" && value.startsWith("data:image/")
                  ? { kind: "drawn", dataUrl: value }
                  : value,
              type: field.type,
            };
          }),
      });
      if (requestScopeRef.current !== requestScope) return;
      setData((current) =>
        current
          ? {
              ...current,
              envelope: {
                ...current.envelope,
                status: result.completed ? "completed" : current.envelope.status,
              },
              recipient: { ...current.recipient, status: "completed" },
            }
          : current,
      );
      setCompleted(true);
      setSignerDirty(false);
      setCaptureDirty(false);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (cause) {
      if (requestScopeRef.current !== requestScope) return;
      const submissionError =
        cause instanceof Error ? cause.message : "Your signature could not be submitted.";
      try {
        const receipt = normalizePublic(await api.get<unknown>(base));
        if (requestScopeRef.current !== requestScope) return;
        if (publicSignatureRecipientIsComplete(receipt)) {
          setData(receipt);
          setCompleted(true);
          setSignerDirty(false);
          setCaptureDirty(false);
          setError(null);
          window.scrollTo({ top: 0, behavior: "smooth" });
          return;
        }
        // The authoritative receipt is still editable, so no signature was
        // durably accepted and the exact frozen values may safely be changed.
        completionLockRef.current = false;
        setEditorFrozen(false);
        setError(submissionError);
      } catch {
        if (requestScopeRef.current !== requestScope) return;
        // The request outcome is unknown. Keep the editor frozen so a second
        // set of values cannot be shown after the server may have accepted the
        // first set. Reloading this receipt will resolve its durable status.
        setError(
          "We could not confirm whether your signature was saved. Reload this page to check its status before trying again.",
        );
      }
    } finally {
      if (requestScopeRef.current === requestScope) setSubmitting(false);
    }
  }

  async function decline() {
    if (!declineReason.trim()) {
      setDeclineError("Please provide a reason for declining.");
      return;
    }
    setSubmitting(true);
    setDeclineError(null);
    try {
      await api.post(`${base}/decline`, { reason: declineReason.trim() });
      setData((current) =>
        current ? { ...current, recipient: { ...current.recipient, status: "declined" } } : current,
      );
      setDeclineOpen(false);
      setSignerDirty(false);
    } catch (cause) {
      setDeclineError(
        cause instanceof Error ? cause.message : "The envelope could not be declined.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function retryFinalization() {
    if (!data || !canRetryPublicSignatureFinalization(data)) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post<CompletionResult>(`${base}/finalize`, {});
      setData((current) =>
        current
          ? {
              ...current,
              envelope: {
                ...current.envelope,
                status: "completed",
                finalizationPending: false,
              },
            }
          : current,
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The completed document could not be prepared yet. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <PublicShell>
        <div className="flex min-h-[70vh] items-center justify-center gap-3 text-sm text-slate-500">
          <Spinner size={22} /> Opening your document…
        </div>
      </PublicShell>
    );
  }

  if (!data || (error && !data)) {
    return (
      <PublicShell>
        <TerminalCard
          icon={<AlertTriangle size={25} />}
          title="This signing link is unavailable"
          description={error ?? "Ask the sender for a new link."}
          tone="danger"
        />
      </PublicShell>
    );
  }

  if (data.recipient.status === "declined" || data.envelope.status === "declined") {
    return (
      <PublicShell>
        <TerminalCard
          icon={<XCircle size={25} />}
          title="Envelope declined"
          description="The sender has been notified. You can close this page."
          tone="danger"
          focusTitle
        />
      </PublicShell>
    );
  }

  if (["voided", "expired"].includes(data.envelope.status)) {
    return (
      <PublicShell>
        <TerminalCard
          icon={<AlertTriangle size={25} />}
          title={
            data.envelope.status === "expired"
              ? "This envelope has expired"
              : "This envelope was voided"
          }
          description="It can no longer be signed. Contact the sender if you need a replacement."
          tone="danger"
        />
      </PublicShell>
    );
  }

  if (completed) {
    const finalizationPending = canRetryPublicSignatureFinalization(data);
    return (
      <PublicShell>
        <TerminalCard
          icon={<CheckCircle2 size={25} />}
          title={finalizationPending ? "Your signature is saved" : "You are all done"}
          description={
            data.envelope.status === "completed"
              ? "Your signed document and audit trail have been securely recorded."
              : finalizationPending
                ? "Everyone has signed. Finish preparing the completed document and audit trail."
                : "Your part is complete. The sender will share the finished document after everyone has signed."
          }
          tone="success"
          focusTitle
          action={
            data.envelope.status === "completed" ? (
              <a
                href={`${base}/completed`}
                download
                className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 text-sm font-medium text-white transition hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1"
              >
                <Download size={15} /> Download completed PDF
              </a>
            ) : finalizationPending ? (
              <>
                <Button disabled={submitting} onClick={() => void retryFinalization()}>
                  {submitting ? <Spinner size={15} /> : <FileSignature size={15} />} Prepare
                  completed PDF
                </Button>
                <FormError message={error} className="mt-4" />
              </>
            ) : undefined
          }
        />
      </PublicShell>
    );
  }

  const requiredCount = data.fields.filter((field) => field.required).length;
  const requiredDone = data.fields.filter((field) => field.required && fieldComplete(field)).length;
  const nextRequiredField = firstIncompleteRequiredSignatureField(data.fields, values);
  const editorDisabled = submitting || editorFrozen;
  const documentDescription = [
    data.envelope.filename,
    data.envelope.originalPageCount
      ? `${data.envelope.originalPageCount} ${data.envelope.originalPageCount === 1 ? "page" : "pages"}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <PublicShell>
      <div className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
        <div className="w-full px-4 py-5 sm:px-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-slate-400">
                {data.sender?.companyName ?? data.envelope.companyName ?? "Document for signature"}
              </div>
              <h1 className="mt-1 text-xl font-semibold text-slate-900 dark:text-slate-100">
                {data.envelope.title}
              </h1>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Prepared for {data.recipient.name} ({data.recipient.email})
                {data.envelope.expiresAt
                  ? ` · expires ${formatSignatureDate(data.envelope.expiresAt)}`
                  : ""}
              </p>
              {documentDescription && (
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                  <span>{documentDescription}</span>
                  <a
                    href={`${base}/document`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-medium text-indigo-600 underline-offset-2 hover:underline focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-indigo-300"
                  >
                    Open original PDF <ExternalLink size={12} />
                  </a>
                </div>
              )}
            </div>
            <div
              role="status"
              aria-live="polite"
              className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300"
            >
              {requiredCount
                ? `${requiredDone} of ${requiredCount} required fields complete`
                : "Ready to acknowledge"}
            </div>
          </div>
          {data.envelope.message && (
            <div className="mt-4 max-w-3xl rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
              {data.envelope.message}
            </div>
          )}
        </div>
      </div>

      <div className="grid w-full gap-0 lg:grid-cols-[minmax(0,1fr)_21rem]">
        <main
          aria-busy={submitting || undefined}
          className="min-h-[75vh] bg-slate-200/70 pb-24 lg:pb-0 dark:bg-slate-900"
        >
          <div className={editorDisabled ? "pointer-events-none opacity-70" : undefined}>
            <PdfCanvasRenderer
              sourceUrl={`${base}/document`}
              fields={data.fields}
              selectedFieldId={activeFieldId}
              onFieldSelect={(fieldId) => {
                if (!completionLockRef.current) setActiveFieldId(fieldId);
              }}
              readOnly
              renderField={(field) => (
                <SigningField
                  field={field}
                  value={values[field.id]}
                  adoptedValue={
                    field.type === "signature" || field.type === "initials"
                      ? adoptedMarks[field.type]
                      : undefined
                  }
                  invalid={missingFieldId === field.id}
                  disabled={editorDisabled}
                  onChange={(value) => updateFieldValue(field, value)}
                  onCapture={() => {
                    if (!completionLockRef.current) setCaptureField(field);
                  }}
                />
              )}
            />
          </div>
        </main>
        <aside
          id="signing-finish-panel"
          ref={finishPanelRef}
          className="border-t border-slate-200 bg-white p-5 lg:sticky lg:top-0 lg:h-screen lg:overflow-y-auto lg:border-l lg:border-t-0 dark:border-slate-700 dark:bg-slate-950"
        >
          <form
            aria-busy={submitting || undefined}
            onSubmit={(event) => {
              event.preventDefault();
              void finish();
            }}
          >
            <fieldset disabled={editorDisabled} className="min-w-0 border-0 p-0">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                <FileSignature size={17} className="text-indigo-600" /> Finish signing
              </div>
              <p className="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400">
                Complete every required field highlighted on the document, then agree and finish.
              </p>

              <div className="mt-5 space-y-2">
                {data.fields.map((field) => (
                  <button
                    type="button"
                    key={field.id}
                    onClick={() => navigateToField(field)}
                    aria-label={`${field.label || SIGNATURE_FIELD_LABELS[field.type]}, page ${field.pageNumber}, ${fieldComplete(field) ? "complete" : field.required ? "required and incomplete" : "optional"}`}
                    className={`flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-xs text-slate-600 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-slate-300 dark:hover:bg-slate-900 ${
                      activeFieldId === field.id ? "bg-indigo-50 dark:bg-indigo-950/50" : ""
                    }`}
                  >
                    <span
                      className={`flex h-5 w-5 items-center justify-center rounded-full ${
                        fieldComplete(field)
                          ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-300"
                          : "bg-slate-100 text-slate-400 dark:bg-slate-800"
                      }`}
                    >
                      {fieldComplete(field) ? <Check size={12} /> : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {field.label || SIGNATURE_FIELD_LABELS[field.type]}
                      <span className="ml-1 text-slate-400">· p. {field.pageNumber}</span>
                    </span>
                    <span className={field.required ? "text-rose-500" : "text-slate-400"}>
                      {field.required ? "Required" : "Optional"}
                    </span>
                  </button>
                ))}
              </div>

              <label className="mt-6 flex items-start gap-3 rounded-xl border border-slate-200 p-3 text-xs leading-5 text-slate-600 focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-100 dark:border-slate-700 dark:text-slate-300 dark:focus-within:ring-indigo-950">
                <input
                  ref={consentInputRef}
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => updateConsent(event.target.checked)}
                  aria-describedby="electronic-signing-consent-copy"
                  className="mt-0.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                />
                <span id="electronic-signing-consent-copy">
                  I agree to use electronic records and signatures, and intend my electronic
                  signature to be legally binding.
                </span>
              </label>
              <FormError message={error} className="mt-4" />
              <Button
                ref={finishButtonRef}
                type="submit"
                className="mt-4 w-full"
                disabled={editorDisabled}
              >
                {submitting ? <Spinner size={15} /> : <PenLine size={15} />} Finish signing
              </Button>
              <Button
                type="button"
                className="mt-2 w-full"
                variant="ghost"
                disabled={editorDisabled}
                onClick={() => {
                  setDeclineError(null);
                  setDeclineOpen(true);
                }}
              >
                Decline to sign
              </Button>
              <div className="mt-6 flex items-start gap-2 text-[11px] leading-5 text-slate-400">
                <LockKeyhole size={13} className="mt-0.5 shrink-0" />
                Your access and signing activity are recorded in a tamper-evident audit trail.
              </div>
            </fieldset>
          </form>
        </aside>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 px-4 pt-3 shadow-[0_-4px_16px_rgba(15,23,42,0.08)] backdrop-blur lg:hidden dark:border-slate-700 dark:bg-slate-950/95">
        <div className="mx-auto flex max-w-lg items-center gap-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="min-w-0 flex-1 text-xs text-slate-500 dark:text-slate-400">
            <div className="font-medium text-slate-700 dark:text-slate-200">
              {requiredCount ? `${requiredDone} of ${requiredCount} required` : "Ready to finish"}
            </div>
            <div className="truncate">
              {nextRequiredField
                ? nextRequiredField.label || SIGNATURE_FIELD_LABELS[nextRequiredField.type]
                : "Review consent and finish"}
            </div>
          </div>
          <Button
            type="button"
            className="min-h-11"
            disabled={editorDisabled}
            onClick={() =>
              nextRequiredField ? navigateToField(nextRequiredField) : navigateToFinish()
            }
          >
            {nextRequiredField ? "Next required" : "Review & finish"} <ArrowDown size={15} />
          </Button>
        </div>
      </div>

      <SignatureCapture
        open={captureField !== null}
        initials={captureField?.type === "initials"}
        defaultName={data.recipient.name}
        currentValue={
          captureField
            ? (values[captureField.id] ??
              adoptedMarks[captureField.type as "signature" | "initials"])
            : undefined
        }
        disabled={editorDisabled}
        editingLocked={completionIsLocked}
        onEditingChange={handleCaptureEditingChange}
        onClose={() => {
          if (completionLockRef.current) return;
          setCaptureDirty(false);
          setCaptureField(null);
        }}
        onSave={(value) => {
          if (completionLockRef.current || !captureField) return;
          setCaptureDirty(false);
          updateFieldValue(captureField, value);
          setAdoptedMarks((current) => ({ ...current, [captureField.type]: value }));
          setCaptureField(null);
        }}
      />
      <Modal
        open={declineOpen}
        onClose={() => {
          setDeclineOpen(false);
          setDeclineError(null);
        }}
        title="Decline to sign"
      >
        <p className="text-sm leading-6 text-slate-500 dark:text-slate-400">
          The sender will be notified and this envelope will close for you.
        </p>
        <Textarea
          label="Reason"
          value={declineReason}
          onChange={(event) => setDeclineReason(event.target.value)}
          className="mt-4 min-h-28"
          placeholder="Tell the sender why you cannot sign"
        />
        <FormError message={declineError} className="mt-4" />
        <div className="mt-5 flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              setDeclineOpen(false);
              setDeclineError(null);
            }}
          >
            Cancel
          </Button>
          <Button variant="danger" disabled={submitting} onClick={() => void decline()}>
            {submitting && <Spinner size={15} />} Decline envelope
          </Button>
        </div>
      </Modal>
    </PublicShell>
  );
}

function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-full bg-slate-50 text-slate-900 dark:bg-slate-900 dark:text-slate-100">
      <header className="flex h-14 items-center justify-between border-b border-slate-200 bg-white px-4 sm:px-6 dark:border-slate-800 dark:bg-slate-950">
        <Logo className="h-7 w-auto" />
        <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
          <ShieldCheck size={14} /> Secure signing
        </div>
      </header>
      {children}
    </div>
  );
}

function TerminalCard({
  icon,
  title,
  description,
  tone,
  action,
  focusTitle = false,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  tone: "success" | "danger";
  action?: React.ReactNode;
  focusTitle?: boolean;
}) {
  const titleRef = React.useRef<HTMLHeadingElement | null>(null);
  React.useEffect(() => {
    if (focusTitle) titleRef.current?.focus();
  }, [focusTitle]);

  return (
    <div className="mx-auto flex min-h-[75vh] max-w-lg items-center px-5 py-12">
      <div className="w-full rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm dark:border-slate-700 dark:bg-slate-950">
        <span
          className={`mx-auto flex h-12 w-12 items-center justify-center rounded-full ${
            tone === "success"
              ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-300"
              : "bg-rose-100 text-rose-600 dark:bg-rose-950 dark:text-rose-300"
          }`}
        >
          {icon}
        </span>
        <h1
          ref={titleRef}
          tabIndex={focusTitle ? -1 : undefined}
          className="mt-4 text-xl font-semibold text-slate-900 outline-none dark:text-slate-100"
        >
          {title}
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400">{description}</p>
        {action && <div className="mt-6">{action}</div>}
      </div>
    </div>
  );
}

function SigningField({
  field,
  value,
  adoptedValue,
  invalid,
  disabled,
  onChange,
  onCapture,
}: {
  field: SignatureField;
  value: FieldValue | undefined;
  adoptedValue?: string;
  invalid: boolean;
  disabled: boolean;
  onChange: (value: FieldValue) => void;
  onCapture: () => void;
}) {
  const base =
    "h-full w-full border-0 bg-white/95 px-1.5 text-[clamp(8px,1vw,13px)] text-slate-900 outline-none ring-0 focus:bg-indigo-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-600";
  const label = field.label || SIGNATURE_FIELD_LABELS[field.type];
  if (field.type === "signature" || field.type === "initials") {
    const stringValue = typeof value === "string" ? value : "";
    return (
      <button
        id={signingFieldElementId(field.id)}
        type="button"
        disabled={disabled}
        onClick={onCapture}
        aria-label={`${label}${field.required ? ", required" : ", optional"}. ${stringValue ? "Completed; activate to edit" : adoptedValue ? "Use your adopted mark" : "Activate to add"}.`}
        aria-invalid={invalid || undefined}
        className="flex h-full w-full items-center justify-center overflow-hidden bg-white/95 px-1 text-indigo-700 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-600"
      >
        {stringValue ? (
          stringValue.startsWith("data:image/") ? (
            <img
              src={stringValue}
              alt="Captured signature"
              className="max-h-full max-w-full object-contain"
            />
          ) : (
            <span className="truncate font-serif text-[clamp(10px,2vw,24px)] italic">
              {stringValue}
            </span>
          )
        ) : (
          <span className="flex items-center gap-1 text-[clamp(8px,1vw,12px)] font-semibold">
            <PenLine size={12} />
            {adoptedValue
              ? field.type === "initials"
                ? "Use initials"
                : "Use signature"
              : field.type === "initials"
                ? "Add initials"
                : "Add signature"}
          </span>
        )}
      </button>
    );
  }
  if (field.type === "checkbox") {
    return (
      <label className="flex h-full w-full items-center justify-center bg-white/95">
        <input
          id={signingFieldElementId(field.id)}
          type="checkbox"
          disabled={disabled}
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
          aria-label={`${label}${field.required ? ", required" : ", optional"}`}
          aria-required={field.required}
          aria-invalid={invalid || undefined}
          className="h-5 w-5 rounded border-slate-400 text-indigo-600 focus:ring-indigo-500"
        />
      </label>
    );
  }
  if (field.type === "name" || field.type === "email" || field.type === "date") {
    const derivedLabel =
      field.type === "name"
        ? "Recipient name"
        : field.type === "email"
          ? "Recipient email"
          : "Date set when signing finishes";
    return (
      <div
        id={signingFieldElementId(field.id)}
        role="textbox"
        tabIndex={-1}
        aria-label={`${label} — ${derivedLabel}`}
        aria-readonly="true"
        aria-disabled={disabled || undefined}
        title={`${derivedLabel}; Genosyn records this automatically`}
        className="flex h-full w-full items-center overflow-hidden bg-slate-50/95 px-1.5 text-[clamp(8px,1vw,13px)] text-slate-700"
      >
        <LockKeyhole size={10} className="mr-1 shrink-0 text-slate-400" />
        <span className="truncate">
          {field.type === "date" ? derivedLabel : typeof value === "string" ? value : derivedLabel}
        </span>
      </div>
    );
  }
  return (
    <input
      id={signingFieldElementId(field.id)}
      type="text"
      disabled={disabled}
      maxLength={255}
      value={typeof value === "string" ? value : ""}
      onChange={(event) => onChange(event.target.value)}
      placeholder={field.placeholder || SIGNATURE_FIELD_LABELS[field.type]}
      aria-label={`${label}${field.required ? ", required" : ", optional"}`}
      aria-required={field.required}
      aria-invalid={invalid || undefined}
      className={base}
    />
  );
}

function SignatureCapture({
  open,
  initials,
  defaultName,
  currentValue,
  disabled,
  editingLocked,
  onEditingChange,
  onClose,
  onSave,
}: {
  open: boolean;
  initials: boolean;
  defaultName: string;
  currentValue?: FieldValue;
  disabled: boolean;
  editingLocked: () => boolean;
  onEditingChange: (dirty: boolean) => void;
  onClose: () => void;
  onSave: (value: string) => void;
}) {
  const [mode, setMode] = React.useState<"type" | "draw">("type");
  const [typed, setTyped] = React.useState("");
  const [hasInk, setHasInk] = React.useState(false);
  const [draftDrawing, setDraftDrawing] = React.useState("");
  const [typedDirty, setTypedDirty] = React.useState(false);
  const [drawingDirty, setDrawingDirty] = React.useState(false);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const initialTypedRef = React.useRef("");
  const initialDrawingRef = React.useRef("");
  const controlId = React.useId();

  function captureLocked(): boolean {
    return disabled || editingLocked();
  }

  React.useEffect(() => {
    if (!open) return;
    const existing = typeof currentValue === "string" ? currentValue : "";
    const initialTyped =
      existing && !existing.startsWith("data:image/")
        ? existing
        : initials
          ? defaultName
              .split(/\s+/)
              .filter(Boolean)
              .map((part) => part[0])
              .join("")
              .toUpperCase()
          : defaultName;
    const initialDrawing = existing.startsWith("data:image/") ? existing : "";
    initialTypedRef.current = initialTyped;
    initialDrawingRef.current = initialDrawing;
    setTyped(initialTyped);
    setMode(existing.startsWith("data:image/") ? "draw" : "type");
    setDraftDrawing(initialDrawing);
    setHasInk(existing.startsWith("data:image/"));
    setTypedDirty(false);
    setDrawingDirty(false);
    onEditingChange(false);
  }, [currentValue, defaultName, initials, onEditingChange, open]);

  React.useEffect(() => {
    onEditingChange(open && (typedDirty || drawingDirty));
  }, [drawingDirty, onEditingChange, open, typedDirty]);

  React.useEffect(() => {
    if (!open || mode !== "draw") return;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const existing = draftDrawing;
    if (!existing) {
      setHasInk(false);
      return;
    }
    setHasInk(false);
    const image = new Image();
    image.onload = () => {
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      setHasInk(true);
    };
    image.src = existing;
  }, [draftDrawing, mode, open]);

  function clearCanvas() {
    if (captureLocked()) return;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (canvas && context) context.clearRect(0, 0, canvas.width, canvas.height);
    setDraftDrawing("");
    setHasInk(false);
    setDrawingDirty(initialDrawingRef.current.length > 0);
  }

  function closeCapture() {
    if (captureLocked()) return;
    setTypedDirty(false);
    setDrawingDirty(false);
    onEditingChange(false);
    onClose();
  }

  function saveCapture(value: string) {
    if (captureLocked()) return;
    setTypedDirty(false);
    setDrawingDirty(false);
    onEditingChange(false);
    onSave(value);
  }

  return (
    <Modal
      open={open}
      onClose={closeCapture}
      title={initials ? "Add your initials" : "Add your signature"}
      size="lg"
    >
      <div
        role="tablist"
        aria-label={initials ? "Initials method" : "Signature method"}
        className="flex gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800"
      >
        {(["type", "draw"] as const).map((next) => (
          <button
            type="button"
            role="tab"
            key={next}
            id={`${controlId}-${next}-tab`}
            aria-selected={mode === next}
            aria-controls={`${controlId}-${next}-panel`}
            tabIndex={mode === next ? 0 : -1}
            disabled={disabled}
            onClick={() => {
              if (captureLocked()) return;
              if (mode === "draw" && next !== "draw" && hasInk && canvasRef.current) {
                setDraftDrawing(canvasRef.current.toDataURL("image/png"));
              }
              setMode(next);
            }}
            onKeyDown={(event) => {
              if (captureLocked()) return;
              if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
              event.preventDefault();
              const target = next === "type" ? "draw" : "type";
              if (mode === "draw" && target !== "draw" && hasInk && canvasRef.current) {
                setDraftDrawing(canvasRef.current.toDataURL("image/png"));
              }
              setMode(target);
              window.requestAnimationFrame(() => {
                document.getElementById(`${controlId}-${target}-tab`)?.focus();
              });
            }}
            className={`flex-1 rounded-md px-3 py-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
              mode === next
                ? "bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100"
                : "text-slate-500"
            }`}
          >
            {next === "type" ? "Type" : "Draw"}
          </button>
        ))}
      </div>
      {mode === "type" ? (
        <div
          id={`${controlId}-type-panel`}
          role="tabpanel"
          aria-labelledby={`${controlId}-type-tab`}
          className="mt-5"
        >
          <label
            htmlFor={`${controlId}-typed-mark`}
            className="text-sm font-medium text-slate-700 dark:text-slate-300"
          >
            {initials ? "Initials" : "Name"}
          </label>
          <input
            id={`${controlId}-typed-mark`}
            autoFocus
            required
            disabled={disabled}
            maxLength={255}
            value={typed}
            onChange={(event) => {
              if (captureLocked()) return;
              setTyped(event.target.value);
              setTypedDirty(event.target.value !== initialTypedRef.current);
            }}
            className="mt-2 h-16 w-full rounded-xl border border-slate-200 bg-white px-4 font-serif text-3xl italic text-indigo-700 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-950 dark:text-indigo-300"
          />
        </div>
      ) : (
        <div
          id={`${controlId}-draw-panel`}
          role="tabpanel"
          aria-labelledby={`${controlId}-draw-tab`}
          className="mt-5"
        >
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700">
            <canvas
              ref={canvasRef}
              width={900}
              height={260}
              aria-label={`Drawing area for your ${initials ? "initials" : "signature"}. A typed option is also available.`}
              className="h-44 w-full touch-none cursor-crosshair"
              onPointerDown={(event) => {
                if (captureLocked()) return;
                const canvas = event.currentTarget;
                const context = canvas.getContext("2d");
                if (!context) return;
                canvas.setPointerCapture(event.pointerId);
                const rect = canvas.getBoundingClientRect();
                const scaleX = canvas.width / rect.width;
                const scaleY = canvas.height / rect.height;
                context.strokeStyle = "#1e293b";
                context.lineWidth = 4;
                context.lineCap = "round";
                context.lineJoin = "round";
                context.beginPath();
                context.moveTo(
                  (event.clientX - rect.left) * scaleX,
                  (event.clientY - rect.top) * scaleY,
                );
                let moved = false;
                const move = (moveEvent: PointerEvent) => {
                  if (captureLocked()) return;
                  moved = true;
                  context.lineTo(
                    (moveEvent.clientX - rect.left) * scaleX,
                    (moveEvent.clientY - rect.top) * scaleY,
                  );
                  context.stroke();
                  setHasInk(true);
                  setDrawingDirty(true);
                };
                const up = () => {
                  if (moved) setDraftDrawing(canvas.toDataURL("image/png"));
                  canvas.removeEventListener("pointermove", move);
                  canvas.removeEventListener("pointerup", up);
                  canvas.removeEventListener("pointercancel", up);
                };
                canvas.addEventListener("pointermove", move);
                canvas.addEventListener("pointerup", up);
                canvas.addEventListener("pointercancel", up);
              }}
            />
          </div>
          <button
            type="button"
            disabled={disabled}
            onClick={clearCanvas}
            className="mt-2 rounded text-xs font-medium text-slate-500 outline-none hover:text-slate-800 focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            Clear drawing
          </button>
        </div>
      )}
      <p className="mt-4 text-xs leading-5 text-slate-400">
        By selecting Adopt and use, you intend this mark to be your electronic signature.
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" disabled={disabled} onClick={closeCapture}>
          Cancel
        </Button>
        <Button
          type="button"
          disabled={disabled || (mode === "type" ? !typed.trim() : !hasInk)}
          onClick={() => {
            if (mode === "type") saveCapture(typed.trim());
            else if (draftDrawing) saveCapture(draftDrawing);
            else if (canvasRef.current) saveCapture(canvasRef.current.toDataURL("image/png"));
          }}
        >
          Adopt and use
        </Button>
      </div>
    </Modal>
  );
}
