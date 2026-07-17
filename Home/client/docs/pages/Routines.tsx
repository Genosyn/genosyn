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
            A <Strong>Routine</Strong> is a scheduled, recurring piece of AI work. Cron expression,
            markdown brief, on/off switch. Every execution becomes a <Strong>Run</Strong> with
            captured logs you can read line by line.
          </>
        }
      />

      <Callout kind="info" title='"Routine" is the word.'>
        Genosyn never calls these &quot;tasks,&quot; &quot;jobs,&quot; or &quot;workflows.&quot;{" "}
        <Strong>Task</Strong> is reserved for the human-style project/todo manager — different
        feature, different surface.
      </Callout>

      <H2 id="where-they-live">Where they live</H2>
      <P>
        Routines have their own section in the nav, under <Strong>AI → Routines</Strong>. That list
        is company-wide: every routine, every employee, one page. Filter it by the{" "}
        <DocLink to="/docs/employees">AI Employee</DocLink> a routine is assigned to, or by health —{" "}
        <Strong>Active</Strong>, <Strong>Paused</Strong>, <Strong>Needs attention</Strong>. Company{" "}
        <DocLink to="/docs/tags">Tags</DocLink> give you another filter for grouping related
        routines across employees.
      </P>
      <P>
        Clicking a routine opens its detail page: <Strong>Overview</Strong>, <Strong>Brief</Strong>,{" "}
        <Strong>Runs</Strong>, and <Strong>Settings</Strong>. Each AI employee still links to their
        own slice of that list — same page, filtered to them.
      </P>

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
            term: "model",
            def: (
              <>
                Optional. Which of the employee&apos;s{" "}
                <DocLink to="/docs/models">AI Models</DocLink> this routine runs
                on. Defaults to <Strong>Inherit</Strong> — whichever model is
                active for the employee. See{" "}
                <DocLink to="/docs/routines#model">Picking a model</DocLink>.
              </>
            ),
          },
          {
            term: "timeoutSec",
            def: (
              <>
                Hard timeout in seconds. The runner aborts the in-process agent
                after this long and marks the Run <Code>timeout</Code>. Defaults
                to{" "}
                <Strong>60 minutes</Strong> and is editable per routine (10s –
                6h) from the routine editor — raise it for long jobs, lower it
                to fail fast.
              </>
            ),
          },
          {
            term: "browserEnabledOverride",
            def: (
              <>
                Optional per-routine override of the employee&apos;s{" "}
                <DocLink to="/docs/browser">browser</DocLink> toggle — force it
                on for a research routine, or off for one that must never
                touch the web. Unset means &quot;inherit from the
                employee&quot;.
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

      <H2 id="self-serve">Employees manage their own routines</H2>
      <P>
        You don&apos;t have to click through the editor yourself — every AI
        employee holds built-in tools for the full routine lifecycle:{" "}
        <Code>list_routines</Code>, <Code>create_routine</Code>,{" "}
        <Code>update_routine</Code>, and <Code>delete_routine</Code>. Ask an
        employee in chat to set up a weekly report, move it to Fridays, rewrite
        its brief, or pause it, and they edit the existing routine in place —
        <Code>update_routine</Code> covers rename, re-schedule, brief rewrites,
        and the enable/disable switch, so nothing forces a duplicate.
      </P>
      <P>
        Every change made this way is written to the{" "}
        <DocLink to="/docs/employees">audit log</DocLink>, and creating or
        deleting a routine also lands in the owning employee&apos;s journal, so
        the humans can always see who rescheduled what.
      </P>

      <H2 id="model">Picking a model</H2>
      <P>
        An employee can hold several{" "}
        <DocLink to="/docs/models">AI Models</DocLink> and keeps one active. By
        default a routine runs on that active model — the{" "}
        <Strong>Model</Strong> field in the routine editor reads{" "}
        <Strong>Inherit</Strong>, and the routine follows the employee whenever
        you switch their brain.
      </P>
      <P>
        Pick a specific model instead to <Strong>pin</Strong> it. The routine
        then always runs on that model regardless of which one is active. This
        is how you put a noisy hourly digest on a cheap local endpoint while the
        employee&apos;s chat stays on a frontier model — or the reverse, pinning
        the weekly board report to your strongest model.
      </P>
      <UL>
        <LI>
          You can only pin a model that <Strong>belongs to that employee</Strong>
          . Register it on the employee&apos;s Models tab first.
        </LI>
        <LI>
          A pin only affects this routine&apos;s <Strong>Runs</Strong>. Chat with
          the employee always uses the active model.
        </LI>
        <LI>
          Remove a pinned model and its routines quietly revert to{" "}
          <Strong>Inherit</Strong> rather than breaking. The run log names the
          model it used and whether it was pinned or inherited.
        </LI>
      </UL>

      <H2 id="runs">Runs</H2>
      <P>
        Every cron tick — and every manual trigger — creates a <Code>Run</Code>{" "}
        row. The runner runs the in-process agent in the employee&apos;s
        directory and stores the agent transcript — the model&apos;s messages and
        tool trace, not captured CLI stdout — on <Code>Run.logContent</Code>{" "}
        (capped at 256 KB; longer logs are head-truncated with a notice).
      </P>
      <P>
        A routine&apos;s full run history lives on its <Strong>Runs</Strong> tab
        — every Run, scheduled or manual, with the log viewer.
      </P>
      <UL>
        <LI>
          <Strong>Status</Strong> moves <Code>queued → running → succeeded</Code>{" "}
          or <Code>failed</Code>.
        </LI>
        <LI>
          The Run detail view streams the transcript over WebSocket while
          it&apos;s running, then renders the full transcript when it&apos;s
          done.
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
