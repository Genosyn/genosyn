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
  Strong,
  UL,
} from "@/docs/Prose";

const CATALOG: Array<{ name: string; kind: string }> = [
  { name: "GitHub", kind: "engineering" },
  { name: "Stripe", kind: "finance" },
  { name: "Gmail / Google", kind: "comms + drive" },
  { name: "Notion", kind: "knowledge" },
  { name: "Airtable", kind: "data" },
  { name: "Linear", kind: "tickets" },
  { name: "Telegram", kind: "comms" },
  { name: "Postgres / MySQL / ClickHouse", kind: "databases" },
  { name: "Redis", kind: "cache / KV" },
  { name: "Metabase / NocoDB", kind: "BI / data" },
  { name: "Lightning (NWC + LND)", kind: "payments" },
  { name: "Nostr", kind: "social" },
  { name: "Reddit, X, LinkedIn", kind: "social" },
];

export function Integrations() {
  return (
    <>
      <PageHeader
        eyebrow="Brains & tools"
        title="Integrations"
        lead={
          <>
            An <Strong>Integration</Strong> is a connector type — Stripe,
            Gmail, GitHub, Postgres. A <Strong>Connection</Strong> is one
            authenticated account inside an integration. A <Strong>Grant</Strong>{" "}
            gives an AI employee access to one Connection.
          </>
        }
      />

      <H2 id="three-words">Three words, three rows</H2>
      <KeyList
        rows={[
          {
            term: "Integration",
            def: (
              <>
                A connector <em>type</em>, defined in code under{" "}
                <Code>server/integrations/providers/</Code>. Static catalog —
                you add one by writing a provider file, not by clicking a
                button.
              </>
            ),
          },
          {
            term: "Connection",
            def: (
              <>
                One authenticated <em>account</em> inside an integration. DB
                row (<Code>IntegrationConnection</Code>), per-company. You
                might have two Stripe connections — &quot;live&quot; and
                &quot;test&quot;.
              </>
            ),
          },
          {
            term: "Grant",
            def: (
              <>
                A row on <Code>EmployeeConnectionGrant</Code> giving one
                employee access to one connection. Without a grant, the
                employee&apos;s MCP server simply doesn&apos;t list those
                tools.
              </>
            ),
          },
        ]}
      />

      <Callout kind="info" title="Granular by design.">
        Grants are per-employee, per-connection. Your Bookkeeper gets the
        Stripe Live grant; your Brand Writer doesn&apos;t. Both employees
        share the same company, but the MCP surface they see is different.
      </Callout>

      <H2 id="how-tools-show-up">How tools show up</H2>
      <P>
        Every time the runner spawns an employee&apos;s provider CLI, it
        regenerates the MCP server list. The built-in <Code>genosyn</Code>{" "}
        server lists every integration tool the employee has a Grant for; the
        provider CLI sees a flat catalog of tools and never has to know
        anything about Connections.
      </P>

      <H2 id="catalog">What ships today</H2>
      <P>
        A non-exhaustive sampling of integrations available in the latest
        image:
      </P>
      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {CATALOG.map((c) => (
          <div
            key={c.name}
            className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white px-3 py-2 text-[13px]"
          >
            <span className="font-medium text-zinc-950">{c.name}</span>
            <span className="text-[11px] uppercase tracking-wider text-zinc-500">
              {c.kind}
            </span>
          </div>
        ))}
      </div>

      <H2 id="adding-an-integration">Adding an Integration</H2>
      <P>
        Integrations live in code: a file under{" "}
        <Code>server/integrations/providers/</Code> exports the auth flow,
        config shape, and MCP tools the integration contributes. Once
        compiled, the integration appears in the UI for{" "}
        <em>any</em> company on that instance — no per-tenant flag.
      </P>

      <H2 id="grants-and-revocation">Grants & revocation</H2>
      <UL>
        <LI>
          <Strong>Add a grant</Strong> on the employee&apos;s Connections
          page. The MCP tool list updates on next spawn.
        </LI>
        <LI>
          <Strong>Revoke a grant</Strong> the same place. The next routine
          won&apos;t see the tools.
        </LI>
        <LI>
          <Strong>Delete a Connection</Strong> at the company level. All
          dependent grants disappear with it.
        </LI>
      </UL>

      <H3 id="github-engineering">GitHub & engineering grants</H3>
      <P>
        GitHub is special: a Connection holds a list of repos the employee is
        allowed to touch, and the runner materializes a git checkout of each
        allowed repo into{" "}
        <Code>data/companies/&lt;co&gt;/employees/&lt;emp&gt;/repos/...</Code>{" "}
        before each spawn. The git token never lands on disk — it&apos;s read
        from the env var the runner injects, via a per-connection credential
        helper inside <Code>.git/genosyn-cred.sh</Code>.
      </P>

      <H3 id="lightning-payments">Lightning payments</H3>
      <P>
        The Lightning integration adds spending caps on the Connection
        itself: <Code>maxPaymentSats</Code>,{" "}
        <Code>dailyLimitSats</Code>, <Code>requireApprovalAboveSats</Code>.
        Over-cap payments queue a <Code>lightning_payment</Code>{" "}
        <DocLink to="/docs/routines">Approval</DocLink> that replays the call
        once a human ✓&apos;s it.
      </P>
    </>
  );
}
