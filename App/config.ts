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
  port: 4000,
  publicUrl: "http://localhost:4000",
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
} as const;
