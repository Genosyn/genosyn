import {
  Callout,
  Code,
  DocLink,
  H2,
  H3,
  KeyList,
  LI,
  OL,
  P,
  PageHeader,
  Pre,
  Strong,
  UL,
} from "@/docs/Prose";

export function Signals() {
  return (
    <>
      <PageHeader
        eyebrow="Revenue"
        title="Signals"
        lead={
          <>
            A <Strong>Signal</Strong> is a saved query over your own product database plus a rule for
            what to do with the rows that come back. Your database already knows who is about to
            churn, who just hit a seat limit, and whose trial ends on Thursday — this is how that
            turns into a contact, a deal, a sequence enrolment, or an AI employee doing something
            about it. Find it under <Code>Revenue → Signals</Code>.
          </>
        }
      />

      <H2 id="create">Creating one</H2>
      <OL>
        <LI>
          <Code>Revenue → Signals → New signal</Code>. Name it after the condition, not the action —{" "}
          <Code>Trial ending in 3 days</Code> reads better on a timeline than{" "}
          <Code>Enrol trial users</Code>.
        </LI>
        <LI>
          Pick the <Strong>Connection</Strong> to run against: any Postgres, MySQL or ClickHouse
          connection you have added under{" "}
          <DocLink to="/docs/integrations">Settings → Integrations</DocLink>, the same ones{" "}
          <DocLink to="/docs/explore">Explore</DocLink> uses.
        </LI>
        <LI>
          Write the <Strong>query</Strong>, and map its columns (below).
        </LI>
        <LI>
          Press <Strong>Test</Strong> and look at the rows before you go any further.
        </LI>
        <LI>
          Set the <Strong>schedule</Strong> — a standard 5-field cron, validated against the
          scheduler that will run it, exactly as on a{" "}
          <DocLink to="/docs/routines">Routine</DocLink>. Hourly is a sane starting point.
        </LI>
        <LI>
          Choose the <Strong>action</Strong>, then flip <Strong>Enabled</Strong> on.
        </LI>
      </OL>

      <H2 id="query">Writing the query</H2>
      <P>
        The query should return <Strong>one row per thing you want to act on</Strong>, and each row
        should carry the columns the action needs. Keep it narrow: a signal that matches 500 accounts
        on a single tick is a misconfigured query, not an alert.
      </P>
      <Pre lang="sql">{`SELECT
  a.id            AS account_id,
  u.email         AS email,
  a.domain        AS domain,
  a.plan_mrr_cents AS amount
FROM accounts a
JOIN users u ON u.id = a.owner_user_id
WHERE a.trial_ends_at BETWEEN now() AND now() + interval '3 days'
  AND a.converted_at IS NULL
ORDER BY a.plan_mrr_cents DESC`}</Pre>
      <P>Then map the columns:</P>
      <KeyList
        rows={[
          {
            term: "Dedupe key",
            def: (
              <>
                The column identifying <em>the subject</em> of the row — an account id, a
                subscription id, an email. Required in practice; see below.
              </>
            ),
          },
          {
            term: "Email",
            def: (
              <>
                Used to resolve an existing <DocLink to="/docs/revenue">Contact</DocLink>, or create
                one. This is one of the few paths that <em>may</em> create a contact, because a
                signal firing is an explicit act rather than inbox noise.
              </>
            ),
          },
          {
            term: "Domain",
            def: (
              <>
                Used to resolve the <DocLink to="/docs/customers">Customer</DocLink> account.{" "}
                <Code>acme.com</Code>, <Code>https://www.acme.com/pricing</Code> and{" "}
                <Code>@acme.com</Code> all normalize to the same account.
              </>
            ),
          },
          {
            term: "Amount",
            def: (
              <>
                A money amount in <Strong>minor units</Strong> (cents), used when the action opens a
                deal.
              </>
            ),
          },
        ]}
      />
      <P>
        Queries run through Explore&apos;s executor and inherit its envelope: a 30-second timeout and
        a hard row ceiling. A signal looks at at most 500 rows per tick; the overflow is not lost,
        because the rows that did fire have their dedupe keys stored and the next tick picks up where
        it left off. A signal with an <Code>ORDER BY</Code> therefore drains in priority order —
        which is why the example above sorts by revenue.
      </P>

      <H2 id="dedupe">The dedupe column is not optional</H2>
      <P>
        A signal re-runs its query on every tick. Without a way to tell &quot;this row already
        fired&quot; from &quot;this row is new&quot;, the same account alerts you every hour, forever
        — and the real damage is what happens next: somebody mutes the signal, and then it never
        fires for the row that actually mattered.
      </P>
      <P>
        <Strong>Name a dedupe column and the guarantee is a database constraint</Strong>, not a hope.
        Genosyn stores one event per <em>(signal, dedupe key)</em> pair with a unique index, so an
        account fires once per condition even when two replicas evaluate the same signal in the same
        second — the loser hits the constraint and correctly does nothing.
      </P>
      <Callout kind="warn" title="Leaving it blank degrades the signal, it does not disable dedupe.">
        With no usable dedupe column, Genosyn falls back to hashing the entire row. That downgrades
        the signal from <em>fire once per account</em> to <em>fire once per distinct row</em> — so
        any column that moves (a timestamp, a counter, a computed &quot;days left&quot;) makes the
        same account fire again on every tick. Always name a stable identity column.
      </Callout>
      <P>
        Pick something that does not change: an account id, a subscription id, a user id. If you want
        a condition to be able to fire twice for the same account — a trial that restarts, a limit
        hit in two different months — put the period into the key in SQL, for example{" "}
        <Code>account_id || &apos;:&apos; || to_char(now(), &apos;YYYY-MM&apos;)</Code>. That is a
        deliberate choice you can read months later.
      </P>

      <H2 id="test">Test before you enable</H2>
      <P>
        <Strong>Test</Strong> is a dry run: it executes the query and shows you the first rows and
        their column names, and it writes <em>nothing</em>. No events, no contacts, no deals, no
        notifications, no enrolments. Use it until three things are true:
      </P>
      <UL>
        <LI>The row count is small and the rows are the ones you meant.</LI>
        <LI>
          The dedupe column is present, non-null, and identical for the same account across two runs.
        </LI>
        <LI>The email and domain columns hold what the action will need.</LI>
      </UL>
      <P>
        Test runs are written to the audit log even though they change nothing, because the read
        itself — arbitrary SQL against a connected production database — is the thing worth having a
        record of.
      </P>
      <Callout kind="tip" title="Enable with the safe action first.">
        Set the action to <Strong>Log an activity</Strong>, let the signal run for a day, and look at
        what it produced. Only then switch it to something that emails people. The activity action is
        the only one with no external effect, and it exists for exactly this.
      </Callout>

      <H2 id="actions">What happens when a row fires</H2>
      <KeyList
        rows={[
          {
            term: "Log an activity",
            def: (
              <>
                Writes a <Code>signal</Code> row onto the contact&apos;s{" "}
                <DocLink to="/docs/revenue#timeline">timeline</DocLink>. The safe default and the
                right setting while you are still tuning the query.
              </>
            ),
          },
          {
            term: "Notify",
            def: <>A bell notification and a web push to the company&apos;s owners and admins.</>,
          },
          {
            term: "Create a deal",
            def: (
              <>
                Opens a <DocLink to="/docs/revenue#deals">Deal</DocLink> in the first stage of the
                board, using the amount column for its value and attributing its source to the
                signal.
              </>
            ),
          },
          {
            term: "Enrol in a sequence",
            def: (
              <>
                Adds the contact to a <DocLink to="/docs/sequences">Sequence</DocLink> you pick. Every
                enrolment gate still applies — suppressed, do-not-contact and already-enrolled people
                are refused, and the event records that it was refused rather than pretending it
                worked.
              </>
            ),
          },
          {
            term: "Hand to an AI employee",
            def: (
              <>
                Wakes the employee you name with the whole result row and an instruction, and lets it
                decide what to do — research the account, draft an email, open a deal, escalate. It
                runs with its full <DocLink to="/docs/soul">Soul</DocLink> and{" "}
                <DocLink to="/docs/skills">Skills</DocLink>, and needs a revenue grant at the level
                its actions require.
              </>
            ),
          },
        ]}
      />

      <H3 id="events">Events, and failures you can see</H3>
      <P>
        Every firing is a <Strong>Signal event</Strong> carrying the full result row, listed under{" "}
        <Code>Revenue → Signals → Events</Code> with a status: <Code>new</Code>,{" "}
        <Code>actioned</Code>, <Code>ignored</Code>, or <Code>failed</Code>. <Code>ignored</Code> is
        not an error — an enrolment refused because the person unsubscribed is the system working
        exactly as designed. <Code>failed</Code> means somebody has to fix something.
      </P>
      <P>
        A signal whose query throws keeps its schedule and shows the error on its own row rather than
        disabling itself, because a signal that quietly switched itself off would be discovered weeks
        later, by which time the rows it should have fired on have moved on. One broken signal never
        stops the others in the same pass.
      </P>

      <H2 id="least-privilege">Connect with a least-privileged role</H2>
      <Callout kind="warn" title="Read-only SQL is not enforced.">
        Genosyn does not parse or restrict the SQL a signal runs, exactly as in{" "}
        <DocLink to="/docs/explore">Explore</DocLink>. Whatever the connected database role is
        allowed to do, a signal can do — including <Code>UPDATE</Code>, <Code>DELETE</Code> and{" "}
        <Code>DROP</Code>. The guardrail is the credential, not the query box.
      </Callout>
      <P>
        Create a dedicated role for Genosyn, grant it <Code>SELECT</Code> and nothing else, scope it
        to the tables signals need, and point it at a read replica if you have one. Do this before
        you connect, not after — the same credential is what any AI employee granted that Connection
        reaches through, and a signal is scheduled, so a destructive query does not need anybody to
        be watching.
      </P>

      <H2 id="related">Related</H2>
      <UL>
        <LI>
          <DocLink to="/docs/explore">Explore</DocLink> — the query executor and the connections
          signals run against.
        </LI>
        <LI>
          <DocLink to="/docs/sequences">Sequences</DocLink> — where an enrol action sends people.
        </LI>
        <LI>
          <DocLink to="/docs/deliverability">Deliverability</DocLink> — read this before any signal
          starts sending mail.
        </LI>
      </UL>
    </>
  );
}
