import { AppDataSource } from "../../db/datasource.js";
import { IntegrationConnection } from "../../db/entities/IntegrationConnection.js";
import { PhoneNumber } from "../../db/entities/PhoneNumber.js";
import { withSchedulerLease } from "../schedulerLeases.js";
import { syncPhoneNumberWebhooks } from "./numbers.js";
import { handleFreshInboundText } from "./textReplies.js";
import { setFreshInboundTextHandler, syncInboundTexts } from "./texts.js";
import { reachableBaseUrl } from "./webhookUrls.js";

/**
 * The phone heartbeat. Once a minute:
 *
 *  - **Fetch texts Twilio cannot push.** A number whose webhooks do not point
 *    at a reachable public URL would otherwise never receive anything here, so
 *    its inbound texts are listed from Twilio instead. That is what makes a
 *    verification code arrive on an install that runs on a laptop.
 *  - **Re-point webhooks that went stale.** When an admin sets or changes the
 *    public URL, every number is moved to the new address without anyone
 *    having to open its settings. A failure is retried at most hourly.
 *
 * Calls have no fallback: Twilio has to reach a call's webhook in real time.
 */

const TICK_MS = 60_000;
const WEBHOOK_RETRY_MS = 60 * 60 * 1000;

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;
const lastWebhookAttempt = new Map<string, number>();

export function bootPhone(): void {
  setFreshInboundTextHandler(handleFreshInboundText);
  if (timer) return;
  timer = setInterval(() => {
    void phoneTick().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[phone] heartbeat failed:", err instanceof Error ? err.message : err);
    });
  }, TICK_MS);
  timer.unref();
}

export function stopPhone(): void {
  if (timer) clearInterval(timer);
  timer = null;
  setFreshInboundTextHandler(null);
}

export async function phoneTick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await withSchedulerLease("phone-heartbeat", 55_000, async () => {
      const numbers = await AppDataSource.getRepository(PhoneNumber).find();
      // A Connection Twilio has already refused stays refused until someone
      // reconnects it, which resets its status; asking again every minute
      // would only repeat the refusal into the log.
      const expired = new Set(
        (
          await AppDataSource.getRepository(IntegrationConnection).find({
            where: { provider: "twilio", status: "expired" },
            select: { id: true },
          })
        ).map((c) => c.id),
      );
      const base = reachableBaseUrl();
      for (const number of numbers) {
        if (expired.has(number.connectionId)) continue;
        const pushed = !!base && number.webhookBaseUrl === base && !number.webhookError;
        if (base && !pushed) {
          // Keyed by the address too: a new public URL is tried at once, and
          // only a repeat failure for the same one waits out the hour.
          const key = `${number.id}|${base}`;
          const last = lastWebhookAttempt.get(key);
          if (last === undefined || Date.now() - last >= WEBHOOK_RETRY_MS) {
            lastWebhookAttempt.set(key, Date.now());
            const synced = await syncPhoneNumberWebhooks(number).catch(() => number);
            if (synced.webhookBaseUrl === base && !synced.webhookError) continue;
          }
        }
        if (number.smsEnabled && !pushed) {
          await syncInboundTexts(number).catch((err) => {
            // eslint-disable-next-line no-console
            console.warn(
              `[phone] could not fetch texts for ${number.id}:`,
              err instanceof Error ? err.message : err,
            );
          });
        }
      }
    });
  } finally {
    ticking = false;
  }
}
