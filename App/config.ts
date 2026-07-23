export const config = {
  // Directory where SQLite db and per-company filesystem tree live
  dataDir: "./data",

  // Database driver — flip to "postgres" + fill url when ready
  db: {
    driver: "sqlite" as "sqlite" | "postgres",
    sqlitePath: "./data/app.sqlite",
    postgresUrl: "",
  },

  // API server
  port: 8471,
  sessionSecret: "change-me-in-production",

  // Security posture. `multiTenant` is intentionally false for existing
  // self-hosted installs; hosted operators must turn it on. In that mode the
  // server refuses to boot unless the database, cookie, encryption, and agent
  // isolation settings below meet the shared-SaaS baseline.
  security: {
    multiTenant: false,
    // Separate from sessionSecret. New ciphertexts derive a distinct key per
    // company (or per user for account secrets). Keep old values in
    // previousEncryptionSecrets while rotating so existing rows stay readable.
    encryptionSecret: "change-me-in-production-too",
    previousEncryptionSecrets: [] as string[],
    // "auto" sets Secure whenever the Admin → General public URL is https,
    // and always in multi-tenant mode. Multi-tenant mode rejects false.
    secureCookies: "auto" as "auto" | boolean,
    sessionMaxAgeDays: 7,
    // Number of trusted reverse-proxy hops in front of Express. Keep 0 when
    // Genosyn is directly reachable; the common ingress/reverse-proxy setup is 1.
    trustedProxyHops: 0,
    // Hosts in this exact, case-insensitive list may resolve to loopback,
    // private, link-local, or other non-public addresses. Leave empty for a
    // public SaaS. Add an internal hostname only when the operator explicitly
    // intends tenants to reach it.
    outboundPrivateHostAllowlist: [] as string[],
    outboundRequestTimeoutMs: 15_000,
    outboundMaxResponseBytes: 25 * 1024 * 1024,
    authRateLimit: {
      windowMinutes: 15,
      maxAttempts: 10,
      blockMinutes: 15,
    },
    // Shared SaaS must predeclare the only email allowed to claim the first
    // master-admin account. This prevents an internet race during bootstrap.
    bootstrapMasterAdminEmail: "",
  },

  // AI Employee execution controls. `bubblewrap` runs every shell invocation
  // in a Linux user/mount/PID namespace with only the employee workspace
  // writable. The runtime image includes bwrap. Shared SaaS mode requires it
  // and disables network access inside the coding sandbox; networked work goes
  // through governed Integration, browser, and HTTP surfaces instead.
  agent: {
    codingTools: {
      enabled: true,
      executionMode: "host" as "host" | "bubblewrap" | "disabled",
      bubblewrapPath: "/usr/bin/bwrap",
      allowNetwork: true,
    },
    // The current app-owned Chromium process shares the API container. Keep it
    // off in multi-tenant mode until a separately isolated browser worker is
    // configured; startup validation enforces this boundary.
    browserEnabledInMultiTenant: false,
    maxConcurrentRunsPerCompany: 4,
    // Show the model a working set of tools and let it reach the rest through
    // `find_tools` / `call_tool`, instead of sending every schema on every
    // step. Off makes every tool resident again — the model sees the whole
    // catalogue on each request, as it did before this existed. (Not identical
    // to the old on-wire size: the collapsed CRUD families are gone, so an
    // OpenAI-provider employee with many integrations could brush the 128-tool
    // cap and get trimmed — the run still works, it just isn't as lean.) Keep
    // the switch: first-turn recall is the risk this design carries, and an
    // operator who hits it needs a way back that doesn't involve a downgrade.
    toolDiscovery: {
      enabled: true,
      // Below this many tools the round-trip costs more than the schemas do.
      minCatalogueSize: 40,
    },
  },

  // Global SMTP fallback for system-level sends (password resets, invites).
  // Leave host empty to disable — reset links then log to the console instead.
  // This block is the file-based default; operators can override it at runtime
  // from Admin → Email transport (stored in the DB, takes precedence over this).
  smtp: {
    host: "",
    port: 587,
    secure: false,
    user: "",
    pass: "",
    fromName: "Genosyn",
    from: "no-reply@genosyn.local",
  },

  // Third-party Integrations.
  //
  // Each entry configures a Connection *type* (Stripe, Gmail, Metabase, …).
  // Connections themselves are per-company DB rows; this block only carries
  // the globally-shared credentials the platform needs to broker OAuth.
  //
  // API-key integrations (Stripe, Metabase) need nothing here — the user
  // pastes their key when they create a Connection and it is encrypted at
  // rest. OAuth integrations (Gmail and friends) need a shared app ID +
  // secret registered with the provider, because the user's browser
  // redirects through *our* server on its way back from Google.
  //
  // The redirect URI is shown in Settings → Integrations and follows the
  // public URL saved under Admin → General.
  integrations: {
    google: {
      // Google Cloud OAuth client — leave empty to disable Gmail etc.
      // Create one at console.cloud.google.com under APIs & Services →
      // Credentials → OAuth 2.0 Client IDs (type: Web application).
      clientId: "",
      clientSecret: "",
    },
  },

  // Email section (M25) — Gmail mailbox sync tuning.
  //
  // Sync is poll-based (no Google Pub/Sub setup required): a 30s heartbeat
  // syncs every active mailbox whose last sync is older than
  // `syncIntervalSec`. The first import walks the ENTIRE mailbox (newest
  // first) so everything is searchable locally; it is resumable and runs in
  // bounded passes so it never blocks or hammers Gmail. After the backfill
  // completes, sync is incremental via the Gmail history API.
  mail: {
    // How often an up-to-date mailbox re-checks for new mail.
    syncIntervalSec: 60,
    // Per backfill pass: stop after this many threads or this many seconds,
    // then resume on the next heartbeat. Bounds each pass's Gmail API burst.
    backfillThreadsPerPass: 200,
    backfillPassSeconds: 25,
    // Only-recent cap. 0 = import the whole mailbox (the default — the point
    // is that nothing needs Gmail). Set to e.g. 365 to limit the first import
    // to the last year on a very large account.
    backfillDays: 0,
  },
} as const;
