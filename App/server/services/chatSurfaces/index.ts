/**
 * External chat surfaces (M59) — talking to an AI Employee without opening
 * Genosyn.
 *
 * Public entry points only. `server/index.ts` boots the long-running
 * transports; `services/integrations.ts` calls the refresh hook whenever a
 * Connection row changes.
 */
export {
  bootChatSurfaceWorkers,
  refreshChatSurfaceWorker,
  stopChatSurfaceWorkers,
  activeChatSurfaceWorkerIds,
} from "./workers.js";
export { handleInboundTurn, resolveResponder, MAX_REPLAY_TURNS } from "./inbound.js";
export {
  getChatSurfaceAdapter,
  listChatSurfaceAdapters,
  listLongRunningAdapters,
  listWebhookAdapters,
} from "./adapters.js";
export type {
  BindOutcome,
  BindPreview,
  ChatSurfaceRequester,
  ExternalChatIdentitySummary,
} from "./identity.js";
export {
  bindIdentity,
  previewBind,
  listIdentities,
  mintBindLink,
  recordSighting,
  resolveBoundRequester,
  unbindIdentity,
  deleteIdentitiesForConnection,
  BIND_LINK_TTL_MS,
} from "./identity.js";
export {
  CHAT_SURFACE_PROVIDER_IDS,
  isChatSurfaceProvider,
  truncateForSurface,
} from "./types.js";
export type {
  ChatSurfaceAdapter,
  ChatSurfaceProviderId,
  ChatSurfaceReplyTarget,
  InboundChatTurn,
} from "./types.js";
