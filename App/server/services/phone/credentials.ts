import { AppDataSource } from "../../db/datasource.js";
import { IntegrationConnection } from "../../db/entities/IntegrationConnection.js";
import type { PhoneNumber } from "../../db/entities/PhoneNumber.js";
import { ConnectionAuthError } from "../../integrations/types.js";
import { readTwilioConfig, type TwilioConfig } from "../../integrations/providers/twilio.js";
import { decryptConnectionConfig, markConnectionUnusable } from "../integrations.js";
import { PhoneError } from "./errors.js";

/**
 * The Twilio credential behind a number or a Connection, decrypted for one
 * server-side call and never handed further.
 */
export type TwilioAccount = {
  connection: IntegrationConnection;
  creds: TwilioConfig;
};

export async function twilioAccountForConnection(
  companyId: string,
  connectionId: string,
): Promise<TwilioAccount> {
  const connection = await AppDataSource.getRepository(IntegrationConnection).findOneBy({
    id: connectionId,
    companyId,
  });
  if (!connection || connection.provider !== "twilio") {
    throw new PhoneError(
      "That Twilio connection no longer exists. Connect Twilio at Settings → Integrations.",
      404,
    );
  }
  return { connection, creds: readTwilioConfig(decryptConnectionConfig(connection)) };
}

export async function twilioAccountForNumber(number: PhoneNumber): Promise<TwilioAccount> {
  return twilioAccountForConnection(number.companyId, number.connectionId);
}

/** Every Twilio Connection the company holds, oldest first. */
export async function listTwilioConnections(companyId: string): Promise<IntegrationConnection[]> {
  return AppDataSource.getRepository(IntegrationConnection).find({
    where: { companyId, provider: "twilio" },
    order: { createdAt: "ASC" },
  });
}

/**
 * Run a Twilio call, and when Twilio says the credential itself is finished,
 * mark the Connection so Settings → Integrations stops showing a healthy
 * account — the same thing every other connector does on that failure.
 */
export async function withTwilioAccount<T>(
  account: TwilioAccount,
  fn: (creds: TwilioConfig) => Promise<T>,
): Promise<T> {
  try {
    return await fn(account.creds);
  } catch (err) {
    if (err instanceof ConnectionAuthError) {
      await markConnectionUnusable({
        connection: account.connection,
        status: err.connectionStatus,
        message: err.message,
      }).catch(() => undefined);
    }
    throw err;
  }
}
