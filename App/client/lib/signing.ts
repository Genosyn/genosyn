/**
 * Shared client model for Signatures. Coordinates are stored as fractions of
 * the PDF page, which keeps fields in the same place at every zoom level and
 * on phones as well as desktop.
 */

export type SignatureEnvelopeStatus =
  | "draft"
  | "sent"
  | "in_progress"
  | "completed"
  | "declined"
  | "voided"
  | "expired";

export type SignatureRoutingMode = "parallel" | "ordered";
export type SignatureRecipientStatus = "waiting" | "sent" | "viewed" | "completed" | "declined";
export type SignatureDeliveryStatus = "pending" | "sent" | "skipped" | "failed";
export type SignatureFieldType =
  | "signature"
  | "initials"
  | "name"
  | "email"
  | "date"
  | "text"
  | "checkbox";
export type SignatureAccessLevel = "read" | "draft" | "send";

export type SignatureEnvelope = {
  id: string;
  companyId: string;
  customerId: string | null;
  title: string;
  originalFilename: string;
  originalMimeType: string;
  originalSizeBytes: number;
  originalPageCount: number;
  originalSha256?: string;
  completedSha256?: string | null;
  completedSizeBytes?: number | null;
  customerContractId?: string | null;
  /** Tolerated display aliases from older serializers. */
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
  status: SignatureEnvelopeStatus;
  message: string;
  routingMode: SignatureRoutingMode;
  expiresAt: string | null;
  sentAt: string | null;
  completedAt: string | null;
  declinedAt?: string | null;
  voidedAt?: string | null;
  voidReason?: string;
  createdAt: string;
  updatedAt: string;
  recipientCount?: number;
  completedRecipientCount?: number;
  customer?: { id: string; name: string; slug?: string } | null;
};

export type SignatureRecipient = {
  id: string;
  envelopeId?: string;
  role: "signer" | "copy";
  name: string;
  email: string;
  routingOrder: number;
  status: SignatureRecipientStatus;
  lastDeliveryStatus: SignatureDeliveryStatus;
  lastDeliveryError: string;
  lastDeliveredAt: string | null;
  reminderCount: number;
  sentAt?: string | null;
  viewedAt?: string | null;
  completedAt?: string | null;
  declinedAt?: string | null;
  declineReason?: string;
};

export type SignatureField = {
  id: string;
  envelopeId?: string;
  recipientId: string;
  type: SignatureFieldType;
  label: string;
  placeholder: string;
  required: boolean;
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  sortOrder: number;
  value?: string | boolean | null;
};

export type SignatureEvent = {
  id: string;
  type: string;
  summary?: string;
  detail?: string;
  actorName?: string | null;
  recipientId?: string | null;
  ipAddress?: string | null;
  createdAt: string;
};

export type SignatureEnvelopeDetail = {
  envelope: SignatureEnvelope;
  recipients: SignatureRecipient[];
  fields: SignatureField[];
  events: SignatureEvent[];
  customer: { id: string; name: string; slug?: string } | null;
};

export type PublicSigningEnvelope = {
  envelope: Pick<
    SignatureEnvelope,
    "id" | "title" | "message" | "status" | "expiresAt" | "completedAt"
  > & {
    companyName?: string;
    filename?: string;
    originalPageCount?: number;
    finalizationPending?: boolean;
  };
  recipient: Pick<SignatureRecipient, "id" | "role" | "name" | "email" | "status">;
  fields: SignatureField[];
  sender?: { companyName: string } | null;
};

export type SignatureGrant = {
  id: string;
  employeeId: string;
  accessLevel: SignatureAccessLevel;
  employee?: {
    id: string;
    name: string;
    slug: string;
    role: string;
    avatarKey?: string | null;
  } | null;
};

export type SignatureDraftReadinessIssue = {
  code: "title" | "signer" | "recipient" | "duplicate_email" | "signature" | "expiry";
  message: string;
  recipientId?: string;
  /** Which recipient input the issue is about, so the checklist can focus it. */
  input?: "name" | "email";
};

export type SignatureDraftSaveResult = {
  detail: SignatureEnvelopeDetail;
  current: boolean;
};

export type SignatureSendReview = {
  editRevision: number;
  updatedAt: string;
};

/** A send approval is valid only for the exact draft revision the Member reviewed. */
export function signatureSendReviewIsCurrent(
  reviewed: SignatureSendReview,
  current: {
    editRevision: number;
    updatedAt: string | null;
    dirty: boolean;
    saveInFlight: boolean;
  },
): boolean {
  return (
    !current.dirty &&
    !current.saveInFlight &&
    reviewed.editRevision === current.editRevision &&
    reviewed.updatedAt === current.updatedAt
  );
}

/** Freeze draft mutations synchronously before dispatching an approved send. */
export function lockSignatureSendReviewForDispatch(
  reviewed: SignatureSendReview,
  current: Parameters<typeof signatureSendReviewIsCurrent>[1],
  freeze: () => void,
): boolean {
  if (!signatureSendReviewIsCurrent(reviewed, current)) return false;
  freeze();
  return true;
}

/**
 * Reconcile a draft response without allowing an older in-flight save to
 * replace edits the Member made while that request was running.
 */
export function reconcileSignatureDraftSave(
  current: SignatureEnvelopeDetail,
  saved: SignatureEnvelopeDetail,
  savingRevision: number,
  currentRevision: number,
): SignatureDraftSaveResult {
  if (savingRevision === currentRevision) {
    return { detail: saved, current: true };
  }

  const localEnvelope = current.envelope;
  return {
    current: false,
    detail: {
      ...current,
      envelope: {
        ...saved.envelope,
        title: localEnvelope.title,
        message: localEnvelope.message,
        customerId: localEnvelope.customerId,
        routingMode: localEnvelope.routingMode,
        expiresAt: localEnvelope.expiresAt,
      },
      events: saved.events,
      customer:
        localEnvelope.customerId === saved.envelope.customerId ? saved.customer : current.customer,
    },
  };
}

export const SIGNATURE_FIELD_LABELS: Record<SignatureFieldType, string> = {
  signature: "Signature",
  initials: "Initials",
  name: "Full name",
  email: "Email",
  date: "Date signed",
  text: "Text",
  checkbox: "Checkbox",
};

export type SignatureRecipientColor = {
  dotColor: string;
  cssVariables: Record<`--signature-${string}`, string>;
  fieldClassName: string;
  selectedClassName: string;
  badgeClassName: string;
};

/** Use an address across recipient row replacement; fall back while it is incomplete. */
export function signatureRecipientColorKey(
  recipient: Pick<SignatureRecipient, "id" | "email">,
): string {
  return normalizeSignatureEmail(recipient.email) ?? recipient.id;
}

/**
 * Derive a stable, high-cardinality signer color from recipient identity.
 * Recipient names and field labels remain the primary ownership cue.
 */
export function signatureRecipientColor(recipientId: string): SignatureRecipientColor {
  let hash = 0x811c9dc5;
  for (let index = 0; index < recipientId.length; index += 1) {
    hash ^= recipientId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  const hue = ((hash >>> 0) / 0x1_0000_0000) * 360;
  const hsl = (saturation: number, lightness: number, alpha = 1) =>
    `hsl(${hue.toFixed(3)} ${saturation}% ${lightness}%${alpha < 1 ? ` / ${alpha}` : ""})`;
  return {
    dotColor: hsl(72, 45),
    cssVariables: {
      "--signature-field-border": hsl(68, 42),
      "--signature-field-background": hsl(85, 96, 0.95),
      "--signature-field-text": hsl(62, 25),
      "--signature-field-border-dark": hsl(72, 64),
      "--signature-field-background-dark": hsl(68, 15, 0.9),
      "--signature-field-text-dark": hsl(72, 88),
      "--signature-field-ring": hsl(72, 48, 0.42),
    },
    fieldClassName:
      "!border-[var(--signature-field-border)] !bg-[var(--signature-field-background)] !text-[var(--signature-field-text)] dark:!border-[var(--signature-field-border-dark)] dark:!bg-[var(--signature-field-background-dark)] dark:!text-[var(--signature-field-text-dark)]",
    selectedClassName: "!ring-[var(--signature-field-ring)]",
    badgeClassName:
      "border-[var(--signature-field-border)] bg-[var(--signature-field-background)] text-[var(--signature-field-text)] dark:border-[var(--signature-field-border-dark)] dark:bg-[var(--signature-field-background-dark)] dark:text-[var(--signature-field-text-dark)]",
  };
}

export const SIGNATURE_STATUS_LABELS: Record<SignatureEnvelopeStatus, string> = {
  draft: "Draft",
  sent: "Waiting",
  in_progress: "In progress",
  completed: "Completed",
  declined: "Declined",
  voided: "Voided",
  expired: "Expired",
};

/** Keep sender guidance aligned with the service's pragmatic mailbox rules. */
export function normalizeSignatureEmail(input: string): string | null {
  const value = input.trim().toLowerCase();
  const address = /^[^\s<>(),;:\\"[\]@]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
  if (!address.test(value)) return null;
  const [local] = value.split("@");
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  return value;
}

/**
 * Honest handoff text for the request-level Ask AI action. Signing tools expose
 * saved configuration and evidence, not the source PDF bytes or a mutation
 * endpoint for an existing draft.
 */
export function signatureAiHandoffPrompt(
  envelope: Pick<SignatureEnvelope, "id" | "title" | "status">,
): string {
  if (envelope.status === "draft") {
    return `Check whether the saved setup of signature envelope "${envelope.title}" (${envelope.id}) is ready for a Member to send. Inspect its recipients, signer and completion-copy roles, routing order, expiry, and required fields using your signing tools. List anything a Member should verify or fix in the signing editor. You cannot read the source PDF contents or edit this existing draft through signing tools, so say that plainly and do not claim otherwise. Do not send, remind, or void anything unless I explicitly ask in a follow-up.`;
  }
  return `Summarize the current status of signature envelope "${envelope.title}" (${envelope.id}). Inspect recipient progress, routing, delivery state, and the evidence trail using your signing tools. Highlight failures or sensible next steps. Do not send a reminder or void the request unless I explicitly ask in a follow-up, and never claim to have seen private signing links or signature values.`;
}

export function signatureStatusClasses(status: SignatureEnvelopeStatus): string {
  if (status === "completed") {
    return "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300";
  }
  if (status === "sent" || status === "in_progress") {
    return "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300";
  }
  if (status === "declined" || status === "voided" || status === "expired") {
    return "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300";
  }
  return "bg-slate-100 text-slate-700 dark:bg-slate-700/40 dark:text-slate-200";
}

export function recipientStatusClasses(status: SignatureRecipientStatus): string {
  if (status === "completed") {
    return "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300";
  }
  if (status === "viewed") {
    return "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300";
  }
  if (status === "sent") {
    return "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300";
  }
  if (status === "declined") {
    return "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300";
  }
  return "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300";
}

export function formatSignatureDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatSignatureDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Convert a date control value to the end of that day in the Member's timezone. */
export function signatureDateInputToEndOfDayIso(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, monthIndex, day, 23, 59, 59, 999);
  if (date.getFullYear() !== year || date.getMonth() !== monthIndex || date.getDate() !== day) {
    return null;
  }
  return date.toISOString();
}

/** Format an instant for a date control without shifting it to its UTC calendar day. */
export function signatureIsoToDateInput(value: string | null | undefined): string {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Calendar date at the browser-reported UTC-minus-local offset. */
export function signatureCalendarDateForOffset(date: Date, timezoneOffsetMinutes: number): string {
  if (!Number.isFinite(date.getTime()) || !Number.isInteger(timezoneOffsetMinutes)) return "";
  return new Date(date.getTime() - timezoneOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

/** A completed signer may resume only an all-signed, interrupted finalization saga. */
export function canRetryPublicSignatureFinalization(value: PublicSigningEnvelope): boolean {
  return (
    value.recipient.status === "completed" &&
    value.envelope.status === "in_progress" &&
    value.envelope.finalizationPending === true
  );
}

/** A completion response may fail after the recipient's evidence was durably saved. */
export function publicSignatureRecipientIsComplete(value: PublicSigningEnvelope): boolean {
  return value.recipient.status === "completed";
}

/** Required-field completion shared by the signer progress and navigation UI. */
export function signatureFieldValueIsComplete(field: SignatureField, value: unknown): boolean {
  if (field.type === "checkbox") return value === true;
  return typeof value === "string" && value.trim().length > 0;
}

export function firstIncompleteRequiredSignatureField(
  fields: SignatureField[],
  values: Record<string, unknown>,
): SignatureField | undefined {
  return fields.find(
    (field) => field.required && !signatureFieldValueIsComplete(field, values[field.id]),
  );
}

export type SignatureCompletionProgress = { done: number; total: number; percent: number };

/**
 * How far through the required fields a signer is. A request with no required
 * fields reads as complete rather than as an empty bar, because there is
 * genuinely nothing left for the signer to fill in.
 */
export function signatureCompletionProgress(
  fields: SignatureField[],
  values: Record<string, unknown>,
): SignatureCompletionProgress {
  const required = fields.filter((field) => field.required);
  const done = required.filter((field) =>
    signatureFieldValueIsComplete(field, values[field.id]),
  ).length;
  return {
    done,
    total: required.length,
    percent: required.length ? Math.round((done / required.length) * 100) : 100,
  };
}

export function recipientProgress(envelope: SignatureEnvelope): { done: number; total: number } {
  return {
    done: Number(envelope.completedRecipientCount ?? 0),
    total: Number(envelope.recipientCount ?? 0),
  };
}

/** Sender-side guidance only; the service repeats these checks under the send lock. */
export function signatureDraftReadiness(
  envelope: Pick<SignatureEnvelope, "title" | "expiresAt">,
  recipients: SignatureRecipient[],
  fields: SignatureField[],
  now = new Date(),
): SignatureDraftReadinessIssue[] {
  const issues: SignatureDraftReadinessIssue[] = [];
  if (!envelope.title.trim()) {
    issues.push({ code: "title", message: "Add a request title" });
  }
  const signers = recipients.filter((recipient) => recipient.role === "signer");
  if (!signers.length) {
    issues.push({ code: "signer", message: "Add at least one signer" });
  }
  const emails = new Map<string, string>();
  recipients.forEach((recipient, index) => {
    const label = recipient.name.trim() || `Recipient ${index + 1}`;
    if (!recipient.name.trim()) {
      issues.push({
        code: "recipient",
        recipientId: recipient.id,
        input: "name",
        message: `${label} needs a name`,
      });
    }
    const email = normalizeSignatureEmail(recipient.email);
    if (!email) {
      issues.push({
        code: "recipient",
        recipientId: recipient.id,
        input: "email",
        message: `${label} needs a valid email`,
      });
    } else if (emails.has(email)) {
      issues.push({
        code: "duplicate_email",
        recipientId: recipient.id,
        input: "email",
        message: `${label} has the same email as ${emails.get(email)}`,
      });
    } else {
      emails.set(email, label);
    }
  });
  signers.forEach((recipient) => {
    if (
      !fields.some(
        (field) =>
          field.recipientId === recipient.id && field.type === "signature" && field.required,
      )
    ) {
      issues.push({
        code: "signature",
        recipientId: recipient.id,
        message: `${recipient.name.trim() || "Each signer"} needs a required signature field`,
      });
    }
  });
  if (envelope.expiresAt) {
    const expiresAt = new Date(envelope.expiresAt);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
      issues.push({ code: "expiry", message: "Choose a future expiry date" });
    }
  }
  return issues;
}

export const SIGNATURE_FIELD_MIN_WIDTH = 0.04;
export const SIGNATURE_FIELD_MIN_HEIGHT = 0.025;
export const SIGNATURE_FIELD_MAX_WIDTH = 0.9;
export const SIGNATURE_FIELD_MAX_HEIGHT = 0.4;

export type SignatureFieldGeometry = Pick<SignatureField, "x" | "y" | "width" | "height">;
export type SignatureFieldResizeHandle = "north-west" | "north-east" | "south-west" | "south-east";
export type SignatureFieldResizeHandlePosition = { left: number; top: number };

function finiteNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampNumber(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function clampFieldGeometry(
  patch: Partial<Pick<SignatureField, "x" | "y" | "width" | "height">>,
): SignatureFieldGeometry {
  const width = clampNumber(
    finiteNumber(patch.width, 0.28),
    SIGNATURE_FIELD_MIN_WIDTH,
    SIGNATURE_FIELD_MAX_WIDTH,
  );
  const height = clampNumber(
    finiteNumber(patch.height, 0.07),
    SIGNATURE_FIELD_MIN_HEIGHT,
    SIGNATURE_FIELD_MAX_HEIGHT,
  );
  return {
    width,
    height,
    x: clampNumber(finiteNumber(patch.x, 0.08), 0, 1 - width),
    y: clampNumber(finiteNumber(patch.y, 0.08), 0, 1 - height),
  };
}

/** Resize one corner while keeping the opposite corner anchored to the page. */
export function resizeSignatureFieldGeometry(
  geometry: SignatureFieldGeometry,
  handle: SignatureFieldResizeHandle,
  pointer: Pick<SignatureFieldGeometry, "x" | "y">,
): SignatureFieldGeometry {
  const current = clampFieldGeometry(geometry);
  let left = current.x;
  let top = current.y;
  let right = current.x + current.width;
  let bottom = current.y + current.height;
  const pointerX = clampNumber(finiteNumber(pointer.x, right), 0, 1);
  const pointerY = clampNumber(finiteNumber(pointer.y, bottom), 0, 1);

  if (handle.endsWith("west")) {
    left = clampNumber(
      pointerX,
      Math.max(0, right - SIGNATURE_FIELD_MAX_WIDTH),
      right - SIGNATURE_FIELD_MIN_WIDTH,
    );
  } else {
    right = clampNumber(
      pointerX,
      left + SIGNATURE_FIELD_MIN_WIDTH,
      Math.min(1, left + SIGNATURE_FIELD_MAX_WIDTH),
    );
  }

  if (handle.startsWith("north")) {
    top = clampNumber(
      pointerY,
      Math.max(0, bottom - SIGNATURE_FIELD_MAX_HEIGHT),
      bottom - SIGNATURE_FIELD_MIN_HEIGHT,
    );
  } else {
    bottom = clampNumber(
      pointerY,
      top + SIGNATURE_FIELD_MIN_HEIGHT,
      Math.min(1, top + SIGNATURE_FIELD_MAX_HEIGHT),
    );
  }

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

/**
 * Keep the full touch target on the page and beside the selected field when
 * space allows, preserving a separate moving surface even for tiny fields.
 */
export function signatureFieldResizeHandlePosition(
  geometry: SignatureFieldGeometry,
  page: { width: number; height: number },
  handleSize = 44,
): SignatureFieldResizeHandlePosition {
  const field = clampFieldGeometry(geometry);
  const pageWidth = Math.max(handleSize, finiteNumber(page.width, handleSize));
  const pageHeight = Math.max(handleSize, finiteNumber(page.height, handleSize));
  const fieldLeft = field.x * pageWidth;
  const fieldRight = (field.x + field.width) * pageWidth;
  const fieldBottom = (field.y + field.height) * pageHeight;
  let left: number;
  if (pageWidth - fieldRight >= handleSize) left = fieldRight;
  else if (fieldLeft >= handleSize) left = fieldLeft - handleSize;
  else left = clampNumber(fieldRight - handleSize / 4, 0, pageWidth - handleSize);
  return {
    left,
    top: clampNumber(fieldBottom - handleSize / 4, 0, pageHeight - handleSize),
  };
}

export function defaultFieldSize(type: SignatureFieldType): { width: number; height: number } {
  if (type === "checkbox") return { width: 0.045, height: 0.035 };
  if (type === "date" || type === "initials") return { width: 0.18, height: 0.055 };
  if (type === "signature") return { width: 0.3, height: 0.08 };
  return { width: 0.28, height: 0.055 };
}

/**
 * Offset a copied field so it lands beside its original instead of hiding it.
 * The copy moves down and right, or back up and left when the page edge is in
 * the way, so a field placed at the very bottom of a page still yields a
 * visibly separate duplicate.
 */
export function duplicateSignatureFieldGeometry(
  geometry: SignatureFieldGeometry,
  offset = 0.02,
): SignatureFieldGeometry {
  const current = clampFieldGeometry(geometry);
  const step = Math.abs(finiteNumber(offset, 0.02));
  const shift = (position: number, size: number): number => {
    if (position + size + step <= 1) return position + step;
    if (position - step >= 0) return position - step;
    return position;
  };
  return clampFieldGeometry({
    ...current,
    x: shift(current.x, current.width),
    y: shift(current.y, current.height),
  });
}

/**
 * Pages that still need a copy of this field. A page counts as covered when it
 * already carries a field of the same type for the same recipient, so asking
 * for "initials on every page" twice does not stack two fields on each page.
 */
export function signatureFieldPagesToFill(
  field: Pick<SignatureField, "recipientId" | "type">,
  fields: Pick<SignatureField, "recipientId" | "type" | "pageNumber">[],
  pageCount: number,
): number[] {
  if (!Number.isInteger(pageCount) || pageCount < 1) return [];
  const covered = new Set(
    fields
      .filter(
        (candidate) =>
          candidate.recipientId === field.recipientId && candidate.type === field.type,
      )
      .map((candidate) => candidate.pageNumber),
  );
  const pages: number[] = [];
  for (let page = 1; page <= pageCount; page += 1) {
    if (!covered.has(page)) pages.push(page);
  }
  return pages;
}

export type SignaturePageSummary = { pageNumber: number; fieldCount: number };

/** Per-page field counts backing the editor's page navigator. */
export function signatureFieldPageSummary(
  fields: Pick<SignatureField, "pageNumber">[],
  pageCount: number,
): SignaturePageSummary[] {
  if (!Number.isInteger(pageCount) || pageCount < 1) return [];
  return Array.from({ length: pageCount }, (_, index) => ({
    pageNumber: index + 1,
    fieldCount: fields.filter((field) => field.pageNumber === index + 1).length,
  }));
}

export function clampSignaturePage(page: number, pageCount: number): number {
  if (!Number.isInteger(pageCount) || pageCount < 1) return 1;
  if (!Number.isFinite(page)) return 1;
  return Math.min(pageCount, Math.max(1, Math.round(page)));
}

export type SignaturePageBox = { pageNumber: number; top: number; bottom: number };

/**
 * The page a reader is actually looking at: the one sharing the most height
 * with the viewport. Ties go to the lower page number so scrolling through a
 * long document never reads backwards.
 */
export function visibleSignaturePage(
  pages: SignaturePageBox[],
  viewport: { top: number; bottom: number },
): number {
  let best: { pageNumber: number; overlap: number } | null = null;
  for (const page of pages) {
    const overlap =
      Math.min(page.bottom, viewport.bottom) - Math.max(page.top, viewport.top);
    if (!best || overlap > best.overlap) best = { pageNumber: page.pageNumber, overlap };
  }
  return best?.pageNumber ?? 1;
}

/** Marks a rendered PDF page so a caller can measure it or scroll to it. */
export const SIGNATURE_PAGE_SELECTOR = "[data-signature-page]";
export type SignatureScrollCandidate = {
  overflowY: string;
  scrollHeight: number;
  clientHeight: number;
};

/**
 * Which ancestor actually scrolls the document column. The editor column
 * carries `overflow-y: auto` but is sized by its content, so the real scroller
 * is further up the tree; an element that merely *may* scroll is not one that
 * does, and scrolling the wrong one silently does nothing.
 */
export function signatureScrollAncestorIndex(
  candidates: SignatureScrollCandidate[],
): number {
  return candidates.findIndex(
    (candidate) =>
      /auto|scroll|overlay/.test(candidate.overflowY) &&
      candidate.scrollHeight > candidate.clientHeight + 1,
  );
}

export type SignatureReadinessTarget =
  | { kind: "title" }
  | { kind: "expiry" }
  | { kind: "add-recipient" }
  | { kind: "recipient"; recipientId: string; input: "name" | "email" }
  | { kind: "signature"; recipientId: string };

/** What a readiness item should put the Member in front of when they click it. */
export function signatureReadinessTarget(
  issue: SignatureDraftReadinessIssue,
): SignatureReadinessTarget {
  if (issue.code === "title") return { kind: "title" };
  if (issue.code === "expiry") return { kind: "expiry" };
  if (issue.code === "signer" || !issue.recipientId) return { kind: "add-recipient" };
  if (issue.code === "signature") {
    return { kind: "signature", recipientId: issue.recipientId };
  }
  return {
    kind: "recipient",
    recipientId: issue.recipientId,
    input: issue.input ?? "email",
  };
}

/**
 * Inline, per-input recipient feedback. A blank row stays quiet — the send
 * checklist already says a recipient is incomplete, and marking a row someone
 * has not finished typing as wrong is noise, not help.
 */
export function signatureRecipientEmailProblem(
  recipient: Pick<SignatureRecipient, "id" | "email">,
  recipients: Pick<SignatureRecipient, "id" | "name" | "email">[],
): string | null {
  if (!recipient.email.trim()) return null;
  const email = normalizeSignatureEmail(recipient.email);
  if (!email) return "This does not look like an email address.";
  for (const candidate of recipients) {
    if (candidate.id === recipient.id) break;
    if (normalizeSignatureEmail(candidate.email) === email) {
      return `Already used by ${candidate.name.trim() || "another recipient"}.`;
    }
  }
  return null;
}

export type SignatureEditorShortcut = "duplicate" | "delete";

/** Keyboard shortcuts the field editor answers when a field is selected. */
export function signatureEditorShortcut(event: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
}): SignatureEditorShortcut | null {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") return "duplicate";
  if (event.metaKey || event.ctrlKey) return null;
  if (event.key === "Delete" || event.key === "Backspace") return "delete";
  return null;
}

/**
 * Shortcuts must not fire while someone is typing a label or a recipient name,
 * where Backspace means "delete a character".
 */
export function signatureShortcutTargetIsTextEntry(
  target: { tagName?: string; isContentEditable?: boolean } | null | undefined,
): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tagName = (target.tagName ?? "").toUpperCase();
  return tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
}

/** Accept both the canonical detail DTO and a legacy flat envelope response. */
export function normalizeEnvelopeDetail(value: unknown): SignatureEnvelopeDetail {
  const raw = (value ?? {}) as Partial<SignatureEnvelopeDetail> & Partial<SignatureEnvelope>;
  const envelope = (raw.envelope ?? raw) as SignatureEnvelope;
  return {
    envelope,
    recipients: Array.isArray(raw.recipients) ? raw.recipients : [],
    fields: Array.isArray(raw.fields) ? raw.fields : [],
    events: Array.isArray(raw.events) ? raw.events : [],
    customer: raw.customer ?? envelope.customer ?? null,
  };
}

export function envelopeFilename(envelope: SignatureEnvelope): string {
  return envelope.originalFilename || envelope.filename || "Document.pdf";
}

export function normalizeEnvelopeList(value: unknown): SignatureEnvelope[] {
  if (Array.isArray(value)) return value as SignatureEnvelope[];
  const raw = value as { rows?: unknown; envelopes?: unknown } | null;
  if (Array.isArray(raw?.rows)) return raw.rows as SignatureEnvelope[];
  if (Array.isArray(raw?.envelopes)) return raw.envelopes as SignatureEnvelope[];
  return [];
}
