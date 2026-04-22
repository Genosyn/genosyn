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

  // SMTP — leave host empty to disable; reset links log to console instead
  smtp: {
    host: "",
    port: 587,
    secure: false,
    user: "",
    pass: "",
    from: "Genosyn <no-reply@genosyn.local>",
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
} as const;
