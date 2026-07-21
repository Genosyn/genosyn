import {
  Callout,
  Code,
  DocLink,
  H2,
  KeyList,
  LI,
  OL,
  P,
  PageHeader,
  Pre,
  Strong,
  UL,
} from "@/docs/Prose";

export function SaasHosting() {
  return (
    <>
      <PageHeader
        eyebrow="Self-hosting"
        title="Shared SaaS mode"
        lead={
          <>
            Genosyn can serve many customer companies from one deployment. Shared SaaS mode turns
            the production boundaries into startup requirements, so an unsafe configuration fails
            before the server accepts traffic.
          </>
        }
      />

      <Callout kind="warn" title="This is an operator mode, not a billing system.">
        Multi-tenancy, isolation, authentication hardening, workload limits, and replica
        coordination are built in. Plans, checkout, subscriptions, tax, and customer support
        workflows are separate product decisions and are not created by this switch.
      </Callout>

      <H2 id="baseline">Required production baseline</H2>
      <P>
        Set the following values in <Code>App/config.ts</Code>. Use independently generated secrets;
        do not copy the examples into production.
      </P>
      <Pre lang="ts">{`security: {
  multiTenant: true,
  encryptionSecret: "<independent 32+ character random secret>",
  previousEncryptionSecrets: [],
  secureCookies: "auto",
  sessionMaxAgeDays: 7,
  trustedProxyHops: 1,
  outboundPrivateHostAllowlist: [],
  outboundRequestTimeoutMs: 15_000,
  outboundMaxResponseBytes: 25 * 1024 * 1024,
  authRateLimit: { windowMinutes: 15, maxAttempts: 10, blockMinutes: 15 },
  bootstrapMasterAdminEmail: "operator@example.com",
},
agent: {
  codingTools: {
    enabled: true,
    executionMode: "bubblewrap",
    bubblewrapPath: "/usr/bin/bwrap",
    allowNetwork: false,
  },
  browserEnabledInMultiTenant: false,
  maxConcurrentRunsPerCompany: 4,
},
db: {
  driver: "postgres",
  sqlitePath: "",
  postgresUrl: "postgresql://…",
},
publicUrl: "https://app.example.com",
sessionSecret: "<different 32+ character random secret>",`}</Pre>
      <P>
        A working global SMTP transport is also mandatory because new Members must verify their
        email and account recovery must reach a mailbox. Configure{" "}
        <Strong>Admin → Email transport</Strong> or the <Code>smtp</Code> block before enabling
        shared SaaS mode.
      </P>

      <H2 id="startup">What startup checks</H2>
      <UL>
        <LI>Postgres is selected and has a connection URL.</LI>
        <LI>The public URL is HTTPS and session cookies are Secure.</LI>
        <LI>The session-signing and encryption secrets are strong and different.</LI>
        <LI>
          The Bubblewrap binary exists, shell networking is off, and the shared browser is off.
        </LI>
        <LI>No private outbound hostname exception is configured.</LI>
        <LI>A bootstrap operator email and system SMTP transport are configured.</LI>
      </UL>
      <P>
        If any check fails, Genosyn exits with the exact unsafe setting instead of silently starting
        in a partial posture.
      </P>

      <H2 id="tenancy">Tenant and identity boundaries</H2>
      <KeyList
        rows={[
          {
            term: "Company scope",
            def: "Every customer resource is selected through a verified Membership and company id. API keys are bound to one company.",
          },
          {
            term: "Roles",
            def: "Members can collaborate; owner/admin roles control sensitive configuration. Owners promote, demote, and remove Members in Settings. Removal revokes company API keys and clears private Channel and Project membership.",
          },
          {
            term: "Email ownership",
            def: "Hosted Members verify a single-use, hashed email token before creating a company or accepting an invitation. The signed-in email must match the invitation.",
          },
          {
            term: "Two factor",
            def: "A company owner or admin can require 2FA for every Member. Genosyn prevents a Member from removing their final method while any company requires it.",
          },
          {
            term: "Sessions",
            def: "Password changes and resets increment a server-side session version, invalidating every older signed cookie across replicas.",
          },
        ]}
      />

      <H2 id="execution">AI execution isolation</H2>
      <P>
        Each AI employee&apos;s shell runs inside a Bubblewrap user, mount, PID, IPC, UTS, cgroup,
        and network namespace. Only that employee&apos;s workspace is writable; the API process
        environment is not inherited. File tools resolve real paths and reject symlink escapes. The
        hosted runtime also serializes work per AI employee and caps concurrent AI work per company.
      </P>
      <UL>
        <LI>Company secrets are not injected into hosted coding shells.</LI>
        <LI>Arbitrary stdio MCP servers are not started in shared SaaS mode.</LI>
        <LI>
          The app-owned Chromium browser is unavailable until it moves to a separately isolated
          browser worker. See <DocLink to="/docs/browser">Browser</DocLink> for self-hosted mode.
        </LI>
      </UL>

      <H2 id="network">Outbound network policy</H2>
      <P>
        URL ingestion, Pipeline HTTP nodes, AI Model endpoints, MCP endpoints, and configurable
        Connection hosts reject loopback, private, link-local, carrier-grade NAT, documentation,
        multicast, and reserved addresses. Every redirect is rechecked, responses are bounded, and
        DNS is checked again at socket connection time to stop rebinding attacks. Keep a cloud
        egress firewall that blocks metadata and private ranges as defense in depth.
      </P>
      <P>
        Raw-TCP Postgres, MySQL, and Redis Connections and arbitrary Code Repository remotes are
        disabled in shared SaaS mode until they can run in a dedicated egress worker. Fixed-host
        GitHub checkouts remain available through a granted GitHub Connection.
      </P>

      <H2 id="replicas">Running more than one replica</H2>
      <P>
        Postgres stores OAuth/OIDC/WebSocket handshake state, scheduler leases, workload leases, and
        short-lived realtime fan-out records. Recurring work elects one replica, pending mail
        handovers are claimed atomically, Telegram listeners fail over, and Postgres
        <Code>LISTEN/NOTIFY</Code> carries authorized WebSocket events between replicas.
      </P>
      <UL>
        <LI>
          Mount the same <Code>dataDir</Code> on every replica with ReadWriteMany storage. Uploaded
          files and employee working trees still live there.
        </LI>
        <LI>
          Use one migration job or allow the first replica to apply migrations before rollout.
        </LI>
        <LI>Forward WebSocket upgrades and preserve the original HTTPS origin at the ingress.</LI>
        <LI>
          Use a managed Postgres backup and back up the shared data volume separately.
          Genosyn&apos;s built-in SQLite archive and restore surface is disabled in shared SaaS
          mode.
        </LI>
      </UL>

      <H2 id="launch">Launch checklist</H2>
      <OL>
        <LI>Start with an empty Postgres database and let the Postgres migration stream apply.</LI>
        <LI>Configure HTTPS, trusted proxy hops, strong secrets, SMTP, and the bootstrap email.</LI>
        <LI>
          Run the container with Bubblewrap/user namespaces available and shell network disabled.
        </LI>
        <LI>Create the operator account using the exact bootstrap email, then verify it.</LI>
        <LI>
          Test signup, verification, password reset, invitation matching, role denial, and 2FA.
        </LI>
        <LI>Test two concurrent companies and at least two replicas against shared storage.</LI>
        <LI>
          Keep database, volume, ingress, SMTP, and model-provider monitoring outside the app.
        </LI>
      </OL>
    </>
  );
}
