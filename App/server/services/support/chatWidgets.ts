import crypto from "node:crypto";

import { AppDataSource } from "../../db/datasource.js";
import { Company } from "../../db/entities/Company.js";
import { SupportChatWidget } from "../../db/entities/SupportChatWidget.js";
import { SupportInbox } from "../../db/entities/SupportInbox.js";
import {
  DEFAULT_SUPPORT_CHAT_GREETING,
  SUPPORT_CHAT_LIMITS,
  type ChatWidgetConfig,
} from "../../../shared/supportChat.js";
import { recordAudit } from "../audit.js";
import { getPublicUrl } from "../publicUrl.js";
import { emitResourceChange } from "../resourceEvents.js";
import { parseJsonArray, type SupportActor } from "./access.js";
import { SupportValidationError } from "./errors.js";

/**
 * A Support inbox's Chat widget: whether it is on, and which sites may frame it.
 *
 * Everything an owner sets here is a browser-enforced fence and not a lock: the
 * origin list stops other sites embedding the widget, and says nothing to `curl`,
 * which is why the throttles in `chatThrottle.ts` are what bounds its cost. No AI
 * tool reads or writes a widget, for the reason none writes a Project's Email
 * intake: an open door is an owner's decision.
 */

/** What an origin looks like by the time it may reach a response header. */
const ORIGIN_SHAPE = /^https?:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/;

function notAnOrigin(raw: string): SupportValidationError {
  return new SupportValidationError(
    `"${raw.slice(0, 80)}" is not a site address. Use the form https://www.example.com, with no path and no wildcard.`,
  );
}

/**
 * One exact origin, or a refusal. A list a browser enforces is only as good as its
 * entries, and each of these goes into a `Content-Security-Policy` header, so the
 * URL parser normalizes it and a strict pattern has the last word on what may reach
 * that header: no wildcard, path, credentials, `null` or separator gets through.
 */
export function normalizeOrigin(raw: string): string {
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw notAnOrigin(raw);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw notAnOrigin(raw);
  if (url.username || url.password) throw notAnOrigin(raw);
  if (url.pathname !== "/" || url.search || url.hash) throw notAnOrigin(raw);
  const origin = url.origin.toLowerCase();
  if (!ORIGIN_SHAPE.test(origin)) throw notAnOrigin(raw);
  return origin;
}

function cleanOrigins(origins: readonly string[]): string[] {
  const cleaned = new Set<string>();
  for (const raw of origins) {
    if (raw.trim()) cleaned.add(normalizeOrigin(raw));
  }
  if (cleaned.size > SUPPORT_CHAT_LIMITS.originsPerWidget) {
    throw new SupportValidationError(
      `Name at most ${SUPPORT_CHAT_LIMITS.originsPerWidget} sites on one Chat widget.`,
    );
  }
  return [...cleaned];
}

/** Postgres refuses a NUL byte in text, and an API key can send one as easily as a browser. */
function cleanWords(raw: string): string {
  return raw.replaceAll("\u0000", "").trim();
}

/** What is stored, checked again on the way out, so a bad row can never reach a header. */
export function allowedOrigins(widget: Pick<SupportChatWidget, "allowedOriginsJson">): string[] {
  return parseJsonArray<unknown>(widget.allowedOriginsJson).filter(
    (value): value is string => typeof value === "string" && ORIGIN_SHAPE.test(value),
  );
}

/** The frame's `frame-ancestors`. Nobody at all unless the widget names someone. */
export function frameAncestors(
  widget: Pick<SupportChatWidget, "allowedOriginsJson" | "enabled"> | null,
): string {
  const origins = widget?.enabled ? allowedOrigins(widget) : [];
  return origins.length > 0 ? origins.join(" ") : "'none'";
}

export async function widgetForInbox(
  companyId: string,
  inboxId: string,
): Promise<SupportChatWidget | null> {
  return AppDataSource.getRepository(SupportChatWidget).findOneBy({ companyId, inboxId });
}

export async function widgetsForCompany(companyId: string): Promise<SupportChatWidget[]> {
  return AppDataSource.getRepository(SupportChatWidget).find({ where: { companyId } });
}

export type ChatWidgetPatch = {
  enabled?: boolean;
  allowedOrigins?: string[];
  title?: string;
  greeting?: string;
};

/** Turn a widget on or off, or change what it says. The row is made the first time. */
export async function saveChatWidget(args: {
  companyId: string;
  inbox: Pick<SupportInbox, "id" | "name">;
  patch: ChatWidgetPatch;
  actor: SupportActor;
}): Promise<SupportChatWidget> {
  const { companyId, inbox, patch, actor } = args;
  const repo = AppDataSource.getRepository(SupportChatWidget);
  const existing = await repo.findOneBy({ companyId, inboxId: inbox.id });
  const origins =
    patch.allowedOrigins !== undefined
      ? cleanOrigins(patch.allowedOrigins)
      : existing
        ? allowedOrigins(existing)
        : [];
  const enabled = patch.enabled ?? existing?.enabled ?? false;
  if (enabled && origins.length === 0) {
    throw new SupportValidationError("Name the site it goes on before turning the chat widget on.");
  }
  const fields: Partial<SupportChatWidget> = {
    enabled,
    allowedOriginsJson: JSON.stringify(origins),
    updatedByUserId: actor.kind === "user" ? actor.userId : null,
    ...(patch.title !== undefined ? { title: cleanWords(patch.title) } : {}),
    ...(patch.greeting !== undefined ? { greeting: cleanWords(patch.greeting) } : {}),
  };
  let widget: SupportChatWidget;
  if (existing) {
    await repo.update({ id: existing.id }, fields);
    widget = await repo.findOneByOrFail({ id: existing.id });
  } else {
    try {
      widget = await repo.save(
        repo.create({
          companyId,
          inboxId: inbox.id,
          publicKey: crypto.randomBytes(16).toString("base64url"),
          ...fields,
        }),
      );
    } catch (error) {
      // Two first saves raced; the unique index picked a row to keep.
      const raced = await repo.findOneBy({ companyId, inboxId: inbox.id });
      if (!raced) throw error;
      await repo.update({ id: raced.id }, fields);
      widget = await repo.findOneByOrFail({ id: raced.id });
    }
  }
  await recordAudit({
    companyId,
    actorKind: actor.kind === "user" ? "user" : actor.kind === "ai" ? "ai" : "system",
    actorUserId: actor.kind === "user" ? actor.userId : null,
    actorEmployeeId: actor.kind === "ai" ? actor.employeeId : null,
    action: "support_inbox.chat_widget_update",
    targetType: "support_inbox",
    targetId: inbox.id,
    targetLabel: inbox.name,
    metadata: { enabled, allowedOrigins: origins },
  });
  emitResourceChange(companyId, "support_inbox", inbox.id, { trigger: false });
  return widget;
}

/** The lines a company pastes into its site. The key is public by design. */
function embedSnippet(widget: Pick<SupportChatWidget, "publicKey">): string {
  return `<script src="${getPublicUrl()}/support-chat/loader.js" data-widget-key="${widget.publicKey}" async></script>`;
}

/** The owners' view of a widget, for an inbox that may not have one yet. */
export function serializeChatWidget(widget: SupportChatWidget | null) {
  return {
    enabled: widget?.enabled ?? false,
    allowedOrigins: widget ? allowedOrigins(widget) : [],
    title: widget?.title ?? "",
    greeting: widget?.greeting ?? "",
    defaultGreeting: DEFAULT_SUPPORT_CHAT_GREETING,
    publicKey: widget?.publicKey ?? null,
    snippet: widget ? embedSnippet(widget) : null,
  };
}

/** A key that can name a live widget. Anything else is not worth a query. */
export const CHAT_WIDGET_KEY = /^[A-Za-z0-9_-]{22}$/;

export type LiveWidget = { widget: SupportChatWidget; inbox: SupportInbox };

/**
 * The widget a page or a visitor names, if it is on. An unknown key and a widget
 * that is off are the same answer, so nothing here says which keys ever existed.
 */
export async function liveWidget(publicKey: string): Promise<LiveWidget | null> {
  if (!CHAT_WIDGET_KEY.test(publicKey)) return null;
  const widget = await AppDataSource.getRepository(SupportChatWidget).findOneBy({ publicKey });
  if (!widget?.enabled) return null;
  const inbox = await AppDataSource.getRepository(SupportInbox).findOneBy({
    id: widget.inboxId,
    companyId: widget.companyId,
  });
  return inbox ? { widget, inbox } : null;
}

/** The name replies go out under: the inbox's own, as on an email, then the company's. */
export async function chatSenderName(
  companyId: string,
  inbox: Pick<SupportInbox, "fromName"> | null,
): Promise<string> {
  if (inbox?.fromName) return inbox.fromName;
  const company = await AppDataSource.getRepository(Company).findOneBy({ id: companyId });
  return company?.name ?? "";
}

/** What any page may read about a widget that is on. */
export async function chatWidgetConfig({ widget, inbox }: LiveWidget): Promise<ChatWidgetConfig> {
  const company = await AppDataSource.getRepository(Company).findOneBy({ id: widget.companyId });
  const companyName = company?.name ?? "";
  return {
    title: widget.title || inbox.fromName || companyName,
    greeting: widget.greeting || DEFAULT_SUPPORT_CHAT_GREETING,
    companyName,
    open: inbox.status === "active",
  };
}
