import { telegramChatSurface } from "./telegram.js";
import { slackChatSurface } from "./slack.js";
import { microsoftTeamsChatSurface } from "./microsoftTeams.js";
import { whatsappChatSurface } from "./whatsapp.js";
import type { ChatSurfaceAdapter, ChatSurfaceProviderId } from "./types.js";

/**
 * The adapter registry.
 *
 * Kept in its own module, separate from the worker lifecycle, so the import
 * graph stays acyclic: `inbound.ts` needs an adapter to send its reply, and
 * `workers.ts` needs `inbound.ts` to deliver a turn. Both reach adapters
 * through here, and adapters import nothing but `types.ts`.
 */
const ADAPTERS: Record<ChatSurfaceProviderId, ChatSurfaceAdapter> = {
  telegram: telegramChatSurface,
  slack: slackChatSurface,
  "microsoft-teams": microsoftTeamsChatSurface,
  whatsapp: whatsappChatSurface,
};

/**
 * Test-only substitutions, consulted first.
 *
 * `inbound.ts` reaches an adapter to deliver its reply, so a test of the
 * inbound rules would otherwise have to let a real Slack or Telegram call
 * leave the machine. Same seam, same naming, and same reason as
 * `setTouchDrafter` in the Revenue tick: a module that owns a decision should
 * be testable without dragging the network behind it.
 */
const OVERRIDES = new Map<string, ChatSurfaceAdapter>();

export function setChatSurfaceAdapterForTests(
  provider: ChatSurfaceProviderId,
  adapter: ChatSurfaceAdapter | null,
): void {
  if (adapter) OVERRIDES.set(provider, adapter);
  else OVERRIDES.delete(provider);
}

export function clearChatSurfaceAdapterOverridesForTests(): void {
  OVERRIDES.clear();
}

export function getChatSurfaceAdapter(provider: string): ChatSurfaceAdapter | null {
  return OVERRIDES.get(provider) ?? (ADAPTERS as Record<string, ChatSurfaceAdapter>)[provider] ?? null;
}

export function listChatSurfaceAdapters(): ChatSurfaceAdapter[] {
  return Object.values(ADAPTERS);
}

/** Adapters that hold a connection open and therefore need a worker + lease. */
export function listLongRunningAdapters(): ChatSurfaceAdapter[] {
  return listChatSurfaceAdapters().filter((adapter) => typeof adapter.run === "function");
}

/** Adapters driven by an inbound HTTP route instead of a loop. */
export function listWebhookAdapters(): ChatSurfaceAdapter[] {
  return listChatSurfaceAdapters().filter((adapter) => adapter.transport === "webhook");
}
