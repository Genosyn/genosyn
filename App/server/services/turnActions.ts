import { MoreThan } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { MessageAction, MessageActionMetadata } from "../db/entities/ConversationMessage.js";

/**
 * Turn-action capture: after an AI chat turn finishes, project the
 * AuditEvents the employee produced during the turn onto the lean
 * `MessageAction` shape the chat UIs render as action pills. Shared by the
 * employee chat surface and per-email AI chat — "no audit row, no pill".
 */

export function parseActions(raw: string | null | undefined): MessageAction[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (x): x is MessageAction =>
        !!x && typeof x === "object" && typeof (x as MessageAction).action === "string",
    );
  } catch {
    return [];
  }
}

/**
 * Narrow a persisted `metadataJson` blob down to the specific fields the
 * chat UI renders. We don't want to leak every field we happen to store
 * server-side into the client JSON — and fields of unexpected shape
 * should silently drop so one bad row can't break the pill list.
 */
function parseActionMetadata(raw: string | null | undefined): MessageActionMetadata | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const src = parsed as Record<string, unknown>;
  const out: MessageActionMetadata = {};
  if (typeof src.via === "string") out.via = src.via;
  if (typeof src.provider === "string") out.provider = src.provider;
  if (typeof src.connectionId === "string") out.connectionId = src.connectionId;
  if (typeof src.connectionLabel === "string") {
    out.connectionLabel = src.connectionLabel;
  }
  if (typeof src.toolName === "string") out.toolName = src.toolName;
  if (src.status === "ok" || src.status === "error") out.status = src.status;
  if (typeof src.durationMs === "number" && Number.isFinite(src.durationMs)) {
    out.durationMs = src.durationMs;
  }
  if (typeof src.argsPreview === "string") out.argsPreview = src.argsPreview;
  if (typeof src.resultPreview === "string") out.resultPreview = src.resultPreview;
  if (typeof src.error === "string") out.error = src.error;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Fetch the AuditEvents this employee produced during the chat turn
 * (after `since`) and project them onto the lean MessageAction shape the
 * UI renders. Filtered to `actorKind: "ai"` so we don't accidentally
 * surface mutations from other callers (webhook, cron, human admin) that
 * happened to land in the same millisecond window.
 */
export async function captureTurnActions(
  companyId: string,
  employeeId: string,
  since: Date,
): Promise<MessageAction[]> {
  const events = await AppDataSource.getRepository(AuditEvent).find({
    where: {
      companyId,
      actorEmployeeId: employeeId,
      actorKind: "ai",
      createdAt: MoreThan(since),
    },
    order: { createdAt: "ASC" },
  });
  return events.map((e) => {
    const metadata = parseActionMetadata(e.metadataJson);
    const action: MessageAction = {
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId,
      targetLabel: e.targetLabel,
    };
    if (metadata) action.metadata = metadata;
    return action;
  });
}
