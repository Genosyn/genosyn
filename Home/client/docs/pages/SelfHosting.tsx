import {
  Callout,
  Code,
  DocLink,
  H2,
  H3,
  KeyList,
  LI,
  P,
  PageHeader,
  Pre,
  Strong,
  UL,
} from "@/docs/Prose";

export function SelfHosting() {
  return (
    <>
      <PageHeader
        eyebrow="Self-hosting"
        title="Configuration"
        lead={
          <>
            One file: <Code>App/config.ts</Code>. No <Code>.env</Code>, no YAML
            stack, no secret loader. Self-hosters edit one TypeScript object
            with commented JSON shape — and that&apos;s the whole story.
          </>
        }
      />

      <Callout kind="warn" title="No .env, ever.">
        Genosyn doesn&apos;t use <Code>dotenv</Code>, per-environment files, or
        a config service. If a tutorial or PR adds one, it&apos;s wrong. There
        is one config object; users override values in-place.
      </Callout>

      <H2 id="config-ts">config.ts</H2>
      <P>
        The shape, with the same comments you&apos;ll see in the file:
      </P>
      <Pre lang="ts">{`export const config = {
  // Where all user-generated data lives.
  dataDir: "./data",

  db: {
    // "sqlite" (default) or "postgres".
    driver: "sqlite",
    sqlitePath: "./data/app.sqlite",
    postgresUrl: "",
  },

  // HTTP port + the URL the app should think it lives at.
  port: 8471,
  publicUrl: "http://localhost:8471",

  // 32+ random bytes. Rotate to log everyone out.
  sessionSecret: "change-me-in-production",

  // Global SMTP fallback. Per-company EmailProvider rows take precedence.
  smtp: {
    host: "", port: 587, secure: false,
    user: "", pass: "",
    from: "Genosyn <no-reply@genosyn.local>",
  },

  // OAuth client credentials for integrations that need them.
  integrations: {
    google: { clientId: "", clientSecret: "" },
    // ...
  },
} as const;`}</Pre>

      <H2 id="db-driver">Switching to Postgres</H2>
      <P>
        Genosyn ships on SQLite by default — single file, zero install. To
        switch to Postgres, flip the driver and point at a connection URL:
      </P>
      <Pre lang="ts">{`db: {
  driver: "postgres",
  sqlitePath: "",
  postgresUrl: "postgresql://user:pass@host:5432/genosyn",
},`}</Pre>
      <P>
        All entities and migrations work on both drivers. On startup Genosyn
        calls <Code>AppDataSource.runMigrations()</Code> — any pending
        migrations apply automatically.
      </P>

      <H2 id="data-dir">The data directory</H2>
      <P>
        Everything user-generated — the SQLite file, employee credentials,
        materialized git checkouts, MCP configs, uploaded attachments — lives
        under <Code>dataDir</Code>:
      </P>
      <pre className="mt-4 overflow-x-auto rounded-xl border border-zinc-200 bg-zinc-50 px-5 py-4 font-mono text-[12.5px] leading-[1.7] text-zinc-700">
        {`data/
├── app.sqlite
└── companies/<co-slug>/employees/<emp-slug>/
    ├── .claude/   .codex/   .opencode/   .goose/   .openclaw/
    ├── .mcp.json
    ├── repos/<owner>/<name>/
    └── ...`}
      </pre>
      <P>
        In the Docker image, this is mounted at <Code>/app/data</Code>. The
        installer maps a named volume <Code>genosyn-data</Code> there — back
        that volume up and you&apos;ve backed up everything.
      </P>

      <H2 id="email">Email</H2>
      <P>
        Email transport is per-company: every <Code>Company</Code> can have one
        or more <Code>EmailProvider</Code> rows. Supported transports today:
      </P>
      <UL>
        <LI>
          <Strong>SMTP</Strong> via <Code>nodemailer</Code>.
        </LI>
        <LI>
          <Strong>SendGrid</Strong>, <Strong>Mailgun</Strong>,{" "}
          <Strong>Resend</Strong>, <Strong>Postmark</Strong> — REST-based,
          paste an API key.
        </LI>
      </UL>
      <P>
        System-level sends (password resets, invites, welcomes) and any company
        without its own provider fall back to a single{" "}
        <Strong>global SMTP transport</Strong>. Configure it in the app at{" "}
        <Code>Admin → Email transport</Code>: fill in the host, port, encryption,
        username, password, and from-address, then use{" "}
        <Code>Send test</Code> to confirm deliverability. The settings are stored
        in the database and take effect immediately — no restart. Until it&apos;s
        configured, the <Code>Admin → Overview</Code> and{" "}
        <Code>Instance Health</Code> dashboards flag Email transport with a
        warning, because those system emails only log to the server console and
        never reach a mailbox.
      </P>
      <P>
        A file-based default also exists: the <Code>smtp</Code> block in{" "}
        <Code>config.ts</Code>. The dashboard override takes precedence over it;
        clearing the override (the <Code>Reset</Code> button) reverts to whatever{" "}
        <Code>config.ts</Code> provides, and if that&apos;s blank too, to the
        console. When a global transport is configured either way, adding a
        company SMTP provider at <Code>Settings → Email</Code> pre-fills the host,
        port, encryption, username, and from-address from it — you only enter the
        password. Every send appends an <Code>EmailLog</Code> row you can read at{" "}
        <Code>Settings → Email Logs</Code>.
      </P>

      <H2 id="secrets">Secrets</H2>
      <P>
        Three places store secrets, each for a different lifecycle:
      </P>
      <KeyList
        rows={[
          {
            term: "sessionSecret",
            def: (
              <>
                In <Code>config.ts</Code>. Used to sign cookies. Rotating it
                invalidates every session.
              </>
            ),
          },
          {
            term: "Connection config",
            def: (
              <>
                Encrypted per-Connection blobs on{" "}
                <Code>IntegrationConnection.encryptedConfig</Code>{" "}
                (AES-256-GCM). Decrypted at tool-call time.
              </>
            ),
          },
          {
            term: "Secret entity",
            def: (
              <>
                Free-form encrypted key/value pairs scoped to a company,
                editable from <Code>Settings → Secrets</Code>. Surfaced to
                Pipelines.
              </>
            ),
          },
        ]}
      />

      <H2 id="admin">Admin &amp; instance health</H2>
      <P>
        Install-wide operations live under the <Code>Admin</Code> section
        (top-nav section menu, or your avatar menu → <Code>Admin</Code>) —
        separate from a single company&apos;s <Code>Settings</Code>. It covers
        every company on the deployment, so any signed-in member can reach it;
        on a self-hosted box you control access by controlling who can sign in.
      </P>
      <UL>
        <LI>
          <Strong>Overview</Strong> — an at-a-glance dashboard: instance health
          status, the running version and build, database driver, uptime and
          memory, and an inventory of companies, members, and AI employees.
        </LI>
        <LI>
          <Strong>Instance Health</Strong> — live probes of the deployment
          substrate: database connectivity and round-trip latency, pending
          schema migrations, a writable data directory, the backup story, and
          the email + Web Push transports. This is distinct from a company&apos;s{" "}
          <Code>Settings → System Health</Code>, which watches that
          company&apos;s routines, models, and integrations.
        </LI>
        <LI>
          <Strong>Email transport</Strong> — configure the install-wide global
          SMTP server for system emails (password resets, invites), with a test
          send. See <Code>Email</Code> above.
        </LI>
        <LI>
          <Strong>Backups</Strong> — see below.
        </LI>
      </UL>

      <H2 id="backups">Backups</H2>
      <P>
        A backup zips the <em>entire</em> data directory — every company&apos;s
        rows, uploads, and credentials — so it is install-wide, not per company.
        Run one from the CLI:
      </P>
      <Pre lang="bash">{`genosyn backup --out ~/backups/genosyn-$(date +%F).tar.gz
genosyn restore ~/backups/genosyn-2026-04-22.tar.gz`}</Pre>
      <P>
        Or drive it in-app at <Code>Admin → Backups</Code>: back up now, upload
        an existing <Code>.zip</Code> to restore from, download or restore any
        past archive, and set a recurring schedule (daily / weekly / monthly at
        a chosen hour) backed by the <Code>BackupSchedule</Code> row. See{" "}
        <DocLink to="/docs/cli">CLI reference</DocLink> for the flag list.
      </P>

      <H2 id="upgrading">Upgrading</H2>
      <P>
        <Code>genosyn upgrade</Code> pulls the latest image and recreates the
        container, preserving the data volume. Or rerun the installer:
      </P>
      <Pre lang="bash">{`curl -fsSL https://genosyn.com/install.sh | bash`}</Pre>

      <H3 id="ports-and-reverse-proxies">Ports and reverse proxies</H3>
      <P>
        The container listens on <Code>8471</Code>. Stick a reverse proxy
        (Caddy, nginx, Traefik) in front of it for TLS and a real hostname.
        Update <Code>publicUrl</Code> in <Code>config.ts</Code> so the app
        generates absolute links correctly (invite emails, OAuth callbacks).
      </P>
    </>
  );
}
