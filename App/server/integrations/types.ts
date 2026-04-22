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

export type IntegrationAuthMode = "apikey" | "oauth2";

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

/** Metadata the UI needs to render the catalog + the "add connection" form. */
export type IntegrationCatalogEntry = {
  /** Stable id — matches `IntegrationConnection.provider`. */
  provider: string;
  /** Display name, e.g. "Stripe". */
  name: string;
  /** One-line pitch shown on the catalog card. */
  tagline: string;
  /** Longer description for the add-connection page. */
  description?: string;
  /** Lucide icon name to render on the catalog card. */
  icon: string;
  authMode: IntegrationAuthMode;
  /** API-key providers declare their input form here. */
  fields?: IntegrationCatalogField[];
  /** OAuth providers declare their scopes + underlying oauth app here. */
  oauth?: {
    /** Identifies which shared OAuth app in config.integrations.* to use. */
    app: "google";
    scopes: string[];
    /** Link to docs explaining how to register the app. */
    setupDocs?: string;
  };
  /** Whether this integration can be used right now (e.g. OAuth app configured). */
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
   * config blob. The caller already has access+refresh tokens and (if the
   * provider returns one) a userinfo payload.
   */
  buildOauthConfig?(args: {
    tokens: OauthTokenSet;
    userInfo: Record<string, unknown>;
  }): { config: IntegrationConfig; accountHint: string };

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
