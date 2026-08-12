import React from "react";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Bot,
  Calendar,
  CheckSquare,
  CheckCircle2,
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
import { useNavigationGuard } from "@/components/NavigationGuard";
import { PdfCanvasRenderer } from "@/components/signatures/PdfCanvasRenderer";
import { Button } from "@/components/ui/Button";
import { useDialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormError } from "@/components/ui/FormError";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
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
  lockSignatureSendReviewForDispatch,
  normalizeEnvelopeDetail,
  reconcileSignatureDraftSave,
  recipientStatusClasses,
  signatureAiHandoffPrompt,
  signatureDateInputToEndOfDayIso,
  signatureRecipientColor,
  signatureRecipientColorKey,
  signatureIsoToDateInput,
  signatureDraftReadiness,
  signatureSendReviewIsCurrent,
  signatureStatusClasses,
  type SignatureEnvelopeDetail,
  type SignatureAccessLevel,
  type SignatureField,
  type SignatureFieldType,
  type SignatureRecipient,
  type SignatureDraftReadinessIssue,
  type SignatureDraftSaveResult,
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
type SigningAiCandidate = { employee: Employee; accessLevel: SignatureAccessLevel };

function recipientColorStyle(recipientId: string): React.CSSProperties {
  return signatureRecipientColor(recipientId).cssVariables as React.CSSProperties;
}

function colorKeyForRecipient(recipient: Pick<SignatureRecipient, "id" | "email">): string {
  return signatureRecipientColorKey(recipient);
}

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
  const navigationGuard = useNavigationGuard();
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
  const [preparingAiHandoff, setPreparingAiHandoff] = React.useState(false);
  const [aiCandidates, setAiCandidates] = React.useState<SigningAiCandidate[]>([]);
  const [selectedAiEmployeeId, setSelectedAiEmployeeId] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const [sendDispatching, setSendDispatching] = React.useState(false);
  const [autosaveError, setAutosaveError] = React.useState<string | null>(null);
  const dirtyRef = React.useRef(false);
  const editRevisionRef = React.useRef(0);
  const autosaveRef = React.useRef<(() => Promise<void>) | null>(null);
  const saveInFlightRef = React.useRef<Promise<SignatureDraftSaveResult | null> | null>(null);
  const saveDraftRef = React.useRef<
    | ((options?: {
        quiet?: boolean;
        autosave?: boolean;
      }) => Promise<SignatureDraftSaveResult | null>)
    | null
  >(null);
  const navigationGuardBusyRef = React.useRef(false);
  const sendReviewBusyRef = React.useRef(false);
  const sendDispatchingRef = React.useRef(false);
  const expectedUpdatedAtRef = React.useRef<string | null>(null);
  const latestSavedDetailRef = React.useRef<SignatureEnvelopeDetail | null>(null);
  const [remoteDraft, setRemoteDraft] = React.useState<SignatureEnvelopeDetail | null>(null);
  const routeBase = `/c/${company.slug}/signatures`;
  const base = `/api/companies/${company.id}/signature-envelopes/${envelopeId}`;
  const routeGenerationRef = React.useRef(0);

  React.useLayoutEffect(() => {
    routeGenerationRef.current += 1;
    saveInFlightRef.current = null;
    navigationGuardBusyRef.current = false;
  }, [base]);

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
    latestSavedDetailRef.current = next;
    dirtyRef.current = false;
    setDirty(false);
    setRemoteDraft(null);
  }, []);

  const load = React.useCallback(
    async (protectUnsaved = false) => {
      const routeGeneration = routeGenerationRef.current;
      setLoadError(null);
      try {
        const next = normalizeEnvelopeDetail(await api.get<unknown>(base));
        if (routeGeneration !== routeGenerationRef.current) return;
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
    setDetail(null);
    setRecipients([]);
    setFields([]);
    setSelectedRecipientId("");
    setSelectedFieldId(null);
    expectedUpdatedAtRef.current = null;
    latestSavedDetailRef.current = null;
    dirtyRef.current = false;
    setDirty(false);
    setRemoteDraft(null);
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
  const readinessIssues = React.useMemo(
    () => (detail ? signatureDraftReadiness(detail.envelope, recipients, fields) : []),
    [detail, fields, recipients],
  );

  React.useEffect(() => {
    if (!dirty && !saving) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, saving]);

  React.useEffect(() => {
    if (!isDraft || !dirty || saving || acting || remoteDraft || autosaveError) return;
    const timer = window.setTimeout(() => void autosaveRef.current?.(), 1_500);
    return () => window.clearTimeout(timer);
  }, [acting, autosaveError, detail, dirty, fields, isDraft, recipients, remoteDraft, saving]);

  function markDirty(): boolean {
    if (sendDispatchingRef.current) return false;
    editRevisionRef.current += 1;
    dirtyRef.current = true;
    setDirty(true);
    setAutosaveError(null);
    return true;
  }

  function mutateDraft(mutation: () => void) {
    if (sendDispatchingRef.current) return;
    mutation();
    markDirty();
  }

  function updateEnvelope(patch: Partial<SignatureEnvelopeDetail["envelope"]>) {
    mutateDraft(() => {
      setDetail((current) =>
        current ? { ...current, envelope: { ...current.envelope, ...patch } } : current,
      );
    });
  }

  function updateRecipient(id: string, patch: Partial<DraftRecipient>) {
    mutateDraft(() => {
      setRecipients((current) =>
        current.map((recipient) => (recipient.id === id ? { ...recipient, ...patch } : recipient)),
      );
      if (patch.role === "copy") {
        setFields((current) => current.filter((field) => field.recipientId !== id));
        if (selectedField?.recipientId === id) setSelectedFieldId(null);
        if (selectedRecipientId === id) setSelectedRecipientId("");
      }
    });
  }

  function updateField(id: string, patch: Partial<SignatureField>) {
    mutateDraft(() => {
      setFields((current) =>
        current.map((field) =>
          field.id === id
            ? { ...field, ...patch, ...clampFieldGeometry({ ...field, ...patch }) }
            : field,
        ),
      );
    });
  }

  function addField(pageNumber: number, x: number, y: number) {
    if (sendDispatchingRef.current) return;
    if (
      !selectedRecipientId ||
      !recipients.some(
        (recipient) => recipient.id === selectedRecipientId && recipient.role === "signer",
      )
    ) {
      toast("Choose a signer before placing a field.", "error");
      return;
    }
    const size = defaultFieldSize(fieldTool);
    const geometry = clampFieldGeometry({ x: x - size.width / 2, y: y - size.height / 2, ...size });
    const id = `tmp_field_${crypto.randomUUID()}`;
    mutateDraft(() => {
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
    });
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
      recipients: recipients.map((recipient) => ({
        ...(recipient.id.startsWith("tmp_") ? { key: recipient.id } : { id: recipient.id }),
        role: recipient.role,
        name: recipient.name.trim(),
        email: recipient.email.trim(),
        routingOrder:
          detail.envelope.routingMode === "ordered" && recipient.role === "signer"
            ? recipients
                .filter((item) => item.role === "signer")
                .findIndex((item) => item.id === recipient.id)
            : 0,
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

  async function persistDraft(
    options: { quiet?: boolean; autosave?: boolean } = {},
  ): Promise<SignatureDraftSaveResult | null> {
    if (!detail) return null;
    const routeGeneration = routeGenerationRef.current;
    const savingRevision = editRevisionRef.current;
    const savingRecipients = recipients;
    const savingFields = fields;
    const savingSelectedRecipientId = selectedRecipientId;
    const savingSelectedFieldId = selectedFieldId;
    setSaving(true);
    if (!options.autosave) setError(null);
    try {
      const next = normalizeEnvelopeDetail(await api.patch<unknown>(base, draftPayload()));
      if (routeGeneration !== routeGenerationRef.current) return null;
      expectedUpdatedAtRef.current = next.envelope.updatedAt;
      latestSavedDetailRef.current = next;
      const currentRevision = editRevisionRef.current;
      const saveIsCurrent = savingRevision === currentRevision;
      setDetail((current) =>
        current
          ? reconcileSignatureDraftSave(current, next, savingRevision, currentRevision).detail
          : next,
      );
      setRemoteDraft(null);
      setAutosaveError(null);
      if (saveIsCurrent) {
        const selectedRecipientIndex = savingRecipients.findIndex(
          (recipient) => recipient.id === savingSelectedRecipientId,
        );
        const selectedFieldIndex = savingFields.findIndex(
          (field) => field.id === savingSelectedFieldId,
        );
        const persistedSelectedRecipient =
          next.recipients.find((recipient) => recipient.id === savingSelectedRecipientId) ??
          next.recipients[selectedRecipientIndex];
        const persistedSelectedField =
          next.fields.find((field) => field.id === savingSelectedFieldId) ??
          next.fields.find((field) => field.sortOrder === selectedFieldIndex);
        setRecipients(next.recipients);
        setFields(next.fields);
        setSelectedRecipientId(persistedSelectedRecipient?.id ?? "");
        setSelectedFieldId(persistedSelectedField?.id ?? null);
        dirtyRef.current = false;
        setDirty(false);
        if (!options.quiet) toast("Draft saved", "success");
      } else if (!options.autosave) {
        toast("Your newest edit is still waiting to save.", "info");
      }
      return { detail: next, current: saveIsCurrent };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "The draft could not be saved.";
      if (options.autosave) setAutosaveError(message);
      else setError(message);
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function saveDraft(
    options: { quiet?: boolean; autosave?: boolean } = {},
  ): Promise<SignatureDraftSaveResult | null> {
    if (saveInFlightRef.current) return saveInFlightRef.current;
    const request = persistDraft(options);
    saveInFlightRef.current = request;
    try {
      return await request;
    } finally {
      if (saveInFlightRef.current === request) saveInFlightRef.current = null;
    }
  }

  saveDraftRef.current = saveDraft;

  async function flushDraftBeforeNavigation(): Promise<boolean> {
    while (dirtyRef.current || saveInFlightRef.current) {
      const result = await saveDraftRef.current?.({ quiet: true });
      if (!result) return false;
      if (result.current && !dirtyRef.current) return true;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
    return true;
  }

  async function leaveDraft(destination: string, onAllowed?: () => void, onCancelled?: () => void) {
    if (navigationGuardBusyRef.current) {
      onCancelled?.();
      return;
    }
    navigationGuardBusyRef.current = true;
    let left = false;
    try {
      if (await flushDraftBeforeNavigation()) {
        left = true;
        if (onAllowed) onAllowed();
        else navigate(destination);
        return;
      }
      if (
        await dialog.confirm({
          title: "Leave with unsaved changes?",
          message: "Your latest changes could not be saved. Leaving now will discard them.",
          confirmLabel: "Discard changes",
          variant: "danger",
        })
      ) {
        left = true;
        if (onAllowed) onAllowed();
        else navigate(destination);
      }
    } finally {
      navigationGuardBusyRef.current = false;
      if (!left) onCancelled?.();
    }
  }

  const leaveDraftRef = React.useRef(leaveDraft);
  leaveDraftRef.current = leaveDraft;

  React.useLayoutEffect(() => {
    if (!isDraft) return;
    return navigationGuard.register(
      (destination, onAllowed, request) => {
        if (!dirtyRef.current && !saveInFlightRef.current) return false;
        if (
          request?.source === "history" &&
          !window.confirm(
            "Leave this draft? Genosyn will finish saving your changes before opening the other page.",
          )
        ) {
          request.cancel();
          return true;
        }
        void leaveDraftRef.current(
          destination,
          onAllowed,
          request?.source === "history" ? request.cancel : undefined,
        );
        return true;
      },
      () => dirtyRef.current || saveInFlightRef.current !== null,
    );
  }, [base, isDraft, navigationGuard]);

  React.useEffect(() => {
    if (!isDraft) return;

    const interceptInternalLink = (event: MouseEvent) => {
      if (!dirtyRef.current && !saveInFlightRef.current) return;
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest<HTMLAnchorElement>("a[href]");
      if (
        !anchor ||
        anchor.hasAttribute("download") ||
        (anchor.target && anchor.target !== "_self")
      ) {
        return;
      }
      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin !== window.location.origin) return;
      if (
        destination.pathname === window.location.pathname &&
        destination.search === window.location.search &&
        destination.hash === window.location.hash
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void leaveDraftRef.current(`${destination.pathname}${destination.search}${destination.hash}`);
    };

    document.addEventListener("click", interceptInternalLink, true);
    return () => {
      document.removeEventListener("click", interceptInternalLink, true);
    };
  }, [isDraft]);

  autosaveRef.current = async () => {
    await saveDraft({ quiet: true, autosave: true });
  };

  async function currentDraftForSend(routeGeneration: number): Promise<{
    detail: SignatureEnvelopeDetail;
    editRevision: number;
  } | null> {
    for (;;) {
      if (routeGeneration !== routeGenerationRef.current) return null;

      let savedDetail = latestSavedDetailRef.current;
      if (dirtyRef.current || saveInFlightRef.current) {
        const saved = await saveDraftRef.current?.({ quiet: true });
        if (!saved || routeGeneration !== routeGenerationRef.current) return null;
        savedDetail = saved.detail;
        if (!saved.current) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
          continue;
        }
      }
      if (!savedDetail) return null;

      const review = {
        detail: savedDetail,
        editRevision: editRevisionRef.current,
      };
      if (
        signatureSendReviewIsCurrent(
          {
            editRevision: review.editRevision,
            updatedAt: review.detail.envelope.updatedAt,
          },
          {
            editRevision: editRevisionRef.current,
            updatedAt: expectedUpdatedAtRef.current,
            dirty: dirtyRef.current,
            saveInFlight: saveInFlightRef.current !== null,
          },
        )
      ) {
        return review;
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
  }

  async function sendEnvelope() {
    if (sendReviewBusyRef.current) return;
    sendReviewBusyRef.current = true;
    const routeGeneration = routeGenerationRef.current;
    setActing(true);
    try {
      for (;;) {
        const reviewed = await currentDraftForSend(routeGeneration);
        if (!reviewed) return;
        const issues = signatureDraftReadiness(
          reviewed.detail.envelope,
          reviewed.detail.recipients,
          reviewed.detail.fields,
        );
        if (issues.length) {
          setError(issues[0].message);
          return;
        }

        const confirmed = await dialog.confirm({
          title: "Send this signature request?",
          message: (
            <span>
              Genosyn will send invitations according to the selected signing order.
              {reviewed.detail.recipients.some((recipient) => recipient.role === "copy") && (
                <>
                  {" "}
                  Recipients marked <strong>Completion copy</strong> are emailed only after every
                  signer finishes.
                </>
              )}
            </span>
          ),
          confirmLabel: "Send request",
        });
        if (!confirmed) return;
        if (routeGeneration !== routeGenerationRef.current) return;

        const reviewIsCurrent = lockSignatureSendReviewForDispatch(
          {
            editRevision: reviewed.editRevision,
            updatedAt: reviewed.detail.envelope.updatedAt,
          },
          {
            editRevision: editRevisionRef.current,
            updatedAt: expectedUpdatedAtRef.current,
            dirty: dirtyRef.current,
            saveInFlight: saveInFlightRef.current !== null,
          },
          () => {
            sendDispatchingRef.current = true;
            setSendDispatching(true);
          },
        );
        if (!reviewIsCurrent) {
          toast(
            "The request changed while you were reviewing it. Review the latest saved version before sending.",
            "info",
          );
          continue;
        }

        const result = normalizeEnvelopeDetail(
          await api.post<unknown>(`${base}/send`, {
            expectedUpdatedAt: reviewed.detail.envelope.updatedAt,
          }),
        );
        if (routeGeneration !== routeGenerationRef.current) return;
        setDetail(result);
        setRecipients(result.recipients);
        setFields(result.fields);
        const attempted = result.recipients.filter(
          (recipient) => recipient.role === "signer" && recipient.lastDeliveredAt,
        );
        const feedback = deliveryFeedback(attempted, "send");
        toast(feedback.message, feedback.kind);
        return;
      }
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : "The request could not be sent.", "error");
    } finally {
      sendDispatchingRef.current = false;
      setSendDispatching(false);
      sendReviewBusyRef.current = false;
      setActing(false);
    }
  }

  async function backToRequests() {
    if (!dirtyRef.current && !saveInFlightRef.current) navigate(routeBase);
    else await leaveDraft(routeBase);
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

  function openAiChat(employee: Employee, current: SignatureEnvelopeDetail = detail!) {
    setAiCandidates([]);
    const destination = `/c/${company.slug}/employees/${employee.slug}/chat`;
    const completeNavigation = () => {
      const savedDetail = latestSavedDetailRef.current ?? current;
      navigate(destination, {
        state: { starterPrompt: signatureAiHandoffPrompt(savedDetail.envelope) },
      });
    };
    if (navigationGuard.request(destination, completeNavigation)) return;
    if (isDraft && (dirtyRef.current || saveInFlightRef.current)) {
      void leaveDraft(destination, completeNavigation);
      return;
    }
    completeNavigation();
  }

  async function askAi() {
    setPreparingAiHandoff(true);
    try {
      const saved =
        isDraft && dirtyRef.current
          ? await saveDraft({ quiet: true })
          : detail
            ? { detail, current: true }
            : null;
      if (!saved?.current) return;
      const response = await api.get<unknown>(`/api/companies/${company.id}/signatures/ai-access`);
      const rows = Array.isArray(response)
        ? (response as Array<{
            employee?: Employee;
            grant?: { accessLevel?: SignatureAccessLevel };
          }>)
        : [];
      const candidates = rows.flatMap((row): SigningAiCandidate[] =>
        row.employee && row.grant?.accessLevel
          ? [{ employee: row.employee, accessLevel: row.grant.accessLevel }]
          : [],
      );
      if (candidates.length === 0) {
        await dialog.alert({
          title: "Give an AI Employee signing access first",
          message: (
            <span>
              Open{" "}
              <Link className="text-indigo-600 underline" to={`${routeBase}/ai-access`}>
                AI access
              </Link>{" "}
              and start with Read only. That is enough to check readiness and status without
              changing anything.
            </span>
          ),
        });
        return;
      }
      if (candidates.length === 1) {
        openAiChat(candidates[0].employee, saved.detail);
        return;
      }
      setAiCandidates(candidates);
      setSelectedAiEmployeeId(candidates[0].employee.id);
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : "Could not open AI help.", "error");
    } finally {
      setPreparingAiHandoff(false);
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
          title="Signature request unavailable"
          description={loadError ?? "This signature request no longer exists."}
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
          <button
            type="button"
            onClick={() => void backToRequests()}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
            aria-label="Back to signature requests"
          >
            <ChevronLeft size={19} />
          </button>
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
            <div className="mt-0.5 truncate text-xs text-slate-400" aria-live="polite">
              {envelopeFilename(envelope)} · updated {formatSignatureDate(envelope.updatedAt)}
              {saving
                ? " · saving…"
                : autosaveError
                  ? " · autosave needs attention"
                  : dirty
                    ? " · saving shortly…"
                    : isDraft
                      ? " · all changes saved"
                      : ""}
            </div>
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={preparingAiHandoff || saving}
            onClick={() => void askAi()}
          >
            {preparingAiHandoff ? <Spinner size={14} /> : <Bot size={14} />} Ask AI
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
              <Button
                size="sm"
                disabled={saving || acting || readinessIssues.length > 0}
                title={readinessIssues[0]?.message}
                onClick={() => void sendEnvelope()}
              >
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
              disabled={sendDispatching}
              onClick={() => {
                if (sendDispatchingRef.current) return;
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
                disabled={sendDispatching}
                onClick={() => {
                  if (sendDispatchingRef.current) return;
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

      {isDraft && autosaveError && (
        <div className="flex flex-wrap items-center gap-3 border-b border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-800 sm:px-6 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200">
          <AlertCircle size={16} className="shrink-0" />
          <span className="min-w-0 flex-1">Autosave paused: {autosaveError}</span>
          <Button
            size="sm"
            variant="secondary"
            disabled={sendDispatching}
            onClick={() => void saveDraft()}
          >
            Try saving again
          </Button>
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
          readinessIssues={readinessIssues}
          editingLocked={sendDispatching}
          onEnvelopeChange={updateEnvelope}
          onRecipientChange={updateRecipient}
          onRecipientsChange={(next) => {
            mutateDraft(() => {
              setRecipients(next);
              const remainingIds = new Set(next.map((recipient) => recipient.id));
              setFields((current) =>
                current.filter((field) => remainingIds.has(field.recipientId)),
              );
            });
          }}
          onMoveRecipient={(id, direction) => {
            mutateDraft(() => {
              setRecipients((current) => {
                const signerIndexes = current
                  .map((recipient, index) => (recipient.role === "signer" ? index : -1))
                  .filter((index) => index >= 0);
                const index = current.findIndex((recipient) => recipient.id === id);
                const signerPosition = signerIndexes.indexOf(index);
                const target = signerIndexes[signerPosition + direction];
                if (index < 0 || target === undefined) return current;
                const next = [...current];
                [next[index], next[target]] = [next[target], next[index]];
                return next;
              });
            });
          }}
          onSelectedRecipientChange={setSelectedRecipientId}
          onFieldToolChange={setFieldTool}
          onAddField={addField}
          onSelectField={setSelectedFieldId}
          onMoveField={(id, position) => updateField(id, position)}
          onFieldChange={updateField}
          onRemoveField={(id) => {
            mutateDraft(() => {
              setFields((current) => current.filter((field) => field.id !== id));
              setSelectedFieldId(null);
            });
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

      <Modal
        open={aiCandidates.length > 1}
        onClose={() => setAiCandidates([])}
        title="Choose an AI Employee"
      >
        <p className="text-sm leading-6 text-slate-600 dark:text-slate-300">
          Choose who should check this request. Chat opens with a draft message for you to review;
          nothing runs until you send it.
        </p>
        <Select
          className="mt-4"
          label="AI Employee"
          value={selectedAiEmployeeId}
          onChange={(event) => setSelectedAiEmployeeId(event.target.value)}
        >
          {aiCandidates.map((candidate) => (
            <option key={candidate.employee.id} value={candidate.employee.id}>
              {candidate.employee.name} · {candidate.employee.role} ·{" "}
              {candidate.accessLevel === "read"
                ? "Read only"
                : candidate.accessLevel === "draft"
                  ? "Prepare drafts"
                  : "Send to customers"}
            </option>
          ))}
        </Select>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setAiCandidates([])}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              const selected = aiCandidates.find(
                (candidate) => candidate.employee.id === selectedAiEmployeeId,
              );
              if (selected) openAiChat(selected.employee);
            }}
          >
            <Bot size={14} /> Open chat
          </Button>
        </div>
      </Modal>
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
  readinessIssues: SignatureDraftReadinessIssue[];
  editingLocked: boolean;
  onEnvelopeChange: (patch: Partial<SignatureEnvelopeDetail["envelope"]>) => void;
  onRecipientChange: (id: string, patch: Partial<DraftRecipient>) => void;
  onRecipientsChange: (recipients: DraftRecipient[]) => void;
  onMoveRecipient: (id: string, direction: -1 | 1) => void;
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
  const editorRootRef = React.useRef<HTMLDivElement>(null);
  const [mobilePanel, setMobilePanel] = React.useState<"people" | "document" | "field">("people");
  const signers = props.recipients.filter((recipient) => recipient.role === "signer");
  function colorForSigner(recipientId: string) {
    const recipient = props.recipients.find((candidate) => candidate.id === recipientId);
    return signatureRecipientColor(recipient ? colorKeyForRecipient(recipient) : recipientId);
  }
  function colorStyleForSigner(recipientId: string) {
    const recipient = props.recipients.find((candidate) => candidate.id === recipientId);
    return recipientColorStyle(recipient ? colorKeyForRecipient(recipient) : recipientId);
  }
  React.useLayoutEffect(() => {
    editorRootRef.current?.toggleAttribute("inert", props.editingLocked);
  }, [props.editingLocked]);
  return (
    <div
      ref={editorRootRef}
      className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden ${
        props.editingLocked ? "pointer-events-none opacity-70" : ""
      }`}
      aria-busy={props.editingLocked}
      aria-disabled={props.editingLocked}
    >
      <div
        className="grid grid-cols-3 border-b border-slate-200 bg-white p-2 xl:hidden dark:border-slate-700 dark:bg-slate-950"
        role="tablist"
        aria-label="Request editor"
      >
        {(
          [
            ["people", `People${props.recipients.length ? ` (${props.recipients.length})` : ""}`],
            ["document", `Document${props.fields.length ? ` (${props.fields.length})` : ""}`],
            ["field", props.selectedField ? "Field settings" : "Send checklist"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mobilePanel === value}
            onClick={() => setMobilePanel(value)}
            className={`rounded-lg px-2 py-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
              mobilePanel === value
                ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-200"
                : "text-slate-500 dark:text-slate-400"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="grid min-h-0 min-w-0 flex-1 xl:grid-cols-[15rem_minmax(24rem,1fr)_15rem]">
        <aside
          className={`${mobilePanel === "people" ? "block" : "hidden"} border-b border-slate-200 bg-white p-4 xl:block xl:border-b-0 xl:border-r dark:border-slate-700 dark:bg-slate-950`}
        >
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Recipients
          </h2>
          <div className="mt-3 space-y-3">
            {props.recipients.map((recipient) => {
              const signerIndex = signers.findIndex((signer) => signer.id === recipient.id);
              return (
                <div
                  key={recipient.id}
                  style={colorStyleForSigner(recipient.id)}
                  className={`rounded-xl border p-3 ${
                    props.selectedRecipientId === recipient.id
                      ? colorForSigner(recipient.id).badgeClassName
                      : "border-slate-200 dark:border-slate-700"
                  }`}
                >
                  <div className="mb-2 flex w-full items-center justify-between text-xs font-semibold text-slate-600 dark:text-slate-300">
                    <button
                      type="button"
                      onClick={() =>
                        props.onSelectedRecipientChange(
                          recipient.role === "signer" ? recipient.id : "",
                        )
                      }
                      className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                    >
                      {signerIndex >= 0 && (
                        <span
                          aria-hidden="true"
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: colorForSigner(recipient.id).dotColor }}
                        />
                      )}
                      <span>
                        {envelope.routingMode === "ordered" && signerIndex >= 0
                          ? `${signerIndex + 1}. Signer`
                          : recipient.role === "copy"
                            ? "Completion copy"
                            : "Signer"}
                      </span>
                    </button>
                    {envelope.routingMode === "ordered" && signerIndex >= 0 && (
                      <span className="flex gap-1">
                        <button
                          type="button"
                          aria-label={`Move ${recipient.name || "signer"} earlier`}
                          disabled={signerIndex === 0}
                          onClick={(event) => {
                            event.stopPropagation();
                            props.onMoveRecipient(recipient.id, -1);
                          }}
                          className="rounded p-1 hover:bg-white disabled:opacity-30 dark:hover:bg-slate-800"
                        >
                          <ArrowUp size={13} />
                        </button>
                        <button
                          type="button"
                          aria-label={`Move ${recipient.name || "signer"} later`}
                          disabled={signerIndex === signers.length - 1}
                          onClick={(event) => {
                            event.stopPropagation();
                            props.onMoveRecipient(recipient.id, 1);
                          }}
                          className="rounded p-1 hover:bg-white disabled:opacity-30 dark:hover:bg-slate-800"
                        >
                          <ArrowDown size={13} />
                        </button>
                      </span>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Input
                      value={recipient.name}
                      onFocus={() => {
                        if (recipient.role === "signer")
                          props.onSelectedRecipientChange(recipient.id);
                      }}
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
                      onFocus={() => {
                        if (recipient.role === "signer")
                          props.onSelectedRecipientChange(recipient.id);
                      }}
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
                        Receives the completed PDF after every signer finishes. No signing
                        invitation is sent.
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
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
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Details
            </h2>
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

        <main
          className={`${mobilePanel === "document" ? "block" : "hidden"} min-h-[70vh] min-w-0 overflow-y-auto bg-slate-200/60 xl:block dark:bg-slate-900`}
        >
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
            <span className="ml-auto text-xs text-slate-400">
              Click to place · drag fields to move · drag the corner to resize
            </span>
            {signers.length > 0 && (
              <div className="flex w-full flex-wrap gap-x-3 gap-y-1 border-t border-slate-100 pt-2 text-[11px] text-slate-500 dark:border-slate-800 dark:text-slate-400">
                {signers.map((recipient, index) => (
                  <span key={recipient.id} className="flex items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: colorForSigner(recipient.id).dotColor }}
                    />
                    {recipient.name || `Signer ${index + 1}`} ·{" "}
                    {props.fields.filter((field) => field.recipientId === recipient.id).length}{" "}
                    fields
                  </span>
                ))}
              </div>
            )}
          </div>
          <PdfCanvasRenderer
            sourceUrl={props.sourceUrl}
            fields={props.fields}
            selectedFieldId={props.selectedField?.id}
            onPageClick={props.onAddField}
            onFieldSelect={(id) => {
              props.onSelectField(id);
            }}
            onFieldMove={props.onMoveField}
            onFieldResize={props.onFieldChange}
            fieldLabel={(field) => {
              const owner = props.recipients.find(
                (recipient) => recipient.id === field.recipientId,
              );
              const signerIndex = signers.findIndex(
                (recipient) => recipient.id === field.recipientId,
              );
              return `${owner?.name || `Signer ${signerIndex + 1}`} · ${field.label || SIGNATURE_FIELD_LABELS[field.type]}`;
            }}
            fieldClassName={(field, selected) => {
              const color = colorForSigner(field.recipientId);
              return `${color.fieldClassName} ${selected ? color.selectedClassName : ""}`;
            }}
            fieldStyle={(field) => colorStyleForSigner(field.recipientId)}
          />
        </main>

        <aside
          className={`${mobilePanel === "field" ? "block" : "hidden"} border-t border-slate-200 bg-white p-4 xl:block xl:border-l xl:border-t-0 dark:border-slate-700 dark:bg-slate-950`}
        >
          <SendReadiness issues={props.readinessIssues} />
          <div className="mt-5 border-t border-slate-100 pt-5 dark:border-slate-800">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Field settings
            </h2>
            {!props.selectedField ? (
              <p className="mt-4 text-sm leading-6 text-slate-500 dark:text-slate-400">
                Select a field on the document to edit it. Drag the field to move it, or drag its
                bottom-right handle to resize it.
              </p>
            ) : (
              <div className="mt-4 space-y-4">
                <div
                  style={colorStyleForSigner(props.selectedField.recipientId)}
                  className={`rounded-lg border px-3 py-2 text-sm font-medium ${colorForSigner(props.selectedField.recipientId).badgeClassName}`}
                >
                  {props.recipients.find(
                    (recipient) => recipient.id === props.selectedField!.recipientId,
                  )?.name || "Signer"}{" "}
                  · {SIGNATURE_FIELD_LABELS[props.selectedField.type]}
                </div>
                <Select
                  label="Assigned to"
                  value={props.selectedField.recipientId}
                  onChange={(event) =>
                    props.onFieldChange(props.selectedField!.id, {
                      recipientId: event.target.value,
                    })
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
                      props.onFieldChange(props.selectedField!.id, {
                        placeholder: event.target.value,
                      })
                    }
                  />
                )}
                <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={props.selectedField.required}
                    onChange={(event) =>
                      props.onFieldChange(props.selectedField!.id, {
                        required: event.target.checked,
                      })
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
          </div>
        </aside>
      </div>
    </div>
  );
}

function SendReadiness({ issues }: { issues: SignatureDraftReadinessIssue[] }) {
  return (
    <div id="signature-readiness" aria-live="polite">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
        {issues.length ? (
          <AlertCircle size={14} className="text-amber-500" />
        ) : (
          <CheckCircle2 size={14} className="text-emerald-500" />
        )}
        Ready to send
      </div>
      {issues.length ? (
        <div className="mt-3 space-y-2">
          {issues.map((issue, index) => (
            <div
              key={`${issue.code}-${issue.recipientId ?? "request"}-${index}`}
              className="flex gap-2 text-xs leading-5 text-slate-600 dark:text-slate-300"
            >
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
              {issue.message}
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-xs leading-5 text-emerald-700 dark:text-emerald-300">
          People, contact details, and required signatures are ready for review.
        </p>
      )}
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
  function signerColor(recipientId: string) {
    const recipient = detail.recipients.find((candidate) => candidate.id === recipientId);
    return signatureRecipientColor(recipient ? colorKeyForRecipient(recipient) : recipientId);
  }
  function signerColorStyle(recipientId: string) {
    const recipient = detail.recipients.find((candidate) => candidate.id === recipientId);
    return recipientColorStyle(recipient ? colorKeyForRecipient(recipient) : recipientId);
  }
  return (
    <div className="grid min-w-0 flex-1 overflow-x-hidden 2xl:grid-cols-[minmax(0,1fr)_22rem]">
      <main className="min-h-[70vh] min-w-0 overflow-y-auto bg-slate-200/60 dark:bg-slate-900">
        <PdfCanvasRenderer
          sourceUrl={sourceUrl}
          fields={detail.fields}
          readOnly
          fieldLabel={(field) => {
            const owner = detail.recipients.find((recipient) => recipient.id === field.recipientId);
            return `${owner?.name || "Signer"} · ${field.label || SIGNATURE_FIELD_LABELS[field.type]}`;
          }}
          fieldClassName={(field) => signerColor(field.recipientId).fieldClassName}
          fieldStyle={(field) => signerColorStyle(field.recipientId)}
        />
      </main>
      <aside className="border-t border-slate-200 bg-white p-5 2xl:border-l 2xl:border-t-0 dark:border-slate-700 dark:bg-slate-950">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Recipients</h2>
          {detail.envelope.status === "completed" && (
            <a
              href={completedUrl}
              download
              className="inline-flex h-8 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-900 transition hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
            >
              <Download size={14} /> PDF
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
                  <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-slate-900 dark:text-slate-100">
                    {recipient.role === "signer" && (
                      <span
                        aria-hidden="true"
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: signerColor(recipient.id).dotColor }}
                      />
                    )}
                    <span className="truncate">
                      {detail.envelope.routingMode === "ordered" ? `${index + 1}. ` : ""}
                      {recipient.name}
                    </span>
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
            <XCircle size={14} /> Void request
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
