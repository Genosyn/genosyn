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
            term: "catchUpPolicy",
            def: (
              <>
                What to do about slots missed while the server was down.{" "}
                <Strong>Run once</Strong> (the default) fires a single catch-up
                run; <Strong>Skip</Strong> declines it when the slot is already
                more than a minute late. See{" "}
                <DocLink to="/docs/routines#recovery">
                  Downtime and recovery
                </DocLink>
                .
              </>
            ),
          },
          {
            term: "maxAttempts",
            def: (
              <>
                Total attempts per scheduled occurrence, counting the first.{" "}
                <Strong>1</Strong> by default — no retry. Paired with{" "}
                <Code>retryBackoffSec</Code> and <Code>retryOnTimeout</Code>.
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

      <H2 id="parallel-delegation">Parallel delegation</H2>
      <P>
        Chat turns and Routine runs include <Code>delegate_parallel_work</Code>.
        An AI employee can split an objective into independent briefs, run up
        to four temporary copies of itself at once, and receive their ordered
        results before it writes the final answer or takes follow-up action.
        Each worker uses the same Soul, Skills, AI Model, Grants, secrets, and
        timeout as its parent.
      </P>
      <Pre lang="markdown">{`Research our weekly launch brief in parallel:

1. Summarize customer feedback from the support mailbox.
2. Compare this week's Stripe metrics with last week.
3. Review merged GitHub pull requests for customer-visible changes.

Verify the three results, resolve any disagreement, then post one concise brief to #launch.`}</Pre>
      <UL>
        <LI>
          A delegation call accepts up to eight briefs, runs at most four at a
          time, and a top-level turn can delegate twelve briefs in total.
          Temporary workers cannot delegate again.
        </LI>
        <LI>
          Workers receive only their self-contained brief, not the parent chat
          history. Include the relevant dates, data sources, constraints, and
          expected output in each brief.
        </LI>
        <LI>
          Workers share the employee&apos;s working directory. Parallel reads
          are safe; for writes, assign distinct files and avoid concurrent git
          operations or overlapping edits.
        </LI>
        <LI>
          Delegation multiplies AI Model usage. The parent Run timeout still
          applies to every worker and aborts the whole group when it expires.
        </LI>
      </UL>
      <Callout kind="info" title="Parallel delegation is not a Handoff.">
        Temporary workers are copies of the same AI employee and return during
        the current turn. A Handoff delegates durable work to a different AI
        employee, with its own inbox and status trail.
      </Callout>

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
          <Strong>Status</Strong> starts at <Code>running</Code> and ends at one
          of <Code>completed</Code>, <Code>failed</Code>, <Code>skipped</Code>{" "}
          (no model was connected), <Code>timeout</Code>, or{" "}
          <Code>interrupted</Code> (the server stopped mid-run).
        </LI>
        <LI>
          The Run detail view tails the transcript while it&apos;s running, then
          renders the full transcript when it&apos;s done.
        </LI>
        <LI>
          Manual Runs from the &quot;Run now&quot; button live in the same
          table as scheduled Runs.
        </LI>
        <LI>
          <Strong>Retry</Strong> a Run that <Code>failed</Code>,{" "}
          <Code>timed out</Code>, or was <Code>interrupted</Code> straight from
          its run history. It re-triggers the routine immediately, outside the
          schedule, and opens the live log for the new Run.
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

      <H2 id="recovery">Downtime and recovery</H2>
      <P>
        Servers restart, containers get rescheduled, laptops go to sleep. Two
        things can go wrong, and Genosyn handles them differently.
      </P>

      <H3 id="crash-mid-run">The server stopped mid-run</H3>
      <P>
        A Run that was executing when the process died can&apos;t report its own
        outcome — nobody was left to write the row. The scheduler notices on its
        next heartbeat and marks it <Code>interrupted</Code>, appending a line to
        the transcript saying so. Nothing is known about work the employee did
        after the last captured line, which is exactly why the status is its own
        word and not <Code>failed</Code>.
      </P>
      <P>
        The same pass releases the <Strong>workload lease</Strong> the dead run
        was holding. That matters more than the status: without it the AI
        employee reads as busy and refuses chat until the lease expires — up to
        an hour on the default timeout.
      </P>

      <H3 id="missed-slots">The server was off across scheduled slots</H3>
      <P>
        A routine fires <Strong>once</Strong> when the server comes back, never
        once per missed slot. An hourly digest that was down overnight produces
        one run, not twelve. The catch-up run records how many occurrences it
        stands in for — you&apos;ll see <Code>+11 missed</Code> on the run row —
        and its brief tells the employee to cover the whole period rather than
        just the last interval.
      </P>
      <P>
        Set <Strong>After downtime</Strong> to <Strong>Skip</Strong> in the
        routine&apos;s Settings when a late run is worse than no run — a 09:00
        standup digest arriving at 16:00 is noise. The skipped occurrences are
        recorded in the employee&apos;s Journal so the gap is still visible.
      </P>
      <Callout kind="info" title="Missed slots are never replayed one-for-one.">
        There is no setting that re-runs every occurrence you missed. A week of
        downtime on a 15-minute routine would be 672 runs and a very large model
        bill, so the ceiling is deliberately one catch-up run per routine.
      </Callout>

      <H3 id="retries">Retries</H3>
      <P>
        <Strong>Off by default.</Strong> Raise <Strong>Attempts</Strong> above 1
        in the routine&apos;s Settings and a run that <Code>failed</Code> or was{" "}
        <Code>interrupted</Code> is re-attempted automatically, up to 5 attempts,
        waiting a randomized, doubling interval between each (from{" "}
        <Strong>Retry backoff</Strong>, capped at six hours). Timeouts are opted
        in separately, because retrying one re-burns the routine&apos;s whole
        time budget.
      </P>
      <Callout kind="warn" title="Retries are at-least-once.">
        An interrupted run may already have sent the email, posted the update, or
        moved the money before the process died — Genosyn can&apos;t know. The
        retry will do it again. Only raise Attempts on routines whose actions are
        safe to repeat.
      </Callout>
      <UL>
        <LI>
          Only <Strong>scheduled</Strong> runs retry. A manual &quot;Run
          now,&quot; a webhook, or an approved run had someone present who saw the
          outcome, so nothing respawns behind their back.
        </LI>
        <LI>
          A run with a retry pending stays out of the Home{" "}
          <Strong>Failed routines</Strong> panel until its last attempt is spent
          — it isn&apos;t something to act on yet. It shows under{" "}
          <Strong>Runs waiting to retry</Strong> in System Health instead.
        </LI>
        <LI>
          <Strong>Cancel retry</Strong> from the run&apos;s log view stops the
          chain without pausing the whole routine — the escape hatch when
          you&apos;ve decided to fix the failure by hand.
        </LI>
        <LI>
          These are operator settings. AI employees managing their own routines
          through <Code>update_routine</Code> cannot change them.
        </LI>
      </UL>

      <H2 id="system-health">System Health</H2>
      <P>
        <Strong>Settings → System Health</Strong> (also a card on the Home page)
        rolls up everything that might be quietly broken for the company, over a
        24-hour window:
      </P>
      <UL>
        <LI>
          <Strong>Failed</Strong> runs — failures, timeouts, and restarts that
          interrupted a run, excluding anything already scheduled for a retry.
        </LI>
        <LI>
          <Strong>Runs waiting to retry</Strong> — an in-progress retry chain,
          so it&apos;s visible rather than silent. Nothing to do.
        </LI>
        <LI>
          <Strong>Stuck</Strong> runs — still <Code>running</Code> after 8 hours.
          Crash recovery clears orphans within a heartbeat now, so anything here
          means the scheduler itself isn&apos;t running.
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
