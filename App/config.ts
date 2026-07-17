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
  publicUrl: "http://localhost:8471",
  sessionSecret: "change-me-in-production",

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
  // Redirect URI to register with the provider:
  //   `${publicUrl}/api/integrations/oauth/callback/google`
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
