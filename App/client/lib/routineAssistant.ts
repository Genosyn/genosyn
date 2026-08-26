import { api, MessageAction } from "./api";

/**
 * Ask AI on a Routine — the wire types and calls for the chat rail beside one
 * routine. The sibling of the per-email chat's half of `lib/mail.ts`, kept in
 * its own file because it is its own surface with its own routes.
 */

/** A file on a routine-chat turn — uploaded by the human or produced by the AI. */
export type RoutineAssistantAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  isImage: boolean;
};

export type RoutineAssistantMessage = {
  id: string;
  routineId: string;
  role: "user" | "assistant";
  employeeId: string | null;
  /** The AI Model the turn ran on; null on human rows. */
  modelId: string | null;
  content: string;
  /** `working` is an in-flight reply the panel follows until it resolves. */
  status: "working" | "ok" | "skipped" | "error" | null;
  actions: MessageAction[];
  attachments: RoutineAssistantAttachment[];
  createdAt: string;
};

/** One brain an employee can answer on, for the panel's model picker. */
export type RoutineAssistantModel = {
  id: string;
  provider: "anthropic" | "openai" | "custom";
  model: string;
  isActive: boolean;
};

export type RoutineAssistantRosterEntry = {
  id: string;
  name: string;
  slug: string;
  role: string;
  avatarKey: string | null;
  /** True for the employee this routine belongs to — the panel's default. */
  ownsRoutine: boolean;
  hasModel: boolean;
  models: RoutineAssistantModel[];
};

export type RoutineAssistantBootstrap = {
  messages: RoutineAssistantMessage[];
  roster: RoutineAssistantRosterEntry[];
  /** The brain this routine's chat has been running on, or null. */
  modelId: string | null;
};

export type RoutineAssistantSendInput = {
  message: string;
  employeeId?: string;
  attachmentIds?: string[];
  modelId?: string | null;
};

const base = (companyId: string, routineId: string) =>
  `/api/companies/${companyId}/routines/${routineId}/assistant`;

export const routineAssistantApi = {
  load: (companyId: string, routineId: string) =>
    api.get<RoutineAssistantBootstrap>(base(companyId, routineId)),

  send: (
    companyId: string,
    routineId: string,
    input: RoutineAssistantSendInput,
    onEvent: (event: string, data: unknown) => void,
    opts?: { signal?: AbortSignal },
  ) => api.stream(`${base(companyId, routineId)}/messages`, input, onEvent, opts),

  clear: (companyId: string, routineId: string) =>
    api.del<{ ok: true }>(`${base(companyId, routineId)}/messages`),

  upload: (companyId: string, routineId: string, file: File) =>
    api
      .uploadFile<{
        attachment: RoutineAssistantAttachment;
      }>(`${base(companyId, routineId)}/attachments`, file)
      .then((r) => r.attachment),

  attachmentUrl: (companyId: string, routineId: string, attachmentId: string) =>
    `${base(companyId, routineId)}/attachments/${attachmentId}`,
};
