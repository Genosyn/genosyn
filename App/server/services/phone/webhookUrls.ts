import { getPublicUrl, isPublicUrlConfigured } from "../publicUrl.js";
import type { TwilioNumberWebhooks } from "../../integrations/providers/twilio.js";

/**
 * Where Twilio reaches this install. One mount, exported so the router and
 * every URL handed to Twilio are built from the same string — two copies would
 * drift, and the failure would be a number that silently stops ringing.
 */
export const PHONE_WEBHOOK_MOUNT = "/api/phone/webhooks";

function origin(base: string): string {
  return base.replace(/\/+$/, "");
}

export function phoneNumberWebhooks(base: string, phoneNumberId: string): TwilioNumberWebhooks {
  const root = `${origin(base)}${PHONE_WEBHOOK_MOUNT}/numbers/${encodeURIComponent(phoneNumberId)}`;
  return {
    smsUrl: `${root}/sms`,
    voiceUrl: `${root}/voice`,
    statusCallbackUrl: `${root}/call-status`,
  };
}

export function callWebhookUrl(
  base: string,
  callId: string,
  step: "answer" | "listen" | "wait" | "status",
  query: Record<string, string> = {},
): string {
  const qs = new URLSearchParams(query).toString();
  return `${origin(base)}${PHONE_WEBHOOK_MOUNT}/calls/${encodeURIComponent(callId)}/${step}${qs ? `?${qs}` : ""}`;
}

export function messageStatusUrl(base: string, messageId: string): string {
  return `${origin(base)}${PHONE_WEBHOOK_MOUNT}/messages/${encodeURIComponent(messageId)}/status`;
}

/**
 * The address Twilio should call, or null when this install has none it can
 * reach. Calls need one; texts do not, because inbound texts are fetched from
 * Twilio when nothing pushes them.
 */
export function reachableBaseUrl(): string | null {
  if (!isPublicUrlConfigured()) return null;
  const base = getPublicUrl();
  try {
    const host = new URL(base).hostname.toLowerCase();
    if (isPrivateHost(host)) return null;
  } catch {
    return null;
  }
  return base;
}

/**
 * Hosts Twilio cannot reach from the internet. A public URL of
 * `http://localhost:8471` is a valid setting for the browser, and useless for a
 * webhook — handing it to Twilio would make every call fail at Twilio's end
 * with nothing in Genosyn's logs to say why.
 */
export function isPrivateHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || host === "[::1]") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  return false;
}
