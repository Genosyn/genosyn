import { ConnectionAuthError } from "../../integrations/types.js";
import { TwilioApiError } from "../../integrations/providers/twilio.js";

/**
 * A phone operation that cannot go ahead, with a sentence the person (or the
 * AI Employee) can act on and the HTTP status a route should answer with.
 */
export class PhoneError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "PhoneError";
  }
}

/**
 * The message and status for a failure that is safe to show: Genosyn's own
 * refusals and Twilio's explained errors. Anything else is a bug and stays
 * out of the response.
 */
export function phoneFailure(err: unknown): { status: number; message: string } | null {
  if (err instanceof PhoneError) return { status: err.status, message: err.message };
  if (err instanceof ConnectionAuthError) return { status: 400, message: err.message };
  if (err instanceof TwilioApiError) return { status: 400, message: err.message };
  return null;
}
