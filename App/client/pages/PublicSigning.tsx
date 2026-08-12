import React from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Download,
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
  formatSignatureDate,
  signatureCalendarDateForOffset,
  type PublicSigningEnvelope,
  type SignatureField,
} from "@/lib/signing";

type FieldValue = string | boolean;
type CompletionResult = { completed: boolean; envelopeId: string; recipientId: string };

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
  const [submitting, setSubmitting] = React.useState(false);
  const [consent, setConsent] = React.useState(false);
  const [completed, setCompleted] = React.useState(false);
  const [captureField, setCaptureField] = React.useState<SignatureField | null>(null);
  const [declineOpen, setDeclineOpen] = React.useState(false);
  const [declineReason, setDeclineReason] = React.useState("");
  const viewSent = React.useRef(false);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api
      .get<unknown>(base)
      .then((response) => {
        if (cancelled) return;
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
        setValues(initial);
        if (!viewSent.current && next.recipient.status !== "completed") {
          viewSent.current = true;
          void api.post(`${base}/view`).catch(() => undefined);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "This signing link is unavailable.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [base]);

  function fieldComplete(field: SignatureField): boolean {
    const value = values[field.id];
    if (field.type === "checkbox") return value === true;
    return typeof value === "string" && value.trim().length > 0;
  }

  async function finish() {
    if (!data) return;
    const firstMissing = data.fields.find((field) => field.required && !fieldComplete(field));
    if (firstMissing) {
      setError(
        `Complete the required ${SIGNATURE_FIELD_LABELS[firstMissing.type].toLowerCase()} field.`,
      );
      return;
    }
    if (!consent) {
      setError("Confirm that you agree to use electronic records and signatures.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.post<CompletionResult>(`${base}/complete`, {
        consent: true,
        timezoneOffsetMinutes: new Date().getTimezoneOffset(),
        timeZone: signerTimeZone(),
        values: data.fields
          .filter((field) => values[field.id] !== undefined)
          .map((field) => {
            const value = values[field.id];
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
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Your signature could not be submitted.");
    } finally {
      setSubmitting(false);
    }
  }

  async function decline() {
    if (!declineReason.trim()) {
      setError("Please provide a reason for declining.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`${base}/decline`, { reason: declineReason.trim() });
      setData((current) =>
        current ? { ...current, recipient: { ...current.recipient, status: "declined" } } : current,
      );
      setDeclineOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The envelope could not be declined.");
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
          action={
            data.envelope.status === "completed" ? (
              <a href={`${base}/completed`} download>
                <Button>
                  <Download size={15} /> Download completed PDF
                </Button>
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
                Prepared for {data.recipient.name}
                {data.envelope.expiresAt
                  ? ` · expires ${formatSignatureDate(data.envelope.expiresAt)}`
                  : ""}
              </p>
            </div>
            <div className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
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
        <main className="min-h-[75vh] bg-slate-200/70 dark:bg-slate-900">
          <PdfCanvasRenderer
            sourceUrl={`${base}/document`}
            fields={data.fields}
            readOnly
            renderField={(field) => (
              <SigningField
                field={field}
                value={values[field.id]}
                onChange={(value) => setValues((current) => ({ ...current, [field.id]: value }))}
                onCapture={() => setCaptureField(field)}
              />
            )}
          />
        </main>
        <aside className="border-t border-slate-200 bg-white p-5 lg:sticky lg:top-0 lg:h-screen lg:border-l lg:border-t-0 dark:border-slate-700 dark:bg-slate-950">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
            <FileSignature size={17} className="text-indigo-600" /> Finish signing
          </div>
          <p className="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400">
            Complete every required field highlighted on the document, then agree and finish.
          </p>

          <div className="mt-5 space-y-2">
            {data.fields.map((field) => (
              <div
                key={field.id}
                className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300"
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
                </span>
                {field.required && <span className="text-rose-500">Required</span>}
              </div>
            ))}
          </div>

          <label className="mt-6 flex items-start gap-3 rounded-xl border border-slate-200 p-3 text-xs leading-5 text-slate-600 dark:border-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
              className="mt-0.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
            />
            <span>
              I agree to use electronic records and signatures, and intend my electronic signature
              to be legally binding.
            </span>
          </label>
          <FormError message={error} className="mt-4" />
          <Button className="mt-4 w-full" disabled={submitting} onClick={() => void finish()}>
            {submitting ? <Spinner size={15} /> : <PenLine size={15} />} Finish signing
          </Button>
          <Button
            className="mt-2 w-full"
            variant="ghost"
            disabled={submitting}
            onClick={() => {
              setError(null);
              setDeclineOpen(true);
            }}
          >
            Decline to sign
          </Button>
          <div className="mt-6 flex items-start gap-2 text-[11px] leading-5 text-slate-400">
            <LockKeyhole size={13} className="mt-0.5 shrink-0" />
            Your access and signing activity are recorded in a tamper-evident audit trail.
          </div>
        </aside>
      </div>

      <SignatureCapture
        open={captureField !== null}
        initials={captureField?.type === "initials"}
        defaultName={data.recipient.name}
        currentValue={captureField ? values[captureField.id] : undefined}
        onClose={() => setCaptureField(null)}
        onSave={(value) => {
          if (captureField) setValues((current) => ({ ...current, [captureField.id]: value }));
          setCaptureField(null);
        }}
      />
      <Modal open={declineOpen} onClose={() => setDeclineOpen(false)} title="Decline to sign">
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
        <FormError message={error} className="mt-4" />
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDeclineOpen(false)}>
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
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  tone: "success" | "danger";
  action?: React.ReactNode;
}) {
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
        <h1 className="mt-4 text-xl font-semibold text-slate-900 dark:text-slate-100">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400">{description}</p>
        {action && <div className="mt-6">{action}</div>}
      </div>
    </div>
  );
}

function SigningField({
  field,
  value,
  onChange,
  onCapture,
}: {
  field: SignatureField;
  value: FieldValue | undefined;
  onChange: (value: FieldValue) => void;
  onCapture: () => void;
}) {
  const base =
    "h-full w-full border-0 bg-white/95 px-1.5 text-[clamp(8px,1vw,13px)] text-slate-900 outline-none ring-0 focus:bg-indigo-50";
  if (field.type === "signature" || field.type === "initials") {
    const stringValue = typeof value === "string" ? value : "";
    return (
      <button
        type="button"
        onClick={onCapture}
        className="flex h-full w-full items-center justify-center overflow-hidden bg-white/95 px-1 text-indigo-700"
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
            <PenLine size={12} /> {field.type === "initials" ? "Add initials" : "Add signature"}
          </span>
        )}
      </button>
    );
  }
  if (field.type === "checkbox") {
    return (
      <label className="flex h-full w-full items-center justify-center bg-white/95">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
          aria-label={field.label || "Checkbox"}
          className="h-4 w-4 rounded border-slate-400 text-indigo-600 focus:ring-indigo-500"
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
        aria-label={`${field.label || SIGNATURE_FIELD_LABELS[field.type]} — ${derivedLabel}`}
        aria-readonly="true"
        title={`${derivedLabel}; Genosyn records this automatically`}
        className="flex h-full w-full items-center overflow-hidden bg-slate-50/95 px-1.5 text-[clamp(8px,1vw,13px)] text-slate-700"
      >
        <LockKeyhole size={10} className="mr-1 shrink-0 text-slate-400" />
        <span className="truncate">{typeof value === "string" ? value : derivedLabel}</span>
      </div>
    );
  }
  return (
    <input
      type="text"
      maxLength={255}
      value={typeof value === "string" ? value : ""}
      onChange={(event) => onChange(event.target.value)}
      placeholder={field.placeholder || SIGNATURE_FIELD_LABELS[field.type]}
      aria-label={field.label || SIGNATURE_FIELD_LABELS[field.type]}
      className={base}
    />
  );
}

function SignatureCapture({
  open,
  initials,
  defaultName,
  currentValue,
  onClose,
  onSave,
}: {
  open: boolean;
  initials: boolean;
  defaultName: string;
  currentValue?: FieldValue;
  onClose: () => void;
  onSave: (value: string) => void;
}) {
  const [mode, setMode] = React.useState<"type" | "draw">("type");
  const [typed, setTyped] = React.useState("");
  const [hasInk, setHasInk] = React.useState(false);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const existing = typeof currentValue === "string" ? currentValue : "";
    setTyped(
      existing && !existing.startsWith("data:image/")
        ? existing
        : initials
          ? defaultName
              .split(/\s+/)
              .filter(Boolean)
              .map((part) => part[0])
              .join("")
              .toUpperCase()
          : defaultName,
    );
    setMode(existing.startsWith("data:image/") ? "draw" : "type");
    setHasInk(false);
  }, [currentValue, defaultName, initials, open]);

  React.useEffect(() => {
    if (!open || mode !== "draw") return;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const existing = typeof currentValue === "string" ? currentValue : "";
    if (!existing.startsWith("data:image/")) {
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
  }, [currentValue, mode, open]);

  function clearCanvas() {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (canvas && context) context.clearRect(0, 0, canvas.width, canvas.height);
    setHasInk(false);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={initials ? "Add your initials" : "Add your signature"}
      size="lg"
    >
      <div className="flex gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
        {(["type", "draw"] as const).map((next) => (
          <button
            key={next}
            onClick={() => setMode(next)}
            className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${
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
        <div className="mt-5">
          <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
            {initials ? "Initials" : "Name"}
          </label>
          <input
            autoFocus
            maxLength={255}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            className="mt-2 h-16 w-full rounded-xl border border-slate-200 bg-white px-4 font-serif text-3xl italic text-indigo-700 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-950 dark:text-indigo-300"
          />
        </div>
      ) : (
        <div className="mt-5">
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700">
            <canvas
              ref={canvasRef}
              width={900}
              height={260}
              className="h-44 w-full touch-none cursor-crosshair"
              onPointerDown={(event) => {
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
                const move = (moveEvent: PointerEvent) => {
                  context.lineTo(
                    (moveEvent.clientX - rect.left) * scaleX,
                    (moveEvent.clientY - rect.top) * scaleY,
                  );
                  context.stroke();
                  setHasInk(true);
                };
                const up = () => {
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
            onClick={clearCanvas}
            className="mt-2 text-xs font-medium text-slate-500 hover:text-slate-800"
          >
            Clear drawing
          </button>
        </div>
      )}
      <p className="mt-4 text-xs leading-5 text-slate-400">
        By selecting Adopt and use, you intend this mark to be your electronic signature.
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={mode === "type" ? !typed.trim() : !hasInk}
          onClick={() => {
            if (mode === "type") onSave(typed.trim());
            else if (canvasRef.current) onSave(canvasRef.current.toDataURL("image/png"));
          }}
        >
          Adopt and use
        </Button>
      </div>
    </Modal>
  );
}
