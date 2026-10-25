/** A request the caller can fix: a bad value, a missing field. Answered 400. */
export class DataRoomValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "DataRoomValidationError";
  }
}

/** Nothing by that id in this company. Answered 404. */
export class DataRoomNotFoundError extends Error {
  readonly status = 404;
  constructor(message: string) {
    super(message);
    this.name = "DataRoomNotFoundError";
  }
}

/** The request is fine but the room's state refuses it. Answered 409. */
export class DataRoomConflictError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = "DataRoomConflictError";
  }
}

export type DataRoomError = DataRoomValidationError | DataRoomNotFoundError | DataRoomConflictError;

export function isDataRoomError(error: unknown): error is DataRoomError {
  return (
    error instanceof DataRoomValidationError ||
    error instanceof DataRoomNotFoundError ||
    error instanceof DataRoomConflictError
  );
}
