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
  > & { companyName?: string; filename?: string; finalizationPending?: boolean };
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

export const SIGNATURE_FIELD_LABELS: Record<SignatureFieldType, string> = {
  signature: "Signature",
  initials: "Initials",
  name: "Full name",
  email: "Email",
  date: "Date signed",
  text: "Text",
  checkbox: "Checkbox",
};

export const SIGNATURE_STATUS_LABELS: Record<SignatureEnvelopeStatus, string> = {
  draft: "Draft",
  sent: "Waiting",
  in_progress: "In progress",
  completed: "Completed",
  declined: "Declined",
  voided: "Voided",
  expired: "Expired",
};

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

export function recipientProgress(envelope: SignatureEnvelope): { done: number; total: number } {
  return {
    done: Number(envelope.completedRecipientCount ?? 0),
    total: Number(envelope.recipientCount ?? 0),
  };
}

export function clampFieldGeometry(
  patch: Partial<Pick<SignatureField, "x" | "y" | "width" | "height">>,
): Pick<SignatureField, "x" | "y" | "width" | "height"> {
  const width = Math.min(0.9, Math.max(0.04, Number(patch.width ?? 0.28)));
  const height = Math.min(0.4, Math.max(0.025, Number(patch.height ?? 0.07)));
  return {
    width,
    height,
    x: Math.min(1 - width, Math.max(0, Number(patch.x ?? 0.08))),
    y: Math.min(1 - height, Math.max(0, Number(patch.y ?? 0.08))),
  };
}

export function defaultFieldSize(type: SignatureFieldType): { width: number; height: number } {
  if (type === "checkbox") return { width: 0.045, height: 0.035 };
  if (type === "date" || type === "initials") return { width: 0.18, height: 0.055 };
  if (type === "signature") return { width: 0.3, height: 0.08 };
  return { width: 0.28, height: 0.055 };
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
