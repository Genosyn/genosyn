import { ApiError } from "@/lib/api";

/**
 * The sentence to show a human for a thrown value.
 *
 * Call sites used to inline `err instanceof Error ? err.message : "…"` on
 * the way into a toast. Toasts are gone; the same string now lands in a
 * `<FormError>` beside the control that failed, or in the error modal, so
 * the shape lives in one place instead of five hundred.
 */
export function errorMessage(error: unknown, fallback = "Something went wrong"): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

/**
 * The longer explanation a refused request carried beside its sentence, for
 * `<FormError detail>` to show under "View details" — what an AI Model's
 * service said when its connection test failed, say. Null when there is none.
 */
export function errorDetail(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const detail = (error.data as { detail?: unknown } | null)?.detail;
  return typeof detail === "string" && detail.trim() ? detail : null;
}
