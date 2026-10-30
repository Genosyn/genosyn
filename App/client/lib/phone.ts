import { api } from "./api";
import type { PhoneCallMode, PhoneTextMode } from "../../shared/phone";

/**
 * Phone numbers — Twilio numbers given to AI Employees, with their texts and
 * calls. Shapes mirror `server/services/phone/*`; every route is owner/admin.
 */

export type PhoneConnectionSummary = {
  id: string;
  label: string;
  accountHint: string;
  status: "connected" | "error" | "expired";
  statusMessage: string;
};

export type PhoneSetup = {
  connections: PhoneConnectionSummary[];
  publicUrl: { configured: boolean; reachable: boolean; url: string | null };
};

export type PhoneNumberRow = {
  id: string;
  e164: string;
  display: string;
  label: string;
  country: string;
  locality: string;
  capabilities: { voice: boolean; sms: boolean; mms: boolean };
  employee: { id: string; name: string; slug: string; role: string } | null;
  connection: { id: string; label: string; accountHint: string; status: string } | null;
  callMode: PhoneCallMode;
  forwardTo: string | null;
  textMode: PhoneTextMode;
  greeting: string;
  instructions: string;
  voice: string;
  dailyTextLimit: number;
  dailyCallLimit: number;
  webhooks: { state: "current" | "outdated" | "error" | "none"; error: string };
  reservedInGenosyn: boolean;
  createdAt: string;
};

export type PhoneNumberDetailRow = PhoneNumberRow & {
  usage: { textsToday: number; callsToday: number };
};

export type AvailablePhoneNumber = {
  phoneNumber: string;
  friendlyName: string;
  locality: string;
  region: string;
  country: string;
  voice: boolean;
  sms: boolean;
  mms: boolean;
  addressRequirements: string;
};

export type ImportablePhoneNumber = {
  sid: string;
  e164: string;
  display: string;
  friendlyName: string;
  capabilities: { voice: boolean; sms: boolean; mms: boolean };
  configuredElsewhere: boolean;
};

export type PhoneText = {
  id: string;
  phoneNumberId: string;
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  fromDisplay: string;
  toDisplay: string;
  body: string;
  status: "received" | "queued" | "sending" | "sent" | "delivered" | "undelivered" | "failed";
  occurredAt: string;
  errorMessage: string;
  sentBy: "employee" | "auto_reply" | "member" | null;
  mediaCount: number;
};

export type PhoneCallTurn = {
  speaker: "caller" | "employee";
  text: string;
  at: string;
  digits?: string;
};

export type PhoneCallRow = {
  id: string;
  phoneNumberId: string;
  employeeId: string | null;
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  fromDisplay: string;
  toDisplay: string;
  status:
    | "queued"
    | "ringing"
    | "in-progress"
    | "completed"
    | "busy"
    | "no-answer"
    | "failed"
    | "canceled";
  /** `message`: the AI Model was unavailable, so the employee took a message. */
  handling: "employee" | "forwarded" | "declined" | "unavailable" | "message";
  answeredAt: string | null;
  endedAt: string | null;
  durationSec: number | null;
  endReason: string;
  errorMessage: string;
  brief: string;
  placedBy: "employee" | "member" | null;
  turnCount: number;
  createdAt: string;
  transcript?: PhoneCallTurn[];
};

export type PhoneNumberPatch = Partial<{
  label: string;
  employeeId: string | null;
  callMode: PhoneCallMode;
  forwardTo: string | null;
  textMode: PhoneTextMode;
  greeting: string;
  instructions: string;
  voice: string;
  dailyTextLimit: number;
  dailyCallLimit: number;
}>;

const base = (cid: string) => `/api/companies/${cid}/phone`;

export const phoneApi = {
  setup: (cid: string) => api.get<PhoneSetup>(`${base(cid)}/setup`),
  numbers: (cid: string, employeeId?: string) =>
    api.get<PhoneNumberRow[]>(
      `${base(cid)}/numbers${employeeId ? `?employeeId=${encodeURIComponent(employeeId)}` : ""}`,
    ),
  number: (cid: string, id: string) => api.get<PhoneNumberDetailRow>(`${base(cid)}/numbers/${id}`),
  search: (
    cid: string,
    query: {
      connectionId: string;
      country: string;
      type: "local" | "toll-free" | "mobile";
      areaCode?: string;
      contains?: string;
    },
  ) => {
    const params = new URLSearchParams({
      connectionId: query.connectionId,
      country: query.country,
      type: query.type,
    });
    if (query.areaCode) params.set("areaCode", query.areaCode);
    if (query.contains) params.set("contains", query.contains);
    return api.get<{
      numbers: AvailablePhoneNumber[];
      monthlyPrice: { amount: string; currency: string } | null;
    }>(`${base(cid)}/available?${params.toString()}`);
  },
  reserve: (
    cid: string,
    body: {
      connectionId: string;
      phoneNumber: string;
      employeeId: string | null;
      label: string;
      country: string;
      locality: string;
    },
  ) => api.post<PhoneNumberRow>(`${base(cid)}/numbers`, body),
  importable: (cid: string, connectionId: string) =>
    api.get<ImportablePhoneNumber[]>(
      `${base(cid)}/importable?connectionId=${encodeURIComponent(connectionId)}`,
    ),
  import: (
    cid: string,
    body: { connectionId: string; sid: string; employeeId: string | null; label: string },
  ) => api.post<PhoneNumberRow>(`${base(cid)}/numbers/import`, body),
  update: (cid: string, id: string, patch: PhoneNumberPatch) =>
    api.patch<PhoneNumberRow>(`${base(cid)}/numbers/${id}`, patch),
  syncWebhooks: (cid: string, id: string) =>
    api.post<PhoneNumberRow>(`${base(cid)}/numbers/${id}/webhooks`),
  remove: (cid: string, id: string, release: boolean) =>
    api.del<{ ok: true }>(`${base(cid)}/numbers/${id}?release=${release ? "true" : "false"}`),
  texts: (cid: string, id: string, limit = 100) =>
    api.get<PhoneText[]>(`${base(cid)}/numbers/${id}/texts?limit=${limit}`),
  sendText: (cid: string, id: string, body: { to: string; body: string }) =>
    api.post<PhoneText>(`${base(cid)}/numbers/${id}/texts`, body),
  calls: (cid: string, id: string, limit = 50) =>
    api.get<PhoneCallRow[]>(`${base(cid)}/numbers/${id}/calls?limit=${limit}`),
  call: (cid: string, callId: string) => api.get<PhoneCallRow>(`${base(cid)}/calls/${callId}`),
  placeTestCall: (
    cid: string,
    id: string,
    body: { to: string; brief: string; openingLine: string },
  ) => api.post<PhoneCallRow>(`${base(cid)}/numbers/${id}/calls`, body),
  hangUp: (cid: string, callId: string) =>
    api.post<{ ok: true }>(`${base(cid)}/calls/${callId}/hang-up`),
};

export function callStatusLabel(call: PhoneCallRow): string {
  switch (call.status) {
    case "queued":
      return "Dialing";
    case "ringing":
      return "Ringing";
    case "in-progress":
      return "On the call";
    case "completed":
      return call.handling === "declined"
        ? "Declined"
        : call.handling === "forwarded"
          ? "Forwarded"
          : call.handling === "unavailable"
            ? "Not taken"
            : call.handling === "message"
              ? "Message taken"
              : "Ended";
    case "busy":
      return "Busy";
    case "no-answer":
      return "No answer";
    case "failed":
      return "Failed";
    case "canceled":
      return "Canceled";
  }
}

export function isLiveCall(call: PhoneCallRow): boolean {
  return call.status === "queued" || call.status === "ringing" || call.status === "in-progress";
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}
