import type {
  BaseField,
  BaseFieldType,
  BaseForm,
  PublicBaseFormFieldType,
  PublicBaseFormQuestion,
  SelectOption,
} from "./api";

export const PUBLIC_FORM_FIELD_TYPES = [
  "text",
  "longtext",
  "number",
  "checkbox",
  "date",
  "datetime",
  "email",
  "url",
  "select",
  "multiselect",
] as const satisfies readonly PublicBaseFormFieldType[];

export type PublicFormValue = string | number | boolean | string[] | null;
export type PublicFormValues = Record<string, PublicFormValue>;
export type PublicFormUrlNotice = "local-only" | "insecure-http" | "unconfigured";

type ClientCrypto = {
  randomUUID?: () => string;
  getRandomValues?: (values: Uint8Array) => Uint8Array;
};

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Produces a UUID for client-created question ids and response idempotency
 * keys. `randomUUID` is restricted to secure browser contexts, while
 * self-hosted installs are also commonly opened over plain HTTP.
 */
export function createClientUuid(
  cryptoApi: ClientCrypto | null = typeof globalThis.crypto === "undefined"
    ? null
    : (globalThis.crypto as ClientCrypto),
): string {
  if (typeof cryptoApi?.randomUUID === "function") {
    try {
      const candidate = cryptoApi.randomUUID();
      if (UUID_V4_PATTERN.test(candidate)) return candidate;
    } catch {
      // Fall through to getRandomValues (or the last-resort local generator).
    }
  }

  const bytes = new Uint8Array(16);
  let filled = false;
  if (typeof cryptoApi?.getRandomValues === "function") {
    try {
      cryptoApi.getRandomValues(bytes);
      filled = true;
    } catch {
      // Some HTTP browser contexts expose crypto but reject this operation.
    }
  }
  if (!filled) {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  // RFC 4122 version 4 + variant bits make every fallback a valid UUID.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Distinguishes a usable local URL from one that is safe to share publicly. */
export function publicFormUrlNotice(
  value: string | null,
  publicUrlConfigured?: boolean,
): PublicFormUrlNotice | null {
  if (!value) return publicUrlConfigured === false ? "unconfigured" : null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "unconfigured";
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "::1" ||
    hostname === "0.0.0.0" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (loopback) return "local-only";
  if (url.protocol !== "https:") return "insecure-http";
  if (publicUrlConfigured === false) return "unconfigured";
  return null;
}

export function isPublicFormFieldType(type: BaseFieldType): type is PublicBaseFormFieldType {
  return (PUBLIC_FORM_FIELD_TYPES as readonly string[]).includes(type);
}

export function publicFormFields(fields: BaseField[]): BaseField[] {
  return fields.filter((field) => isPublicFormFieldType(field.type));
}

export function selectOptionsForField(field: BaseField): SelectOption[] {
  if (field.type !== "select" && field.type !== "multiselect") return [];
  const value = (field.config as { options?: unknown }).options;
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const options: SelectOption[] = [];
  for (const candidate of value.slice(0, 100)) {
    if (!candidate || typeof candidate !== "object") continue;
    const option = candidate as Record<string, unknown>;
    const label = typeof option.label === "string" ? option.label.trim() : "";
    if (
      typeof option.id !== "string" ||
      option.id.length < 1 ||
      option.id.length > 255 ||
      label.length < 1 ||
      label.length > 200 ||
      seen.has(option.id)
    ) {
      continue;
    }
    seen.add(option.id);
    options.push({
      id: option.id,
      label,
      color: typeof option.color === "string" && option.color.length <= 40 ? option.color : "slate",
    });
  }
  return options;
}

export function formFieldTypeLabel(type: PublicBaseFormFieldType): string {
  switch (type) {
    case "longtext":
      return "Long text";
    case "number":
      return "Number";
    case "checkbox":
      return "Checkbox";
    case "date":
      return "Date";
    case "datetime":
      return "Date & time";
    case "email":
      return "Email";
    case "url":
      return "URL";
    case "select":
      return "Single select";
    case "multiselect":
      return "Multiple select";
    default:
      return "Text";
  }
}

export function initialPublicFormValues(questions: PublicBaseFormQuestion[]): PublicFormValues {
  return Object.fromEntries(
    questions.map((question) => [
      question.id,
      question.type === "checkbox" ? false : question.type === "multiselect" ? [] : "",
    ]),
  );
}

export function publicFormValueIsAnswered(
  question: PublicBaseFormQuestion,
  value: PublicFormValue | undefined,
): boolean {
  if (question.type === "checkbox") return value === true;
  if (question.type === "multiselect") return Array.isArray(value) && value.length > 0;
  if (question.type === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  return typeof value === "string" && value.trim().length > 0;
}

export function validatePublicFormValues(
  questions: PublicBaseFormQuestion[],
  values: PublicFormValues,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const question of questions) {
    const value = values[question.id];
    if (question.required && !publicFormValueIsAnswered(question, value)) {
      errors[question.id] =
        question.type === "checkbox" ? "Check this box to continue." : "This question is required.";
      continue;
    }
    if (typeof value !== "string" || !value.trim()) continue;
    if (question.type === "email" && !/^\S+@\S+\.\S+$/.test(value)) {
      errors[question.id] = "Enter a valid email address.";
    }
    if (question.type === "url") {
      try {
        const url = new URL(value);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          errors[question.id] = "Enter a complete http or https URL.";
        }
      } catch {
        errors[question.id] = "Enter a complete URL.";
      }
    }
  }
  return errors;
}

export function baseFormStatus(
  form: Pick<BaseForm, "publishedAt" | "acceptingResponses">,
  tableArchived = false,
): {
  label: "Draft" | "Live" | "Closed" | "Unavailable";
  tone: "slate" | "emerald" | "amber";
} {
  if (tableArchived) return { label: "Unavailable", tone: "amber" };
  if (!form.publishedAt) return { label: "Draft", tone: "slate" };
  if (!form.acceptingResponses) return { label: "Closed", tone: "amber" };
  return { label: "Live", tone: "emerald" };
}

export function formatResponseTime(value: string | null): string {
  if (!value) return "No responses yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Response received";
  return `Last response ${date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  })}`;
}
