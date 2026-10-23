import type { RecurringInvoiceNameSource } from "../../shared/recurringInvoiceName.js";
import { CUSTOMER_PICK_PARAM, withCustomerPick } from "./customerPick.js";
import { type DiscountDraft, NO_DISCOUNT_DRAFT } from "./discountForm.js";
import {
  changeRecurringInvoiceNameCustomer,
  initialRecurringInvoiceName,
  newRecurringInvoicePath,
  paymentTermsDays,
  type RecurringInvoiceNameState,
} from "./recurringInvoiceForm.js";
import { defaultScheduleParts, type Frequency, type ScheduleParts } from "./schedule.js";

/**
 * New invoice asks one question before anything is filled in: is this a
 * one-time invoice or a recurring invoice? People who meant to bill on a
 * schedule kept creating one-time invoices, so the answer is never assumed.
 *
 * - `invoices/new` is the question. Every link that starts an invoice opens
 *   it — the Invoices list, Finance's overview, a customer's Billing tab, the
 *   ⌘K palette — and a customer the link names (`?customerId=`) stays picked
 *   whichever answer is given.
 * - One-time continues to the invoice form, `invoices/new?kind=one-time`.
 * - Recurring opens the New recurring invoice form. A link that can only mean
 *   a schedule — New schedule on the Recurring list, a customer's New
 *   recurring invoice, Make recurring — goes there directly.
 *
 * Both new-invoice forms keep a One-time / Recurring switch at the top.
 * Switching hands the other form what was typed ({@link InvoiceDraft}) in
 * router state, which keeps it out of the URL and the logs: the customer,
 * issuer, currency, line items, discount, notes and footer as they are, and
 * the payment terms between the one-time form's dates and the recurring
 * form's Days until due. What only one form has — the dates, or the schedule
 * and its settings — rides along untouched, so switching back restores it.
 */
export type InvoiceKind = "one-time" | "recurring";

/** The two answers, in the order they are offered. */
export const INVOICE_KINDS: readonly InvoiceKind[] = ["one-time", "recurring"];

/** The query parameter that takes `invoices/new` past its question. */
export const INVOICE_KIND_PARAM = "kind";

/** Payment terms either form starts with when nothing says otherwise. */
export const DEFAULT_PAYMENT_TERMS_DAYS = 14;

/**
 * New invoice — the one-time-or-recurring question — optionally starting
 * with one customer picked, which either answer keeps.
 */
export function newInvoicePath(financeBase: string, customerId?: string | null): string {
  return withCustomerPick(`${financeBase}/invoices/new`, customerId);
}

/** The one-time invoice form itself, past the question. */
export function newOneTimeInvoicePath(financeBase: string, customerId?: string | null): string {
  const params = new URLSearchParams({ [INVOICE_KIND_PARAM]: "one-time" });
  if (customerId) params.set(CUSTOMER_PICK_PARAM, customerId);
  return `${financeBase}/invoices/new?${params}`;
}

/** Where an answer to New invoice's question leads, with the customer kept. */
export function invoiceKindPath(
  kind: InvoiceKind,
  financeBase: string,
  customerId?: string | null,
): string {
  return kind === "one-time"
    ? newOneTimeInvoicePath(financeBase, customerId)
    : newRecurringInvoicePath(financeBase, customerId);
}

/** What `invoices/new` shows: the question, or — once it is answered — the one-time form. */
export type NewInvoiceStep = "choose" | "one-time";

/** The step a link to `invoices/new` opens on. Anything but `kind=one-time` asks first. */
export function newInvoiceStep(params: URLSearchParams): NewInvoiceStep {
  const kind = params.get(INVOICE_KIND_PARAM)?.trim().toLowerCase();
  return kind === "one-time" ? "one-time" : "choose";
}

/**
 * The other form's link when someone switches: the customer picked here, else
 * the one this form was asked for and could not offer, so the other form says
 * so too instead of quietly billing whoever is first in the list.
 */
export function switchInvoiceKindPath(
  to: InvoiceKind,
  financeBase: string,
  customerId: string,
  requestedCustomerId: string | null,
): string {
  return invoiceKindPath(to, financeBase, customerId || requestedCustomerId);
}

/** A line as both forms hold it while it is typed. */
export type InvoiceDraftLine = {
  productId: string | null;
  description: string;
  quantityText: string;
  priceText: string;
  taxRateId: string;
};

/** The one-time form's own fields, as `YYYY-MM-DD`. */
export type OneTimeInvoiceDates = { issueDate: string; dueDate: string };

/** The recurring form's own fields. */
export type RecurringInvoiceSettings = {
  name: RecurringInvoiceNameState;
  schedule: ScheduleParts;
  autoSend: boolean;
  maxRunsText: string;
  endsOn: string;
};

/** What one new-invoice form hands the other when someone switches. */
export type InvoiceDraft = {
  /** "" when no customer is picked. */
  customerId: string;
  /** "" issues from the company itself. */
  subsidiaryId: string;
  currency: string;
  notes: string;
  footer: string;
  lines: InvoiceDraftLine[];
  discount: DiscountDraft;
  /**
   * Days from issue to due — the one-time form's two dates, the recurring
   * form's Days until due. Null when the dates could not be read.
   */
  daysUntilDue: number | null;
  /** The one-time form's dates as last set, for a switch back. */
  oneTime: OneTimeInvoiceDates | null;
  /** The recurring form's schedule and settings as last set, for a switch back. */
  recurring: RecurringInvoiceSettings | null;
};

/** What both forms hold, as typed. Lines may carry the form's own row key. */
type SharedFields = {
  customerId: string;
  subsidiaryId: string;
  currency: string;
  notes: string;
  footer: string;
  lines: ReadonlyArray<InvoiceDraftLine>;
  discount: DiscountDraft;
};

export type OneTimeInvoiceFields = SharedFields & OneTimeInvoiceDates;

export type RecurringInvoiceFields = SharedFields &
  RecurringInvoiceSettings & {
    daysUntilDue: number;
  };

function sharedDraft(fields: SharedFields) {
  return {
    customerId: fields.customerId,
    subsidiaryId: fields.subsidiaryId,
    currency: fields.currency,
    notes: fields.notes,
    footer: fields.footer,
    lines: fields.lines.map(copyLine),
    discount: { mode: fields.discount.mode, text: fields.discount.text },
  };
}

function copyLine(line: InvoiceDraftLine): InvoiceDraftLine {
  return {
    productId: line.productId,
    description: line.description,
    quantityText: line.quantityText,
    priceText: line.priceText,
    taxRateId: line.taxRateId,
  };
}

/**
 * The one-time form, as typed, for the recurring form. `received` is the
 * draft this form was handed, if any, so the schedule set before comes back.
 * Unreadable dates leave the payment terms the recurring form had.
 */
export function draftFromOneTimeInvoice(
  fields: OneTimeInvoiceFields,
  received: InvoiceDraft | null,
): InvoiceDraft {
  const dated = isDateOnly(fields.issueDate) && isDateOnly(fields.dueDate);
  return {
    ...sharedDraft(fields),
    daysUntilDue:
      (dated ? paymentTermsDays(fields.issueDate, fields.dueDate) : null) ??
      received?.daysUntilDue ??
      null,
    oneTime: { issueDate: fields.issueDate, dueDate: fields.dueDate },
    recurring: received?.recurring ? copySettings(received.recurring) : null,
  };
}

/**
 * The recurring form, as typed, for the one-time form. `received` is the
 * draft this form was handed, if any, so the dates set before come back.
 */
export function draftFromRecurringInvoice(
  fields: RecurringInvoiceFields,
  received: InvoiceDraft | null,
): InvoiceDraft {
  return {
    ...sharedDraft(fields),
    daysUntilDue: clampDays(fields.daysUntilDue),
    oneTime: received?.oneTime ? { ...received.oneTime } : null,
    recurring: copySettings(fields),
  };
}

function copySettings(settings: RecurringInvoiceSettings): RecurringInvoiceSettings {
  return {
    name: { value: settings.name.value, followsCustomer: settings.name.followsCustomer },
    schedule: { ...settings.schedule },
    autoSend: settings.autoSend,
    maxRunsText: settings.maxRunsText,
    endsOn: settings.endsOn,
  };
}

/**
 * Who a form handed a draft starts with: the customer the other form had
 * picked, else the one the link asked for (`?customerId=`).
 */
export function draftCustomerRequest(
  draft: InvoiceDraft | null,
  requestedCustomerId: string | null,
): string | null {
  return draft?.customerId || requestedCustomerId || null;
}

/** The one-time form's fields from the draft the recurring form handed it. */
export function oneTimeInvoiceFromDraft(
  draft: InvoiceDraft,
  today: string,
): Omit<OneTimeInvoiceFields, "customerId"> & { lines: InvoiceDraftLine[] } {
  return {
    subsidiaryId: draft.subsidiaryId,
    currency: draft.currency,
    notes: draft.notes,
    footer: draft.footer,
    lines: draft.lines.map(copyLine),
    discount: { ...draft.discount },
    ...oneTimeDatesFromDraft(draft, today),
  };
}

/**
 * The one-time form's dates. Dates it set before come back exactly unless
 * Days until due changed on the way; otherwise the invoice is issued on the
 * earlier issue date, or `today`, and falls due that many days later.
 */
export function oneTimeDatesFromDraft(draft: InvoiceDraft, today: string): OneTimeInvoiceDates {
  const kept = draft.oneTime;
  const keptTerms = kept ? termsBetween(kept) : null;
  if (kept && keptTerms !== null && keptTerms === draft.daysUntilDue) return { ...kept };
  const issueDate = kept && isDateOnly(kept.issueDate) ? kept.issueDate : today;
  return {
    issueDate,
    dueDate: addDays(issueDate, draft.daysUntilDue ?? DEFAULT_PAYMENT_TERMS_DAYS),
  };
}

function termsBetween(dates: OneTimeInvoiceDates): number | null {
  if (!isDateOnly(dates.issueDate) || !isDateOnly(dates.dueDate)) return null;
  return paymentTermsDays(dates.issueDate, dates.dueDate);
}

/**
 * The recurring form's fields from the draft the one-time form handed it.
 * A schedule set before comes back as it was; its name still follows the
 * customer unless someone typed one. The first visit starts on the form's
 * defaults, named after `customer`.
 */
export function recurringInvoiceFromDraft(
  draft: InvoiceDraft,
  customer: RecurringInvoiceNameSource | null | undefined,
): Omit<RecurringInvoiceFields, "customerId"> & { lines: InvoiceDraftLine[] } {
  const kept = draft.recurring;
  return {
    subsidiaryId: draft.subsidiaryId,
    currency: draft.currency,
    notes: draft.notes,
    footer: draft.footer,
    lines: draft.lines.map(copyLine),
    discount: { ...draft.discount },
    daysUntilDue: draft.daysUntilDue ?? DEFAULT_PAYMENT_TERMS_DAYS,
    name: kept
      ? changeRecurringInvoiceNameCustomer(kept.name, customer)
      : initialRecurringInvoiceName(customer),
    schedule: kept ? { ...kept.schedule } : defaultScheduleParts(),
    autoSend: kept?.autoSend ?? false,
    maxRunsText: kept?.maxRunsText ?? "",
    endsOn: kept?.endsOn ?? "",
  };
}

// ── Router state ────────────────────────────────────────────────────────────

const DRAFT_STATE_KEY = "invoiceDraft";

/** The router state that hands `draft` to the other form. */
export function invoiceDraftState(draft: InvoiceDraft): { [DRAFT_STATE_KEY]: InvoiceDraft } {
  return { [DRAFT_STATE_KEY]: draft };
}

/**
 * The draft a switch handed this form, or null. Router state outlives the
 * page that wrote it — a reload, an older version of the app — so it is read
 * field by field, and anything malformed falls back to the form's default.
 */
export function readInvoiceDraft(state: unknown): InvoiceDraft | null {
  const raw = asRecord(asRecord(state)?.[DRAFT_STATE_KEY]);
  if (!raw) return null;
  return {
    customerId: asText(raw.customerId),
    subsidiaryId: asText(raw.subsidiaryId),
    currency: asText(raw.currency),
    notes: asText(raw.notes),
    footer: asText(raw.footer),
    lines: Array.isArray(raw.lines) ? raw.lines.flatMap(readLine) : [],
    discount: readDiscount(raw.discount),
    daysUntilDue: readDays(raw.daysUntilDue),
    oneTime: readDates(raw.oneTime),
    recurring: readSettings(raw.recurring),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function readLine(value: unknown): InvoiceDraftLine[] {
  const line = asRecord(value);
  if (!line) return [];
  return [
    {
      productId: typeof line.productId === "string" && line.productId ? line.productId : null,
      description: asText(line.description),
      quantityText: asText(line.quantityText, "1"),
      priceText: asText(line.priceText, "0.00"),
      taxRateId: asText(line.taxRateId),
    },
  ];
}

const DISCOUNT_MODES: readonly DiscountDraft["mode"][] = ["none", "percent", "amount"];

function readDiscount(value: unknown): DiscountDraft {
  const discount = asRecord(value);
  const mode = discount?.mode;
  if (!discount || !DISCOUNT_MODES.includes(mode as DiscountDraft["mode"])) {
    return NO_DISCOUNT_DRAFT;
  }
  return { mode: mode as DiscountDraft["mode"], text: asText(discount.text) };
}

function clampDays(days: number): number {
  return Math.min(365, Math.max(0, Math.round(days)));
}

function readDays(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? clampDays(value) : null;
}

function readDates(value: unknown): OneTimeInvoiceDates | null {
  const dates = asRecord(value);
  if (!dates || typeof dates.issueDate !== "string" || typeof dates.dueDate !== "string") {
    return null;
  }
  return { issueDate: dates.issueDate, dueDate: dates.dueDate };
}

const FREQUENCIES: readonly Frequency[] = ["daily", "weekly", "monthly", "quarterly", "yearly"];

/** A whole number within `[min, max]`, or the default part. */
function part(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

function readSettings(value: unknown): RecurringInvoiceSettings | null {
  const settings = asRecord(value);
  const name = asRecord(settings?.name);
  const schedule = asRecord(settings?.schedule);
  if (!settings || !name || !schedule) return null;
  const defaults = defaultScheduleParts();
  return {
    name: {
      value: asText(name.value),
      followsCustomer: typeof name.followsCustomer === "boolean" ? name.followsCustomer : true,
    },
    schedule: {
      frequency: FREQUENCIES.includes(schedule.frequency as Frequency)
        ? (schedule.frequency as Frequency)
        : defaults.frequency,
      intervalCount: part(schedule.intervalCount, 1, 99, defaults.intervalCount),
      dayOfMonth: part(schedule.dayOfMonth, 1, 31, defaults.dayOfMonth),
      weekday: part(schedule.weekday, 0, 6, defaults.weekday),
      month: part(schedule.month, 1, 12, defaults.month),
      hour: part(schedule.hour, 0, 23, defaults.hour),
      minute: part(schedule.minute, 0, 59, defaults.minute),
    },
    autoSend: settings.autoSend === true,
    maxRunsText: asText(settings.maxRunsText),
    endsOn: asText(settings.endsOn),
  };
}

// ── Dates ───────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date written `YYYY-MM-DD` — not "2026-02-30", which `Date` rolls over. */
export function isDateOnly(value: string): boolean {
  if (!DATE_ONLY.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/** `date` (`YYYY-MM-DD`) moved by whole days, in the calendar the form's date fields use. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + Math.round(days) * DAY_MS)
    .toISOString()
    .slice(0, 10);
}
