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
