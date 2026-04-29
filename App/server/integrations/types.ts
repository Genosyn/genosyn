/**
 * Shared types for the Integrations framework.
 *
 * An **Integration** is a connector type (Stripe, Gmail, Metabase, …). Each
 * one is implemented as a single module under `providers/` that exports an
 * `IntegrationProvider`. Providers are registered in `index.ts`.
 *
 * A **Connection** is an authenticated account inside an integration — the
 * runtime instance. Connections live in the DB (`IntegrationConnection`);
 * providers themselves are purely code.
 *
 * A **Grant** is an `AIEmployee → Connection` binding. When an employee is
 * spawned, the built-in `genosyn` MCP server lists one tool per grant × per
 * tool the provider exposes, and routes calls back through the internal HTTP
 * surface to this module's `invokeTool` hook.
 */

export type IntegrationAuthMode = "apikey" | "oauth2" | "service_account";

/**
 * High-level grouping for the catalog UI. The order here is the order
 * sections are rendered in. Adding a new value here is a UI-visible change —
 * pick an existing one if you can.
 */
export type IntegrationCategory =
  | "Databases"
  | "Analytics"
  | "Productivity"
  | "Payments"
  | "Developer";

export const INTEGRATION_CATEGORY_ORDER: IntegrationCategory[] = [
  "Databases",
  "Analytics",
  "Productivity",
  "Payments",
  "Developer",
];

/** A single form field collected during Connection creation (API-key mode). */
export type IntegrationCatalogField = {
  key: string;
  label: string;
  type: "text" | "password" | "url";
  placeholder?: string;
  required: boolean;
  /** Short hint rendered under the input. */
  hint?: string;
};

/**
 * A user-pickable bundle of provider scopes — e.g. "Mail" maps to
 * `gmail.modify` + `gmail.settings.basic`. Lets the connect/reconnect UI
 * show a short checkbox list ("Mail", "Calendar", "Drive") instead of
 * leaking raw OAuth URL strings into the form.
 */
export type IntegrationScopeGroup = {
  /** Stable id (e.g. "mail", "calendar"). Persisted on the Connection. */
  key: string;
  /** Display name (e.g. "Gmail"). */
  label: string;
  /** Short blurb shown next to the checkbox. */
  description: string;
  /** Underlying provider scope URLs this group includes. */
  scopes: string[];
  /** When true, the checkbox is locked on. */
  required?: boolean;
  /** When true, only Workspace accounts (not personal `@gmail.com`) can
   * grant this group. Surfaced as a small hint in the UI. */
  workspaceOnly?: boolean;
};

/** Metadata the UI needs to render the catalog + the "add connection" form. */
export type IntegrationCatalogEntry = {
  /** Stable id — matches `IntegrationConnection.provider`. */
  provider: string;
  /** Display name, e.g. "Stripe". */
  name: string;
  /** Section the catalog UI groups this entry under. */
  category: IntegrationCategory;
  /** One-line pitch shown on the catalog card. */
  tagline: string;
  /** Longer description for the add-connection page. */
  description?: string;
  /** Lucide icon name to render on the catalog card. */
  icon: string;
  /** Primary auth mode the connect button defaults to. */
  authMode: IntegrationAuthMode;
  /** API-key providers declare their input form here. */
  fields?: IntegrationCatalogField[];
  /** OAuth providers declare scopes + underlying oauth app. Each Connection
   * supplies its own `clientId` + `clientSecret` at create-time, so this
   * block is purely metadata for the connect form. */
  oauth?: {
    app: "google";
    /** Always-included baseline scopes (e.g. `userinfo.email` + `openid`
     * for OpenID Connect identity). Cannot be unchecked. */
    scopes: string[];
    /** Optional, user-pickable scope bundles. The UI shows these as
     * checkboxes; the resolved scope URLs are added to `scopes` at
     * authorise time. */
    scopeGroups?: IntegrationScopeGroup[];
    /** Link to docs explaining how to register the app. */
    setupDocs?: string;
  };
  /** When set, this integration also accepts a service-account credential.
   * The connect modal renders a second tab for it. */
  serviceAccount?: {
    /** Always-included baseline scopes the SA token will be minted with. */
    scopes: string[];
    /** Optional, user-pickable scope bundles for SA tokens. */
    scopeGroups?: IntegrationScopeGroup[];
    /** When true, the connect form asks for an `impersonationEmail` so the
     * SA can act on a Workspace user's behalf via domain-wide delegation. */
    impersonation: boolean;
    setupDocs?: string;
  };
  /** Whether this integration can be used right now. With the move to
   * per-Connection credentials, OAuth integrations are always enabled —
   * the user supplies clientId/secret per Connection. */
  enabled: boolean;
  /** When `enabled=false`, why. Rendered on the card. */
  disabledReason?: string;
};

/** One AI-employee-callable tool that the provider exposes per connection. */
export type IntegrationTool = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: boolean;
  };
};

/** The JSON blob stored inside `IntegrationConnection.encryptedConfig`. */
export type IntegrationConfig = Record<string, unknown>;

/** Runtime context handed to a tool handler. */
export type IntegrationRuntimeContext = {
  /** Auth mode of the Connection — providers that support multiple modes
   * (e.g. Google's OAuth + service account) dispatch on this. */
  authMode: IntegrationAuthMode;
  /** Decrypted config — provider shape. */
  config: IntegrationConfig;
  /**
   * Providers that refresh tokens call this with the new config; the caller
   * will re-encrypt and persist it before returning to the AI employee.
   */
  setConfig?(next: IntegrationConfig): void;
};

export type OauthTokenSet = {
  accessToken: string;
  refreshToken?: string;
  /** ms epoch when accessToken expires. */
  expiresAt?: number;
  scope?: string;
  tokenType?: string;
};

export type IntegrationProvider = {
  catalog: IntegrationCatalogEntry;
  tools: IntegrationTool[];

  /**
   * API-key providers implement this. Return the JSON config to persist and
   * the short "account hint" string that appears next to the connection in
   * the UI (e.g. "acct_1Abcd…XyZ9" or a masked key suffix).
   *
   * Throw an `Error` with a user-friendly message if validation fails — the
   * error's `message` is returned directly to the UI.
   */
  validateApiKey?(
    input: Record<string, string>,
  ): Promise<{ config: IntegrationConfig; accountHint: string }>;

  /**
   * OAuth providers call this after the handshake to hand back the final
   * config blob. The caller already has access+refresh tokens, the OAuth
   * client credentials (so the provider can refresh later), the
   * scope-group keys the user picked at start time, and (if the provider
   * returns one) a userinfo payload.
   */
  buildOauthConfig?(args: {
    tokens: OauthTokenSet;
    userInfo: Record<string, unknown>;
    clientId: string;
    clientSecret: string;
    scopeGroups: string[];
  }): { config: IntegrationConfig; accountHint: string };

  /**
   * Service-account providers implement this. Receives the parsed JSON key
   * file, optional impersonation email, and the scope-group keys the user
   * picked. Returns the persisted config blob. Throw with a user-friendly
   * message if the JSON shape is invalid or the user picked no groups.
   */
  buildServiceAccountConfig?(args: {
    keyJson: Record<string, unknown>;
    impersonationEmail?: string;
    scopeGroups: string[];
  }): Promise<{ config: IntegrationConfig; accountHint: string }>;

  /**
   * Cheap read-only health check. Called on demand from the UI and when the
   * connection is first created; never called automatically on every tool
   * invocation (we want tool calls to be fast).
   */
  checkStatus?(
    ctx: IntegrationRuntimeContext,
  ): Promise<{ ok: boolean; message?: string }>;

  /** Run one tool. Return any JSON-serializable value. */
  invokeTool(
    name: string,
    args: unknown,
    ctx: IntegrationRuntimeContext,
  ): Promise<unknown>;
};
