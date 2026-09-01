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
        Multi-tenancy, isolation, authentication hardening, and replica coordination are built in.
        Plans, checkout, subscriptions, tax, and customer support workflows are separate product
        decisions and are not created by this switch.
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
    allowUnsafeHostExecution: false,
  },
  browserEnabledInMultiTenant: false,
},
db: {
  driver: "postgres",
  sqlitePath: "",
  postgresUrl: "postgresql://…",
},
sessionSecret: "<different 32+ character random secret>",`}</Pre>
      <P>
        Those are the boot settings — the whole of <Code>config.ts</Code> that matters here.
        Operational settings are not in the file at all; they live in the database and are edited at{" "}
        <Strong>Admin → Runtime</Strong> without a restart. Shared SaaS still forces the isolation
        boundaries regardless of what is saved there: member browsers are refused in multi-tenant
        mode even when the setting is on.
      </P>
      <P>
        A working global SMTP transport is effectively mandatory because new Members must verify
        their email and account recovery must reach a mailbox. It is <em>not</em> a boot requirement
        — a fresh install has no database row and no operator yet, so boot warns loudly and writes
        system mail to the server log rather than refusing to start. That is how the bootstrap
        operator claims the first account. Configure <Strong>Admin → Email transport</Strong>{" "}
        immediately afterwards, before inviting anyone else;{" "}
        <Strong>Admin → Instance Health</Strong> keeps flagging the transport until you do.
      </P>
      <P>
        On the first operator sign-in, Genosyn detects the same-origin browser URL. Review and save
        the canonical HTTPS origin at <Strong>Admin → General</Strong> before configuring SSO,
        WebAuthn, or OAuth integrations. It is stored in Postgres and propagated across replicas.
      </P>

      <H2 id="startup">What startup checks</H2>
      <UL>
        <LI>Postgres is selected and has a connection URL.</LI>
        <LI>Session cookies are Secure.</LI>
        <LI>The session-signing and encryption secrets are strong and different.</LI>
        <LI>
          The Bubblewrap binary exists, shell networking is off, and the shared browser is off.
        </LI>
        <LI>No private outbound hostname exception is configured.</LI>
        <LI>A bootstrap operator email is configured.</LI>
      </UL>
      <P>
        If any check fails, Genosyn exits with the exact unsafe setting instead of silently starting
        in a partial posture. The system SMTP transport is the one exception: it is checked at boot
        but only warned about, because the dashboard that configures it has to be reachable first.
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
            def: "A company owner or admin can require 2FA for every Member. Master admins must always enroll and complete a second factor to use the hosted operator control plane, and must sign in again after 15 minutes before another operator action.",
          },
          {
            term: "Sessions",
            def: "Password changes and resets increment a server-side session version, invalidating every older signed cookie across replicas.",
          },
        ]}
      />

      <H2 id="execution">AI execution isolation</H2>
      <P>
        Each AI Employee&apos;s shell runs inside Bubblewrap user, mount, PID, IPC, UTS, and network
        namespaces, plus a cgroup namespace where the kernel supports it. Only that employee&apos;s
        workspace is writable; the API process environment is not inherited. File tools resolve real
        paths and reject symlink escapes. Top-level AI work, including Routine runs and chat, can
        overlap without an application-level per-company cap. One AI Employee replies to each of
        their chat threads in parallel; only two replies in the same thread are serialized.
      </P>
      <Callout kind="warn" title="Plan capacity at the deployment and AI Model layers.">
        Genosyn does not queue or cap top-level work by company. Provision enough replicas, CPU,
        memory, and database capacity for the overlap your customers can create, and monitor each AI
        Model provider&apos;s concurrency, token, spend, and rate limits. Provider-side throttling
        still applies.
      </Callout>
      <UL>
        <LI>Company secrets are not injected into hosted coding shells.</LI>
        <LI>Arbitrary stdio MCP servers are not started in shared SaaS mode.</LI>
        <LI>
          The app-owned browser is unavailable until it moves to a separately isolated browser
          worker. See <DocLink to="/docs/browser">Browser</DocLink> for self-hosted mode.
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
        Raw-TCP Postgres and MySQL Connections and arbitrary Repository remotes are disabled in
        shared SaaS mode until they can run in a dedicated egress worker. Fixed-host GitHub
        checkouts remain available through a granted GitHub Connection.
      </P>

      <H2 id="replicas">Running more than one replica</H2>
      <P>
        Postgres stores OAuth/OIDC/WebSocket handshake state, scheduler leases, same-AI-Employee
        chat-reply leases, and short-lived realtime fan-out records. Recurring work elects one
        replica, pending mail handovers are claimed atomically, Telegram listeners fail over, and
        Postgres <Code>LISTEN/NOTIFY</Code> carries authorized WebSocket events between replicas.
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
        <LI>Configure HTTPS, trusted proxy hops, strong secrets, and the bootstrap email.</LI>
        <LI>
          Run the container with Bubblewrap/user namespaces available and shell network disabled.
        </LI>
        <LI>
          Create the operator account using the exact bootstrap email, then verify it. With no
          transport configured yet, that verification link is written to the server log — copy it
          from there, or reissue one with <Strong>Resend verification email</Strong> at{" "}
          <Strong>Account → Profile</Strong>. The account is not a master admin and cannot reach
          operator APIs before the verification succeeds; verification revokes the pre-verification
          session, so sign in again.
        </LI>
        <LI>
          Configure the system SMTP transport at <Strong>Admin → Email transport</Strong> and send
          the test message, before inviting anyone else. Until this passes, no other Member can
          verify an address or recover a password.
        </LI>
        <LI>
          Enroll an authenticator, passkey, or security key, then sign in again with that factor to
          unlock the operator control plane.
        </LI>
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
