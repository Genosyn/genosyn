/** A request the caller can fix: a bad value, a missing field. Answered 400. */
export class SupportValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "SupportValidationError";
  }
}

/** Nothing by that id in this company. Answered 404. */
export class SupportNotFoundError extends Error {
  readonly status = 404;
  constructor(message: string) {
    super(message);
    this.name = "SupportNotFoundError";
  }
}

/** The request is fine but the ticket's state refuses it. Answered 409. */
export class SupportConflictError extends Error {
  readonly status = 409;
  constructor(
    message: string,
    /** A short machine word for a client that offers a way past it. */
    readonly code: string = "conflict",
  ) {
    super(message);
    this.name = "SupportConflictError";
  }
}

export type SupportError = SupportValidationError | SupportNotFoundError | SupportConflictError;

export function isSupportError(error: unknown): error is SupportError {
  return (
    error instanceof SupportValidationError ||
    error instanceof SupportNotFoundError ||
    error instanceof SupportConflictError
  );
}
