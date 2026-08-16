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
  // Default self-host installs replace this public placeholder with a strong,
  // persistent value in data/.instance-secrets.json. Set an explicit secret
  // of at least 32 characters to take precedence. Shared multi-tenant installs
  // must always configure an explicit value.
  sessionSecret: "change-me-in-production",

  // Security posture. `multiTenant` is intentionally false for existing
  // self-hosted installs; hosted operators must turn it on. In that mode the
  // server refuses to boot unless the database, cookie, encryption, and agent
  // isolation settings below meet the shared-SaaS baseline.
  security: {
    multiTenant: false,
    // Separate from sessionSecret. Default self-host installs replace this
    // placeholder with the distinct managed encryption key stored in
    // data/.instance-secrets.json. Explicit values take precedence. New
    // ciphertexts derive a scoped key per company (or user); keep old explicit
    // values in previousEncryptionSecrets while rotating so rows stay readable.
    encryptionSecret: "change-me-in-production-too",
    previousEncryptionSecrets: [] as string[],
    // "auto" sets Secure whenever the Admin → General public URL is https,
    // and always in multi-tenant mode. Multi-tenant mode rejects false.
    secureCookies: "auto" as "auto" | boolean,
    sessionMaxAgeDays: 7,
    // Number of trusted reverse-proxy hops in front of Express. The Docker
    // deployment is normally reached through one ingress/reverse-proxy hop.
    // Set this to 0 only when Genosyn is directly reachable.
    trustedProxyHops: 1,
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
    // Fresh installs must predeclare the only email allowed to claim the first
    // master-admin account. Promotion happens only after email verification,
    // preventing an internet race during bootstrap. Existing installs that
    // already have a master admin are unaffected.
    bootstrapMasterAdminEmail: "",
  },

  // AI Employee execution controls. Coding execution is disabled by default:
  // Acknowledged `host` mode keeps path-confined file/search tools but never exposes bash: a
  // same-UID host shell could read App data, Vault encryption roots, and sibling
  // process tokens. The safe `disabled` mode supports ChatGPT subscription
  // auth without coding tools, repository materialization, or user-configured
  // stdio MCP children. Sandboxed bash and repository work are available only
  // when an operator deliberately selects `bubblewrap` on a Linux deployment
  // whose user-namespace policy passes Genosyn's probe. `host` mode permits
  // user stdio MCP and therefore rejects subscription credentials.
  // Bubblewrap runs every shell invocation and repository Git child in
  // user/mount/PID namespaces with only the employee workspace writable. Shared
  // SaaS requires bubblewrap and disables network access inside the coding
  // sandbox; networked work goes through governed Integration, browser, and
  // HTTP surfaces instead.
  agent: {
    codingTools: {
      enabled: true,
      executionMode: "disabled" as "host" | "bubblewrap" | "disabled",
      bubblewrapPath: "/usr/bin/bwrap",
      allowNetwork: false,
      // Emergency compatibility escape hatch for a trusted, single-company
      // install only. This acknowledgement enables host-mode coding tools and
      // server-owned Git work. The model tools stay path-confined, but all of
      // that work runs outside a namespace; selecting host mode alone is not
      // sufficient.
      allowUnsafeHostExecution: false,
    },
    // The current app-owned Chromium process shares the API container. Keep it
    // off in multi-tenant mode until a separately isolated browser worker is
    // configured; startup validation enforces this boundary.
    browserEnabledInMultiTenant: false,
    // Member browsers: a human connects a Chrome running on their own
    // computer, and a granted AI Employee drives that instead of the
    // container's headless Chromium. The bridge agent on their machine
    // launches a dedicated Chrome profile and relays CDP back over an
    // outbound WebSocket, so the App reaches a machine it could never dial.
    //
    // Forced off in multi-tenant mode by startup validation, and for a
    // stronger reason than the shared-container one above: a tenant would be
    // leaving a bearer-authenticated channel into a personal laptop standing
    // against shared infrastructure. Self-hosters can turn it off here too.
    memberBrowsersEnabled: true,
    // Total top-level chats + Routine runs allowed at once in one company.
    // Routines may overlap each other and chat; chats serialize per employee.
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

  // Open-web tools for AI Employees: `search_web`, `fetch_web_page`, and
  // `download_web_file` (which saves a file — a blank tax form, a price
  // list — as a chat attachment the PDF and mail tools can then use).
  //
  // Every request goes through the same outbound guard as the rest of the
  // product (`security.outbound*`): http(s) only, no credentials in the URL,
  // and every hop re-validated against private, loopback and link-local
  // addresses. Fetched pages are DATA, never instructions — the employee's
  // system prompt says so, and tool results are labelled as untrusted.
  web: {
    // Master switch. false makes all three tools refuse with an explanation
    // instead of disappearing, so an employee can tell the human why.
    enabled: true,
    // Search backend. "duckduckgo" reads DuckDuckGo's no-JavaScript HTML
    // endpoint and needs no API key or account, which is the only kind of
    // default a self-hosted install can ship. "disabled" turns search off
    // and leaves direct fetches and downloads working.
    searchProvider: "duckduckgo" as "duckduckgo" | "disabled",
    maxSearchResults: 8,
    // Bytes a page fetch or download may pull. Below the 25 MB attachment
    // cap on purpose: a blank form is kilobytes, and anything larger is
    // usually a mis-clicked link.
    maxDocumentBytes: 10 * 1024 * 1024,
    // Characters of extracted page text handed to the model per fetch.
    maxTextChars: 20_000,
  },
} as const;
