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

export function Routines() {
  return (
    <>
      <PageHeader
        eyebrow="Core concepts"
        title="Routines & Runs"
        lead={
          <>
            A <Strong>Routine</Strong> is a scheduled, recurring piece of AI
            work. Cron expression, markdown brief, on/off switch. Every
            execution becomes a <Strong>Run</Strong> with captured logs you
            can read line by line.
          </>
        }
      />

      <Callout kind="info" title='"Routine" is the word.'>
        Genosyn never calls these &quot;tasks,&quot; &quot;jobs,&quot; or
        &quot;workflows.&quot; <Strong>Task</Strong> is reserved for the
        human-style project/todo manager — different feature, different
        surface.
      </Callout>

      <H2 id="anatomy">Anatomy</H2>
      <KeyList
        rows={[
          { term: "name", def: "What humans call this routine." },
          {
            term: "cron",
            def: (
              <>
                A standard 5-field cron expression. Rendered as a
                human-readable schedule next to the input field.
              </>
            ),
          },
          {
            term: "body",
            def: (
              <>
                Markdown brief — what the employee should do when this fires.
                Stored on <Code>Routine.body</Code>.
              </>
            ),
          },
          {
            term: "enabled",
            def: "Boolean. Disabling pauses the schedule without losing the row.",
          },
          {
            term: "approvalRequired",
            def: (
              <>
                Optional. If true, the runner records the intended action and
                blocks it on a human ✓ via the{" "}
                <Code>Approval</Code> entity.
              </>
            ),
          },
          {
            term: "timeoutSec",
            def: (
              <>
                Hard timeout in seconds. The runner SIGKILLs the CLI after this
                long and marks the Run <Code>timeout</Code>. Defaults to{" "}
                <Strong>60 minutes</Strong> and is editable per routine (10s –
                6h) from the routine editor — raise it for long jobs, lower it
                to fail fast.
              </>
            ),
          },
        ]}
      />

      <H2 id="scheduling">Scheduling</H2>
      <P>
        Routines use <Code>node-cron</Code>, the standard 5-field syntax:
      </P>
      <Pre lang="text">{`┌───── minute (0 - 59)
│ ┌─── hour (0 - 23)
│ │ ┌─ day of month (1 - 31)
│ │ │ ┌─ month (1 - 12)
│ │ │ │ ┌─ day of week (0 - 6, Sunday = 0)
│ │ │ │ │
0 9 * * 1-5   →  weekdays at 09:00
*/15 * * * *  →  every 15 minutes
0 17 * * 5    →  Fridays at 17:00`}</Pre>
      <P>
        The editor previews the cron in plain English next to the field, so
        you can sanity-check before saving.
      </P>

      <H2 id="the-brief">The brief</H2>
      <P>
        The <Code>body</Code> is markdown the model reads at run time. Keep it
        short and verb-first. Reference a{" "}
        <DocLink to="/docs/skills">Skill</DocLink> by name if the playbook
        already exists; otherwise describe the desired outcome.
      </P>
      <Pre lang="markdown">{`# Morning brief

Every weekday at 09:00, post a 5-bullet summary of:
1. Stripe revenue for the last 24h (call \`reconcile-stripe-payouts\`)
2. New customer signups (Postgres connection "prod-read")
3. Open PRs assigned to humans (GitHub connection "main")
4. Anything new in #alerts since yesterday
5. One sentence of your own opinion about the day

Post it to the #morning channel.`}</Pre>

      <H2 id="runs">Runs</H2>
      <P>
        Every cron tick — and every manual trigger — creates a <Code>Run</Code>{" "}
        row. The runner spawns the provider CLI in the employee&apos;s
        directory, streams stdout + stderr, and stores the captured log on{" "}
        <Code>Run.logContent</Code> (capped at 256 KB; longer logs are
        head-truncated with a notice).
      </P>
      <UL>
        <LI>
          <Strong>Status</Strong> moves <Code>queued → running → succeeded</Code>{" "}
          or <Code>failed</Code>.
        </LI>
        <LI>
          The Run detail view streams logs over WebSocket while it&apos;s
          running, then renders the captured log when it&apos;s done.
        </LI>
        <LI>
          Manual Runs from the &quot;Run now&quot; button live in the same
          table as scheduled Runs.
        </LI>
        <LI>
          <Strong>Retry</Strong> a Run that <Code>failed</Code> or{" "}
          <Code>timed out</Code> straight from its run history. It re-triggers
          the routine immediately, outside the schedule, and opens the live log
          for the new Run.
        </LI>
      </UL>
      <P>
        Failures are easy to notice: the Home page shows a{" "}
        <Strong>Failed routines</Strong> panel for anything that broke in the
        last 24 hours, and every <Strong>Journal</Strong> entry for a Run links
        straight to that routine&apos;s run history — where the Retry button is
        one click away. Once you&apos;ve looked at a failure, hit the{" "}
        <Strong>✕</Strong> on its row to <Strong>dismiss</Strong> it — the run
        stays in the routine&apos;s history, but it drops off the panel (and out
        of the System Health failed-runs count) so it stops nagging the whole
        team.
      </P>

      <H2 id="system-health">System Health</H2>
      <P>
        <Strong>Settings → System Health</Strong> (also a card on the Home page)
        rolls up everything that might be quietly broken for the company, over a
        24-hour window:
      </P>
      <UL>
        <LI>
          <Strong>Failed</Strong> and <Strong>stuck</Strong> runs — failures,
          timeouts, and runs still <Code>running</Code> long after their timeout
          (orphaned by a restart).
        </LI>
        <LI>
          <Strong>Skipped runs</Strong> and{" "}
          <Strong>employees missing an AI model</Strong> — routines that never
          actually ran because no model was connected.
        </LI>
        <LI>
          <Strong>Approvals waiting too long</Strong>,{" "}
          <Strong>email delivery failures</Strong>, and{" "}
          <Strong>integration connections</Strong> in an error/expired state.
        </LI>
      </UL>
      <P>
        Every row deep-links to where you fix it — the routine&apos;s run
        history, the employee&apos;s model settings, the approvals inbox, or the
        relevant settings page. It is read-only and computed live from existing
        data, so there is nothing to configure.
      </P>

      <H2 id="approvals">Approvals</H2>
      <P>
        Some routines should not auto-fire. Flip <Code>approvalRequired</Code>{" "}
        on and the runner stops the moment the routine would take a sensitive
        action — paying a Lightning invoice, sending an email, hitting a
        third-party API. The action is recorded as an{" "}
        <Code>Approval</Code> row; a human clicks ✓ in the inbox and the call
        is replayed.
      </P>

      <H3 id="approval-kinds">Built-in approval kinds</H3>
      <UL>
        <LI>
          <Code>routine</Code> — the whole Run is gated.
        </LI>
        <LI>
          <Code>lightning_payment</Code> — auto-issued when a payment exceeds
          the per-connection cap. See the{" "}
          <DocLink to="/docs/integrations">Integrations</DocLink> page.
        </LI>
      </UL>
    </>
  );
}
