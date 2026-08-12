import React from "react";
import {
  Bot,
  Calendar,
  CheckSquare,
  ChevronLeft,
  CircleUser,
  Clock3,
  Copy,
  Download,
  FileSignature,
  GripVertical,
  Mail,
  Save,
  Send,
  Trash2,
  UserPlus,
  XCircle,
} from "lucide-react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { useLiveRefetch } from "@/components/CompanySocket";
import { PdfCanvasRenderer } from "@/components/signatures/PdfCanvasRenderer";
import { Button } from "@/components/ui/Button";
import { useDialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormError } from "@/components/ui/FormError";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { Textarea } from "@/components/ui/Textarea";
import { useToast } from "@/components/ui/Toast";
import { api, type Customer, type Employee } from "@/lib/api";
import {
  SIGNATURE_FIELD_LABELS,
  SIGNATURE_STATUS_LABELS,
  clampFieldGeometry,
  defaultFieldSize,
  envelopeFilename,
  formatSignatureDate,
  formatSignatureDateTime,
  normalizeEnvelopeDetail,
  recipientStatusClasses,
  signatureDateInputToEndOfDayIso,
  signatureIsoToDateInput,
  signatureStatusClasses,
  type SignatureEnvelopeDetail,
  type SignatureField,
  type SignatureFieldType,
  type SignatureRecipient,
} from "@/lib/signing";
import type { SignatureOutletContext } from "@/pages/SignatureLayout";

const FIELD_ICONS: Record<SignatureFieldType, React.ReactNode> = {
  signature: <FileSignature size={15} />,
  initials: <GripVertical size={15} />,
  name: <CircleUser size={15} />,
  email: <Mail size={15} />,
  date: <Calendar size={15} />,
  text: <FileSignature size={15} />,
  checkbox: <CheckSquare size={15} />,
};

type DraftRecipient = SignatureRecipient & { id: string };

function freshRecipient(order: number): DraftRecipient {
  return {
    id: `tmp_recipient_${crypto.randomUUID()}`,
    role: "signer",
    name: "",
    email: "",
    routingOrder: order,
    status: "waiting",
    lastDeliveryStatus: "pending",
    lastDeliveryError: "",
    lastDeliveredAt: null,
    reminderCount: 0,
  };
}

function deliveryFeedback(
  recipients: SignatureRecipient[],
  action: "send" | "remind",
): { message: string; kind: "success" | "error" | "info" } {
  const failed = recipients.filter((recipient) => recipient.lastDeliveryStatus === "failed");
  if (failed.length) {
    const details = failed
      .map((recipient) =>
        recipient.lastDeliveryError
          ? `${recipient.name}: ${recipient.lastDeliveryError}`
          : recipient.name,
      )
      .join("; ");
    return {
      message: `${action === "send" ? "Envelope started" : "Reminder created"}, but email delivery failed — ${details}`,
      kind: "error",
    };
  }

  const skipped = recipients.filter((recipient) => recipient.lastDeliveryStatus === "skipped");
  if (skipped.length) {
    const consoleOnly = skipped.every(
      (recipient) =>
        !recipient.lastDeliveryError ||
        recipient.lastDeliveryError.toLowerCase().includes("no email provider"),
    );
    return {
      message: consoleOnly
        ? "No email transport is configured. The private signing link was logged to the server console for development."
        : `${action === "send" ? "Envelope started" : "Reminder created"}, but email delivery was skipped for ${skipped.map((recipient) => recipient.name).join(", ")}.`,
      kind: "info",
    };
  }

  if (
    recipients.length &&
    recipients.every((recipient) => recipient.lastDeliveryStatus === "sent")
  ) {
    return {
      message: action === "send" ? "Signing invitation delivered" : "Reminder delivered",
      kind: "success",
    };
  }

  return {
    message:
      action === "send"
        ? "Envelope started. Invitations will follow the selected signing order."
        : "Reminder queued; delivery has not been confirmed yet.",
    kind: "info",
  };
}

export default function SignatureDetail() {
  const { company } = useOutletContext<SignatureOutletContext>();
  const { envelopeId = "" } = useParams<{ envelopeId: string }>();
  const navigate = useNavigate();
  const dialog = useDialog();
  const { toast } = useToast();
  const [detail, setDetail] = React.useState<SignatureEnvelopeDetail | null>(null);
  const [customers, setCustomers] = React.useState<Customer[]>([]);
  const [recipients, setRecipients] = React.useState<DraftRecipient[]>([]);
  const [fields, setFields] = React.useState<SignatureField[]>([]);
  const [selectedRecipientId, setSelectedRecipientId] = React.useState("");
  const [selectedFieldId, setSelectedFieldId] = React.useState<string | null>(null);
  const [fieldTool, setFieldTool] = React.useState<SignatureFieldType>("signature");
  const [saving, setSaving] = React.useState(false);
  const [acting, setActing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const dirtyRef = React.useRef(false);
  const expectedUpdatedAtRef = React.useRef<string | null>(null);
  const [remoteDraft, setRemoteDraft] = React.useState<SignatureEnvelopeDetail | null>(null);
  const routeBase = `/c/${company.slug}/signatures`;
  const base = `/api/companies/${company.id}/signature-envelopes/${envelopeId}`;

  const applyDetail = React.useCallback((next: SignatureEnvelopeDetail) => {
    setDetail(next);
    setRecipients(next.recipients);
    setFields(next.fields);
    setSelectedRecipientId((current) =>
      next.recipients.some((recipient) => recipient.id === current)
        ? current
        : (next.recipients.find((recipient) => recipient.role === "signer")?.id ?? ""),
    );
    expectedUpdatedAtRef.current = next.envelope.updatedAt;
    dirtyRef.current = false;
    setDirty(false);
    setRemoteDraft(null);
  }, []);

  const load = React.useCallback(
    async (protectUnsaved = false) => {
      setLoadError(null);
      try {
        const next = normalizeEnvelopeDetail(await api.get<unknown>(base));
        if (
          protectUnsaved &&
          dirtyRef.current &&
          expectedUpdatedAtRef.current &&
          next.envelope.updatedAt !== expectedUpdatedAtRef.current
        ) {
          setRemoteDraft(next);
          return;
        }
        if (protectUnsaved && dirtyRef.current) return;
        applyDetail(next);
      } catch (cause) {
        setLoadError(cause instanceof Error ? cause.message : "Could not load the envelope.");
      }
    },
    [applyDetail, base],
  );

  React.useEffect(() => {
    void load();
    void api
      .get<Customer[] | { customers: Customer[] }>(`/api/companies/${company.id}/customers`)
      .then((result) => setCustomers(Array.isArray(result) ? result : result.customers))
      .catch(() => setCustomers([]));
  }, [company.id, load]);
  const refreshFromLiveChange = React.useCallback(() => {
    void load(true);
  }, [load]);
  useLiveRefetch("signature", refreshFromLiveChange, envelopeId);

  const selectedField = fields.find((field) => field.id === selectedFieldId) ?? null;
  const isDraft = detail?.envelope.status === "draft";

  function updateEnvelope(patch: Partial<SignatureEnvelopeDetail["envelope"]>) {
    setDetail((current) =>
      current ? { ...current, envelope: { ...current.envelope, ...patch } } : current,
    );
    dirtyRef.current = true;
    setDirty(true);
  }

  function updateRecipient(id: string, patch: Partial<DraftRecipient>) {
    setRecipients((current) =>
      current.map((recipient) => (recipient.id === id ? { ...recipient, ...patch } : recipient)),
    );
    if (patch.role === "copy") {
      setFields((current) => current.filter((field) => field.recipientId !== id));
      if (selectedField?.recipientId === id) setSelectedFieldId(null);
      if (selectedRecipientId === id) setSelectedRecipientId("");
    }
    dirtyRef.current = true;
    setDirty(true);
  }

  function updateField(id: string, patch: Partial<SignatureField>) {
    setFields((current) =>
      current.map((field) =>
        field.id === id
          ? { ...field, ...patch, ...clampFieldGeometry({ ...field, ...patch }) }
          : field,
      ),
    );
    dirtyRef.current = true;
    setDirty(true);
  }

  function addField(pageNumber: number, x: number, y: number) {
    if (!selectedRecipientId) {
      toast("Choose a signer before placing a field.", "error");
      return;
    }
    const size = defaultFieldSize(fieldTool);
    const geometry = clampFieldGeometry({ x: x - size.width / 2, y: y - size.height / 2, ...size });
    const id = `tmp_field_${crypto.randomUUID()}`;
    setFields((current) => [
      ...current,
      {
        id,
        recipientId: selectedRecipientId,
        type: fieldTool,
        label: SIGNATURE_FIELD_LABELS[fieldTool],
        placeholder: "",
        required: true,
        pageNumber,
        ...geometry,
        sortOrder: current.length,
      },
    ]);
    setSelectedFieldId(id);
    dirtyRef.current = true;
    setDirty(true);
  }

  function draftPayload() {
    if (!detail) return null;
    return {
      title: detail.envelope.title.trim(),
      message: detail.envelope.message.trim(),
      customerId: detail.envelope.customerId || null,
      routingMode: detail.envelope.routingMode,
      expiresAt: detail.envelope.expiresAt,
      expectedUpdatedAt: expectedUpdatedAtRef.current,
      recipients: recipients.map((recipient, index) => ({
        ...(recipient.id.startsWith("tmp_") ? { key: recipient.id } : { id: recipient.id }),
        role: recipient.role,
        name: recipient.name.trim(),
        email: recipient.email.trim(),
        routingOrder: detail.envelope.routingMode === "ordered" ? index : 0,
      })),
      fields: fields.map((field, index) => ({
        ...(field.id.startsWith("tmp_") ? {} : { id: field.id }),
        ...(field.recipientId.startsWith("tmp_")
          ? { recipientKey: field.recipientId }
          : { recipientId: field.recipientId }),
        type: field.type,
        label: field.label,
        placeholder: field.placeholder,
        required: field.required,
        pageNumber: field.pageNumber,
        x: field.x,
        y: field.y,
        width: field.width,
        height: field.height,
        sortOrder: index,
      })),
    };
  }

  async function saveDraft(
    options: { quiet?: boolean } = {},
  ): Promise<SignatureEnvelopeDetail | null> {
    if (!detail) return null;
    const incomplete = recipients.find(
      (recipient) => !recipient.name.trim() || !/^\S+@\S+\.\S+$/.test(recipient.email.trim()),
    );
    if (incomplete) {
      setError("Every recipient needs a name and a valid email address.");
      return null;
    }
    setSaving(true);
    setError(null);
    try {
      const next = normalizeEnvelopeDetail(await api.patch<unknown>(base, draftPayload()));
      applyDetail(next);
      if (!options.quiet) toast("Draft saved", "success");
      return next;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The draft could not be saved.");
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function sendEnvelope() {
    if (!recipients.some((recipient) => recipient.role === "signer")) {
      setError("Add at least one signer before sending.");
      return;
    }
    if (!fields.length) {
      setError("Place at least one signing field before sending.");
      return;
    }
    const saved = dirty ? await saveDraft({ quiet: true }) : detail;
    if (!saved) return;
    if (
      !(await dialog.confirm({
        title: "Send this envelope?",
        message: (
          <span>
            Genosyn will send invitations according to the selected signing order.
            {recipients.some((recipient) => recipient.role === "copy") && (
              <>
                {" "}
                Recipients marked <strong>Completion copy</strong> are emailed only after every
                signer finishes.
              </>
            )}
          </span>
        ),
        confirmLabel: "Send envelope",
      }))
    ) {
      return;
    }
    setActing(true);
    try {
      const result = normalizeEnvelopeDetail(await api.post<unknown>(`${base}/send`));
      setDetail(result);
      setRecipients(result.recipients);
      setFields(result.fields);
      const attempted = result.recipients.filter(
        (recipient) => recipient.role === "signer" && recipient.lastDeliveredAt,
      );
      const feedback = deliveryFeedback(attempted, "send");
      toast(feedback.message, feedback.kind);
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : "The envelope could not be sent.", "error");
    } finally {
      setActing(false);
    }
  }

  async function duplicate() {
    setActing(true);
    try {
      const result = normalizeEnvelopeDetail(await api.post<unknown>(`${base}/duplicate`));
      toast("Draft duplicated", "success");
      navigate(`${routeBase}/${result.envelope.id}`);
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : "Could not duplicate the envelope.", "error");
    } finally {
      setActing(false);
    }
  }

  async function voidEnvelope() {
    const reason = await dialog.prompt({
      title: "Void envelope",
      message: "Recipients will no longer be able to sign it.",
      placeholder: "Reason for voiding",
      confirmLabel: "Void",
      validate: (value) => (value ? null : "Enter a reason."),
    });
    if (!reason) return;
    setActing(true);
    try {
      await api.post(`${base}/void`, { reason });
      toast("Envelope voided", "success");
      await load();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : "Could not void the envelope.", "error");
    } finally {
      setActing(false);
    }
  }

  async function removeEnvelope() {
    if (
      !(await dialog.confirm({
        title: "Delete draft?",
        message: "This permanently removes the document and its fields.",
        confirmLabel: "Delete draft",
        variant: "danger",
      }))
    ) {
      return;
    }
    setActing(true);
    try {
      await api.del(base);
      toast("Draft deleted", "success");
      navigate(routeBase);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The draft could not be deleted.");
    } finally {
      setActing(false);
    }
  }

  async function askAi() {
    try {
      const response = await api.get<unknown>(`/api/companies/${company.id}/signatures/ai-access`);
      const rows = Array.isArray(response)
        ? (response as Array<{ employee?: Employee; grant?: { accessLevel?: string } }>)
        : [];
      const candidate = rows.find(
        (row) => row.employee && ["draft", "send"].includes(row.grant?.accessLevel ?? ""),
      );
      if (!candidate?.employee) {
        await dialog.alert({
          title: "Give an AI employee Draft access first",
          message: (
            <span>
              Open{" "}
              <Link className="text-indigo-600 underline" to={`${routeBase}/ai-access`}>
                AI access
              </Link>{" "}
              and grant Draft or Send access.
            </span>
          ),
        });
        return;
      }
      navigate(`/c/${company.slug}/employees/${candidate.employee.slug}/chat`, {
        state: {
          starterPrompt: `Help me prepare the signature envelope "${detail?.envelope.title}" (${envelopeId}). Review the PDF, recipients, and fields, then explain any changes you recommend before sending.`,
        },
      });
    } catch {
      navigate(`${routeBase}/ai-access`);
    }
  }

  if (!detail && !loadError) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size={24} />
      </div>
    );
  }
  if (!detail || loadError) {
    return (
      <div className="page-shell p-4 sm:p-8">
        <EmptyState
          title="Envelope unavailable"
          description={loadError ?? "This envelope no longer exists."}
          action={<Button onClick={() => void load()}>Try again</Button>}
        />
      </div>
    );
  }

  const envelope = detail.envelope;
  const sourceUrl = `${base}/source`;

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur sm:px-6 dark:border-slate-700 dark:bg-slate-950/95">
        <div className="flex flex-wrap items-center gap-3">
          <Link
            to={routeBase}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
            aria-label="Back to envelopes"
          >
            <ChevronLeft size={19} />
          </Link>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-base font-semibold text-slate-900 dark:text-slate-100">
                {envelope.title}
              </h1>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${signatureStatusClasses(envelope.status)}`}
              >
                {SIGNATURE_STATUS_LABELS[envelope.status]}
              </span>
            </div>
            <div className="mt-0.5 truncate text-xs text-slate-400">
              {envelopeFilename(envelope)} · updated {formatSignatureDate(envelope.updatedAt)}
              {dirty ? " · unsaved changes" : ""}
            </div>
          </div>
          <Button variant="secondary" size="sm" onClick={() => void askAi()}>
            <Bot size={14} /> Ask AI
          </Button>
          {isDraft ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                disabled={saving || !dirty}
                onClick={() => void saveDraft()}
              >
                {saving ? <Spinner size={14} /> : <Save size={14} />} Save
              </Button>
              <Button size="sm" disabled={saving || acting} onClick={() => void sendEnvelope()}>
                {acting ? <Spinner size={14} /> : <Send size={14} />} Send
              </Button>
            </>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              disabled={acting}
              onClick={() => void duplicate()}
            >
              <Copy size={14} /> Duplicate
            </Button>
          )}
        </div>
      </header>

      {isDraft && remoteDraft && (
        <div
          role="alert"
          className="flex flex-col gap-3 border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 sm:flex-row sm:items-center sm:px-6 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100"
        >
          <p className="min-w-0 flex-1">
            {remoteDraft.envelope.status === "draft"
              ? "A newer version of this draft was saved while you were editing. Reload it, or explicitly keep your changes and replace that version on your next save."
              : "This envelope changed state while you were editing. Reload the latest version; draft changes can no longer be saved."}
          </p>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                applyDetail(remoteDraft);
                toast("Latest draft loaded", "success");
              }}
            >
              Reload latest
            </Button>
            {remoteDraft.envelope.status === "draft" && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  expectedUpdatedAtRef.current = remoteDraft.envelope.updatedAt;
                  setRemoteDraft(null);
                  toast("Your local changes will replace the latest draft when saved.", "info");
                }}
              >
                Keep my changes
              </Button>
            )}
          </div>
        </div>
      )}

      {isDraft ? (
        <DraftEditor
          detail={detail}
          customers={customers}
          recipients={recipients}
          fields={fields}
          selectedRecipientId={selectedRecipientId}
          selectedField={selectedField}
          fieldTool={fieldTool}
          sourceUrl={sourceUrl}
          error={error}
          onEnvelopeChange={updateEnvelope}
          onRecipientChange={updateRecipient}
          onRecipientsChange={(next) => {
            setRecipients(next);
            const remainingIds = new Set(next.map((recipient) => recipient.id));
            setFields((current) => current.filter((field) => remainingIds.has(field.recipientId)));
            dirtyRef.current = true;
            setDirty(true);
          }}
          onSelectedRecipientChange={setSelectedRecipientId}
          onFieldToolChange={setFieldTool}
          onAddField={addField}
          onSelectField={setSelectedFieldId}
          onMoveField={(id, position) => updateField(id, position)}
          onFieldChange={updateField}
          onRemoveField={(id) => {
            setFields((current) => current.filter((field) => field.id !== id));
            setSelectedFieldId(null);
            dirtyRef.current = true;
            setDirty(true);
          }}
        />
      ) : (
        <SentEnvelope
          detail={detail}
          sourceUrl={envelope.status === "completed" ? `${base}/completed` : sourceUrl}
          acting={acting}
          onRemind={async (recipient) => {
            setActing(true);
            try {
              const result = normalizeEnvelopeDetail(
                await api.post<unknown>(`${base}/recipients/${recipient.id}/remind`),
              );
              setDetail(result);
              setRecipients(result.recipients);
              setFields(result.fields);
              const refreshed = result.recipients.find((item) => item.id === recipient.id);
              const feedback = deliveryFeedback(refreshed ? [refreshed] : [], "remind");
              toast(feedback.message, feedback.kind);
            } catch (cause) {
              toast(
                cause instanceof Error ? cause.message : "Could not send the reminder.",
                "error",
              );
            } finally {
              setActing(false);
            }
          }}
          onVoid={voidEnvelope}
          completedUrl={`${base}/completed`}
        />
      )}

      {isDraft && (
        <div className="border-t border-slate-200 bg-white px-4 py-3 sm:px-6 dark:border-slate-700 dark:bg-slate-950">
          <div className="flex flex-wrap justify-between gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={acting}
              onClick={() => void removeEnvelope()}
            >
              <Trash2 size={14} /> Delete draft
            </Button>
            <FormError message={error} className="max-w-xl flex-1" />
          </div>
        </div>
      )}
    </div>
  );
}

type DraftEditorProps = {
  detail: SignatureEnvelopeDetail;
  customers: Customer[];
  recipients: DraftRecipient[];
  fields: SignatureField[];
  selectedRecipientId: string;
  selectedField: SignatureField | null;
  fieldTool: SignatureFieldType;
  sourceUrl: string;
  error: string | null;
  onEnvelopeChange: (patch: Partial<SignatureEnvelopeDetail["envelope"]>) => void;
  onRecipientChange: (id: string, patch: Partial<DraftRecipient>) => void;
  onRecipientsChange: (recipients: DraftRecipient[]) => void;
  onSelectedRecipientChange: (id: string) => void;
  onFieldToolChange: (type: SignatureFieldType) => void;
  onAddField: (pageNumber: number, x: number, y: number) => void;
  onSelectField: (id: string) => void;
  onMoveField: (id: string, position: { x: number; y: number }) => void;
  onFieldChange: (id: string, patch: Partial<SignatureField>) => void;
  onRemoveField: (id: string) => void;
};

function DraftEditor(props: DraftEditorProps) {
  const { envelope } = props.detail;
  return (
    <div className="grid min-h-0 min-w-0 flex-1 overflow-x-hidden xl:grid-cols-[15rem_minmax(24rem,1fr)_15rem]">
      <aside className="border-b border-slate-200 bg-white p-4 xl:border-b-0 xl:border-r dark:border-slate-700 dark:bg-slate-950">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Recipients</h2>
        <div className="mt-3 space-y-3">
          {props.recipients.map((recipient, index) => (
            <div
              key={recipient.id}
              className={`rounded-xl border p-3 ${
                props.selectedRecipientId === recipient.id
                  ? "border-indigo-300 bg-indigo-50/50 dark:border-indigo-700 dark:bg-indigo-950/30"
                  : "border-slate-200 dark:border-slate-700"
              }`}
            >
              <button
                type="button"
                onClick={() => props.onSelectedRecipientChange(recipient.id)}
                className="mb-2 flex w-full items-center justify-between text-left text-xs font-semibold text-slate-600 dark:text-slate-300"
              >
                <span>{envelope.routingMode === "ordered" ? `${index + 1}. ` : ""}Recipient</span>
              </button>
              <div className="space-y-2">
                <Input
                  value={recipient.name}
                  onFocus={() => props.onSelectedRecipientChange(recipient.id)}
                  onChange={(event) =>
                    props.onRecipientChange(recipient.id, { name: event.target.value })
                  }
                  placeholder="Full name"
                  aria-label="Recipient name"
                  className="h-9"
                />
                <Input
                  value={recipient.email}
                  type="email"
                  onFocus={() => props.onSelectedRecipientChange(recipient.id)}
                  onChange={(event) =>
                    props.onRecipientChange(recipient.id, { email: event.target.value })
                  }
                  placeholder="name@company.com"
                  aria-label="Recipient email"
                  className="h-9"
                />
                <div className="flex gap-2">
                  <Select
                    value={recipient.role}
                    onChange={(event) =>
                      props.onRecipientChange(recipient.id, {
                        role: event.target.value as "signer" | "copy",
                      })
                    }
                    aria-label="Recipient role"
                    containerClassName="min-w-0 flex-1"
                  >
                    <option value="signer">Signer</option>
                    <option value="copy">Completion copy</option>
                  </Select>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label="Remove recipient"
                    onClick={() => {
                      props.onRecipientsChange(
                        props.recipients.filter((item) => item.id !== recipient.id),
                      );
                      if (props.selectedRecipientId === recipient.id) {
                        props.onSelectedRecipientChange("");
                      }
                    }}
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
                {recipient.role === "copy" && (
                  <p className="text-[11px] leading-4 text-slate-500 dark:text-slate-400">
                    Receives the completed PDF after every signer finishes. No signing invitation is
                    sent.
                  </p>
                )}
              </div>
            </div>
          ))}
          <Button
            variant="secondary"
            size="sm"
            className="w-full"
            onClick={() =>
              props.onRecipientsChange([
                ...props.recipients,
                freshRecipient(props.recipients.length),
              ])
            }
          >
            <UserPlus size={14} /> Add recipient
          </Button>
        </div>

        <div className="mt-6 border-t border-slate-100 pt-5 dark:border-slate-800">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Details</h2>
          <div className="mt-3 space-y-3">
            <Input
              label="Title"
              value={envelope.title}
              onChange={(event) => props.onEnvelopeChange({ title: event.target.value })}
            />
            <Select
              label="Customer"
              value={envelope.customerId ?? ""}
              onChange={(event) =>
                props.onEnvelopeChange({ customerId: event.target.value || null })
              }
            >
              <option value="">No customer</option>
              {props.customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name}
                </option>
              ))}
            </Select>
            <Select
              label="Signing order"
              value={envelope.routingMode}
              onChange={(event) =>
                props.onEnvelopeChange({
                  routingMode: event.target.value as "parallel" | "ordered",
                })
              }
            >
              <option value="parallel">Everyone at once</option>
              <option value="ordered">In a set order</option>
            </Select>
            <Input
              label="Expires"
              type="date"
              value={signatureIsoToDateInput(envelope.expiresAt)}
              onChange={(event) =>
                props.onEnvelopeChange({
                  expiresAt: event.target.value
                    ? signatureDateInputToEndOfDayIso(event.target.value)
                    : null,
                })
              }
            />
            <Textarea
              label="Message"
              value={envelope.message}
              onChange={(event) => props.onEnvelopeChange({ message: event.target.value })}
              className="min-h-20"
            />
          </div>
        </div>
      </aside>

      <main className="min-h-[70vh] min-w-0 overflow-y-auto bg-slate-200/60 dark:bg-slate-900">
        <div className="sticky top-0 z-20 flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white/95 p-3 backdrop-blur dark:border-slate-700 dark:bg-slate-950/95">
          <Select
            aria-label="Assign new fields to"
            value={props.selectedRecipientId}
            onChange={(event) => props.onSelectedRecipientChange(event.target.value)}
            containerClassName="min-w-44"
          >
            <option value="">Choose a signer…</option>
            {props.recipients
              .filter((recipient) => recipient.role === "signer")
              .map((recipient) => (
                <option key={recipient.id} value={recipient.id}>
                  {recipient.name || "Unnamed signer"}
                </option>
              ))}
          </Select>
          <span className="hidden h-6 w-px bg-slate-200 sm:block dark:bg-slate-700" />
          <div className="flex flex-wrap gap-1">
            {(Object.keys(SIGNATURE_FIELD_LABELS) as SignatureFieldType[]).map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => props.onFieldToolChange(type)}
                aria-pressed={props.fieldTool === type}
                aria-label={`Place ${SIGNATURE_FIELD_LABELS[type].toLowerCase()} field`}
                title={`Place ${SIGNATURE_FIELD_LABELS[type].toLowerCase()} field`}
                className={`flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium ${
                  props.fieldTool === type
                    ? "bg-indigo-600 text-white"
                    : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                }`}
              >
                {FIELD_ICONS[type]}{" "}
                <span className="hidden xl:inline">{SIGNATURE_FIELD_LABELS[type]}</span>
              </button>
            ))}
          </div>
          <span className="ml-auto text-xs text-slate-400">Click the PDF to place a field</span>
        </div>
        <PdfCanvasRenderer
          sourceUrl={props.sourceUrl}
          fields={props.fields}
          selectedFieldId={props.selectedField?.id}
          onPageClick={props.onAddField}
          onFieldSelect={props.onSelectField}
          onFieldMove={props.onMoveField}
        />
      </main>

      <aside className="border-t border-slate-200 bg-white p-4 xl:border-l xl:border-t-0 dark:border-slate-700 dark:bg-slate-950">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          Field settings
        </h2>
        {!props.selectedField ? (
          <p className="mt-4 text-sm leading-6 text-slate-500 dark:text-slate-400">
            Select a field on the document to edit it. Drag fields to reposition them.
          </p>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="rounded-lg bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-700 dark:bg-indigo-950 dark:text-indigo-200">
              {SIGNATURE_FIELD_LABELS[props.selectedField.type]}
            </div>
            <Select
              label="Assigned to"
              value={props.selectedField.recipientId}
              onChange={(event) =>
                props.onFieldChange(props.selectedField!.id, { recipientId: event.target.value })
              }
            >
              {props.recipients
                .filter((recipient) => recipient.role === "signer")
                .map((recipient) => (
                  <option key={recipient.id} value={recipient.id}>
                    {recipient.name}
                  </option>
                ))}
            </Select>
            <Input
              label="Label"
              value={props.selectedField.label}
              onChange={(event) =>
                props.onFieldChange(props.selectedField!.id, { label: event.target.value })
              }
            />
            {!["signature", "initials", "checkbox"].includes(props.selectedField.type) && (
              <Input
                label="Placeholder"
                value={props.selectedField.placeholder}
                onChange={(event) =>
                  props.onFieldChange(props.selectedField!.id, { placeholder: event.target.value })
                }
              />
            )}
            <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
              <input
                type="checkbox"
                checked={props.selectedField.required}
                onChange={(event) =>
                  props.onFieldChange(props.selectedField!.id, { required: event.target.checked })
                }
                className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
              />
              Required field
            </label>
            <div className="grid grid-cols-2 gap-2">
              <Input
                label="Width %"
                type="number"
                min="4"
                max="90"
                value={Math.round(props.selectedField.width * 100)}
                onChange={(event) =>
                  props.onFieldChange(props.selectedField!.id, {
                    width: Number(event.target.value) / 100,
                  })
                }
              />
              <Input
                label="Height %"
                type="number"
                min="2.5"
                max="40"
                value={Math.round(props.selectedField.height * 100)}
                onChange={(event) =>
                  props.onFieldChange(props.selectedField!.id, {
                    height: Number(event.target.value) / 100,
                  })
                }
              />
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-rose-600 hover:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-950/30"
              onClick={() => props.onRemoveField(props.selectedField!.id)}
            >
              <Trash2 size={14} /> Remove field
            </Button>
          </div>
        )}
      </aside>
    </div>
  );
}

function SentEnvelope({
  detail,
  sourceUrl,
  completedUrl,
  acting,
  onRemind,
  onVoid,
}: {
  detail: SignatureEnvelopeDetail;
  sourceUrl: string;
  completedUrl: string;
  acting: boolean;
  onRemind: (recipient: SignatureRecipient) => Promise<void>;
  onVoid: () => Promise<void>;
}) {
  const active = ["sent", "in_progress"].includes(detail.envelope.status);
  return (
    <div className="grid min-w-0 flex-1 overflow-x-hidden 2xl:grid-cols-[minmax(0,1fr)_22rem]">
      <main className="min-h-[70vh] min-w-0 overflow-y-auto bg-slate-200/60 dark:bg-slate-900">
        <PdfCanvasRenderer sourceUrl={sourceUrl} fields={detail.fields} readOnly />
      </main>
      <aside className="border-t border-slate-200 bg-white p-5 2xl:border-l 2xl:border-t-0 dark:border-slate-700 dark:bg-slate-950">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Recipients</h2>
          {detail.envelope.status === "completed" && (
            <a href={completedUrl} download>
              <Button variant="secondary" size="sm">
                <Download size={14} /> PDF
              </Button>
            </a>
          )}
        </div>
        <div className="mt-3 space-y-2">
          {detail.recipients.map((recipient, index) => (
            <div
              key={recipient.id}
              className="rounded-xl border border-slate-200 p-3 dark:border-slate-700"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                    {detail.envelope.routingMode === "ordered" ? `${index + 1}. ` : ""}
                    {recipient.name}
                  </div>
                  <div className="truncate text-xs text-slate-400">{recipient.email}</div>
                </div>
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${recipientStatusClasses(recipient.status)}`}
                >
                  {recipient.role === "copy" ? "completion copy" : recipient.status}
                </span>
              </div>
              <RecipientDelivery
                recipient={recipient}
                envelopeCompleted={detail.envelope.status === "completed"}
              />
              {active &&
                ["sent", "viewed"].includes(recipient.status) &&
                recipient.role === "signer" && (
                  <Button
                    className="mt-2"
                    variant="ghost"
                    size="sm"
                    disabled={acting}
                    onClick={() => void onRemind(recipient)}
                  >
                    <Mail size={13} /> Send reminder
                  </Button>
                )}
            </div>
          ))}
        </div>

        <h2 className="mt-7 text-sm font-semibold text-slate-900 dark:text-slate-100">
          Audit trail
        </h2>
        {detail.events.length === 0 ? (
          <p className="mt-3 text-sm text-slate-400">No activity has been recorded yet.</p>
        ) : (
          <ol className="mt-3 space-y-4 border-l border-slate-200 pl-4 dark:border-slate-700">
            {detail.events.map((event) => (
              <li key={event.id} className="relative">
                <span className="absolute -left-[1.28rem] top-1.5 h-2 w-2 rounded-full bg-slate-300 ring-4 ring-white dark:bg-slate-600 dark:ring-slate-950" />
                <div className="text-sm font-medium text-slate-700 dark:text-slate-200">
                  {event.summary || event.type.replaceAll("_", " ")}
                </div>
                {event.detail && <p className="mt-0.5 text-xs text-slate-500">{event.detail}</p>}
                <div className="mt-1 flex items-center gap-1 text-[11px] text-slate-400">
                  <Clock3 size={11} /> {formatSignatureDateTime(event.createdAt)}
                  {event.actorName ? ` · ${event.actorName}` : ""}
                </div>
              </li>
            ))}
          </ol>
        )}

        {active && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-7 w-full text-rose-600 hover:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-950/30"
            disabled={acting}
            onClick={() => void onVoid()}
          >
            <XCircle size={14} /> Void envelope
          </Button>
        )}
      </aside>
    </div>
  );
}

function RecipientDelivery({
  recipient,
  envelopeCompleted,
}: {
  recipient: SignatureRecipient;
  envelopeCompleted: boolean;
}) {
  if (recipient.role === "copy" && !envelopeCompleted) {
    return (
      <p className="mt-2 text-[11px] leading-4 text-slate-500 dark:text-slate-400">
        Receives the completed PDF only after every signer finishes.
      </p>
    );
  }
  const completedDelivery = envelopeCompleted;
  if (recipient.lastDeliveryStatus === "failed") {
    return (
      <p className="mt-2 text-[11px] leading-4 text-rose-600 dark:text-rose-300">
        {completedDelivery ? "Completed PDF delivery failed" : "Delivery failed"}
        {recipient.lastDeliveryError ? `: ${recipient.lastDeliveryError}` : "."}
      </p>
    );
  }
  if (recipient.lastDeliveryStatus === "skipped") {
    return (
      <p className="mt-2 text-[11px] leading-4 text-amber-700 dark:text-amber-300">
        {completedDelivery
          ? "Completed PDF email not delivered because no email transport is configured."
          : "Email not delivered. With no email transport configured, the private link is logged to the server console for development."}
      </p>
    );
  }
  if (recipient.lastDeliveryStatus === "sent") {
    return (
      <p className="mt-2 text-[11px] leading-4 text-emerald-700 dark:text-emerald-300">
        {completedDelivery ? "Completed PDF delivered" : "Email delivered"}
        {recipient.lastDeliveredAt ? ` ${formatSignatureDateTime(recipient.lastDeliveredAt)}` : ""}
      </p>
    );
  }
  return (
    <p className="mt-2 text-[11px] leading-4 text-slate-500 dark:text-slate-400">
      {completedDelivery
        ? "Completed PDF delivery is pending."
        : recipient.status === "waiting"
          ? "Invitation waits for this signer’s turn."
          : "Delivery confirmation is pending."}
    </p>
  );
}
