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
            markdown brief, on/off switch. Every execution becomes a <Strong>Run</Strong> with a
            captured log — and, when it uses a browser, a visual recording you can review beside
            that log.
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
        <Strong>Active</Strong>, <Strong>Paused</Strong>, <Strong>Needs attention</Strong>. Two more
        axes group routines across employees: <DocLink to="/docs/routines#folders">folders</DocLink>{" "}
        in the sidebar, and company <DocLink to="/docs/tags">Tags</DocLink> as chips above the list.
      </P>
      <P>
        Clicking a routine opens its detail page: <Strong>Overview</Strong>, <Strong>Brief</Strong>,{" "}
        <Strong>Runs</Strong>, and <Strong>Settings</Strong>, with{" "}
        <DocLink to="/docs/routines#assistant">Ask AI</DocLink> in the header. Each AI employee
        links to their own slice of that list from <Strong>Settings → Routines</Strong> — same page,
        filtered to them.
      </P>

      <H2 id="folders">Folders</H2>
      <P>
        Once a company runs dozens of routines, neither &quot;all of them&quot; nor &quot;one
        employee&apos;s&quot; is a useful view. <Strong>Folders</Strong> are the filing tree in the
        Routines sidebar: company-wide, nestable up to five levels, and exclusive — a routine is
        filed in at most one folder, or in none at all.
      </P>
      <P>
        Create one with the folder button at the top of the sidebar, or from{" "}
        <Strong>New folder…</Strong> in any move menu. Selecting a folder narrows the list to that
        folder <Strong>and everything nested inside it</Strong>, so a parent never reads as empty
        just because its routines live one level down. The tag chips narrow with that same folder
        scope, so every tag shown can match a routine currently in the list. <Strong>Unfiled</Strong>{" "}
        at the bottom of the tree collects everything you haven&apos;t filed yet. Each folder&apos;s{" "}
        <Code>⋯</Code> menu holds <Strong>New subfolder</Strong>, <Strong>Rename</Strong>,{" "}
        <Strong>Move to top level</Strong>, and <Strong>Delete folder</Strong>.
      </P>
      <Callout kind="info" title="Deleting a folder never deletes routines.">
        Its routines and subfolders move up to the folder&apos;s own parent — which for a top-level
        folder means they become Unfiled. The confirmation says exactly where they will land before
        you press the button.
      </Callout>
      <H3 id="filing-routines">Filing routines</H3>
      <P>
        To file an existing library, press <Strong>Organize</Strong> above the list. Checkboxes
        appear on every row: tick the ones you want (or <Strong>Select all</Strong>), then pick a
        destination from <Strong>Move to folder</Strong>. It is one request for the whole batch, so
        a failure never leaves half the selection moved. A single routine can also be re-filed from
        the <Strong>Folder</Strong> field on its <Strong>Settings</Strong> tab, and a new routine
        created while you are inside a folder lands there by default.
      </P>
      <Callout kind="info" title="Folders and tags answer different questions.">
        A folder is <Strong>where a routine lives</Strong> — one folder, navigable, exclusive. A{" "}
        <DocLink to="/docs/tags">tag</DocLink> is <Strong>what it is about</Strong> — many per
        routine, cutting across the tree. &quot;Finance/Month-end&quot; is a folder;
        &quot;urgent&quot; and &quot;quarterly&quot; are tags. Use both.
      </Callout>
      <P>
        AI employees can file their own work too: <Code>create_routine</Code> and{" "}
        <Code>update_routine</Code> both take a <Code>folder</Code> — a name like{" "}
        <Code>Finance</Code> or a path like <Code>Finance/Month-end</Code>. Any segment that
        doesn&apos;t exist yet is created, the same way tag names are. Passing an empty string to{" "}
        <Code>update_routine</Code> unfiles the routine.
      </P>

      <H2 id="anatomy">Anatomy</H2>
      <KeyList
        rows={[
          { term: "name", def: "What humans call this routine." },
          {
            term: "folder",
            def: (
              <>
                Which <DocLink to="/docs/routines#folders">folder</DocLink> the routine is filed
                under. Optional — a routine with no folder shows up under <Strong>Unfiled</Strong>.
              </>
            ),
          },
          {
            term: "cron",
            def: (
              <>
                A standard 5-field cron expression. Rendered as a human-readable schedule next to
                the input field.
              </>
            ),
          },
          {
            term: "body",
            def: (
              <>
                Markdown brief — what the employee should do when this fires. Stored on{" "}
                <Code>Routine.body</Code>.
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
                Optional. If true, the runner records the intended action and blocks it on a human ✓
                via the <Code>Approval</Code> entity.
              </>
            ),
          },
          {
            term: "model",
            def: (
              <>
                Optional. Which of the employee&apos;s{" "}
                <DocLink to="/docs/models">AI Models</DocLink> this routine runs on. Defaults to{" "}
                <Strong>Inherit</Strong> — whichever model is active for the employee. See{" "}
                <DocLink to="/docs/routines#model">Picking a model</DocLink>.
              </>
            ),
          },
          {
            term: "timeoutSec",
            def: (
              <>
                Hard timeout in seconds. The runner aborts the in-process agent after this long and
                marks the Run <Code>timeout</Code>. Defaults to <Strong>60 minutes</Strong> and is
                editable per routine (10s – 6h) from the routine editor — raise it for long jobs,
                lower it to fail fast.
              </>
            ),
          },
          {
            term: "catchUpPolicy",
            def: (
              <>
                What to do about slots missed while the server was down. <Strong>Run once</Strong>{" "}
                (the default) fires a single catch-up run; <Strong>Skip</Strong> declines it when
                the slot is already more than a minute late. See{" "}
                <DocLink to="/docs/routines#recovery">Downtime and recovery</DocLink>.
              </>
            ),
          },
          {
            term: "maxAttempts",
            def: (
              <>
                Total attempts per scheduled occurrence, counting the first. <Strong>1</Strong> by
                default — failed and timed-out Runs do not retry, while a newly interrupted initial
                scheduled Run on an enabled routine without an approval gate still receives one
                recovery attempt an hour after Genosyn marks it. Higher limits also bound
                interrupted retries later in the same chain. Paired with{" "}
                <Code>retryBackoffSec</Code> and <Code>retryOnTimeout</Code>.
              </>
            ),
          },
          {
            term: "browserEnabledOverride",
            def: (
              <>
                Optional per-routine override of the employee&apos;s{" "}
                <DocLink to="/docs/browser">browser</DocLink> toggle — force it on for a research
                routine, or off for one that must never touch the web. Unset means &quot;inherit
                from the employee&quot;.
              </>
            ),
          },
          {
            term: "acceptanceCriteria",
            def: (
              <>
                Optional plain-language definition of done, edited at{" "}
                <Strong>Settings → Outcome check</Strong>. When set, the criteria ride along in
                every Run&apos;s brief and each completed Run is graded against them. See{" "}
                <DocLink to="/docs/routines#outcome-check">The outcome check</DocLink>.
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
        The editor previews the cron in plain English next to the field, so you can sanity-check
        before saving.
      </P>

      <H2 id="the-brief">The brief</H2>
      <P>
        The <Code>body</Code> is markdown the model reads at run time. Keep it short and verb-first.
        Reference a <DocLink to="/docs/skills">Skill</DocLink> by name if the playbook already
        exists; otherwise describe the desired outcome.
      </P>
      <Pre lang="markdown">{`# Morning brief

Every weekday at 09:00, post a 5-bullet summary of:
1. Stripe revenue for the last 24h (call \`reconcile-stripe-payouts\`)
2. New customer signups (Postgres connection "prod-read")
3. Open PRs assigned to humans (GitHub connection "main")
4. Anything new in #alerts since yesterday
5. One sentence of your own opinion about the day

Post it to the #morning channel.`}</Pre>

      <H2 id="assistant">Ask AI about a routine</H2>
      <P>
        Every routine has its own AI chat. Press <Strong>Ask AI</Strong> in the routine header and a
        panel docks beside the page — the same idea as the chat beside an{" "}
        <DocLink to="/docs/email#assistant">email</DocLink>, pointed at scheduled work instead. Drag
        its left edge to resize it, or wind it down to a spine with the chevron; it stays how you
        left it next time.
      </P>
      <P>
        The employee that owns the routine answers by default, because the question is usually about
        their work. They are handed the routine itself before they read your message: the schedule
        and every setting, the brief, how the last ten <Strong>Runs</Strong> went, and the tail of
        the newest Run&apos;s log. So &ldquo;why did last night&apos;s run fail?&rdquo; is answered
        from the transcript rather than guessed at — and you never have to paste a log in. Type{" "}
        <Code>@</Code> to hand the question to somebody else, <Code>#</Code> to reference another
        company resource, or <Code>/new</Code> on its own to clear this routine&apos;s context.
      </P>
      <P>
        Asking is not editing. Any Member who can open a routine can ask about it, while changing
        one still needs an admin — and the employee is told to describe a change rather than make
        it. If you do ask for the change and you have the rights to make it, it runs with{" "}
        <em>your</em> authority, and whatever it did shows up as a small action pill under the
        reply. You can attach a file to the question too — a spec to check the brief against, a log
        from somewhere else.
      </P>
      <P>
        Each routine&apos;s chat is independent, and a reply in progress belongs to the server
        rather than to your browser tab. A long answer shows as <Strong>working</Strong>; if the
        connection drops the panel says <Strong>reconnecting</Strong> and picks the same reply back
        up when it lands, so closing the panel, changing tabs, or reloading is safe. A reply that
        genuinely could not run — the server restarted mid-answer, or the employee stayed busy for
        several minutes — says so and offers <Strong>Try again</Strong>. When the answering employee
        has more than one connected <DocLink to="/docs/models">AI Model</DocLink> a selector appears
        under the composer, and the conversation stays on whichever model answered last.
      </P>

      <H2 id="concurrent-runs">Chat and Runs continue in parallel</H2>
      <P>
        Starting a Routine does not make its AI employee unavailable. You can keep chatting with
        that employee and start other independent Routines while the first Run continues. Genosyn
        places no per-company ceiling on overlapping top-level AI work. Chat threads are independent
        too: one AI Employee answers several conversations at once, and only a second message in the{" "}
        <em>same</em> thread waits for the reply ahead of it. Your deployment operator and AI Model
        provider still determine real capacity, cost, and rate limits.
      </P>
      <Callout kind="warn" title="Parallel work shares the employee workspace.">
        Reads are safe. For writes, use distinct output files and avoid simultaneous git operations
        or edits to the same file. Browser sessions also share the employee&apos;s persisted browser
        state.
      </Callout>

      <H2 id="parallel-delegation">Parallel delegation</H2>
      <P>
        API-key and custom-endpoint Chat turns and Routine runs include{" "}
        <Code>delegate_parallel_work</Code>. An AI employee can split an objective into independent
        briefs, run up to four temporary copies of itself at once, and receive their ordered results
        before it writes the final answer or takes follow-up action. Each worker uses the same Soul,
        Skills, AI Model, Grants, secrets, and timeout as its parent.
      </P>
      <Callout kind="info" title="Subscription turns run one at a time per AI Model">
        OpenAI subscription turns do not include parallel delegation. Managed ChatGPT credentials
        may rotate during a Run, so Genosyn serializes subscription work on that AI Model to keep
        refreshes consistent.
      </Callout>
      <Pre lang="markdown">{`Research our weekly launch brief in parallel:

1. Summarize customer feedback from the support mailbox.
2. Compare this week's Stripe metrics with last week.
3. Review merged GitHub pull requests for customer-visible changes.

Verify the three results, resolve any disagreement, then post one concise brief to #launch.`}</Pre>
      <H3 id="github-issue-subagents">Copy/paste: one worker per GitHub issue</H3>
      <P>
        Before using this example, connect GitHub, allowlist the repository, and give the AI
        employee a Grant to that Connection. See{" "}
        <DocLink to="/docs/integrations#github-engineering">
          GitHub &amp; engineering grants
        </DocLink>
        .
      </P>
      <Pre lang="markdown">{`Triage up to 12 open GitHub issues in acme/widgets.

Please use subagents for this task. Use one subagent for each GitHub issue.

First list the open issues and ignore pull requests. Give each temporary worker one issue number,
its title and body, and ask it to identify the likely cause, affected area, severity, missing
information, and a recommended next step. Verify the returned findings, then produce one table
ordered by severity with links to the issues.

This is read-only triage. Do not edit files, create branches, commit, push, or comment on issues.`}</Pre>
      <P>
        Replace <Code>acme/widgets</Code> with the allowlisted repository. The sentence about
        subagents is ordinary Routine instructions, not special syntax: the AI Model plans the work
        and calls <Code>delegate_parallel_work</Code> when that tool is available and the issue
        briefs are independent. Confirm the call in the Run log. If delegation is unavailable or
        unsafe, the employee should explain the constraint and continue serially.
      </P>
      <Callout kind="warn" title="Keep one-worker-per-issue work read-only.">
        Temporary workers share one checkout. Issue research and triage can run safely in parallel;
        concurrent code edits, branches, commits, pushes, or other git operations in that checkout
        can conflict. Use separate Runs or a deliberately partitioned workflow for implementation.
      </Callout>
      <UL>
        <LI>
          A delegation call accepts up to eight briefs, runs at most four at a time, and a top-level
          turn can delegate twelve briefs in total. Temporary workers cannot delegate again. For
          more than twelve issues, narrow the filter or split the review across separate Runs.
        </LI>
        <LI>
          Workers receive only their self-contained brief, not the parent chat history. Include the
          relevant dates, data sources, constraints, and expected output in each brief.
        </LI>
        <LI>
          Workers share the employee&apos;s working directory. Parallel reads are safe; for writes,
          assign distinct files and avoid concurrent git operations or overlapping edits.
        </LI>
        <LI>
          Delegation multiplies AI Model usage. The parent Run timeout still applies to every worker
          and aborts the whole group when it expires.
        </LI>
      </UL>
      <Callout kind="info" title="Parallel delegation is not a Handoff.">
        Temporary workers are copies of the same AI employee and return during the current turn. A
        Handoff delegates durable work to a different AI employee, with its own inbox and status
        trail.
      </Callout>

      <H2 id="self-serve">Employees manage their own routines</H2>
      <P>
        You don&apos;t have to click through the editor yourself — every AI employee holds built-in
        tools for the full routine lifecycle: <Code>list_routines</Code>,{" "}
        <Code>create_routine</Code>, <Code>update_routine</Code>, and <Code>delete_routine</Code>.
        Ask an employee in chat to set up a weekly report, move it to Fridays, rewrite its brief, or
        pause it, and they edit the existing routine in place —<Code>update_routine</Code> covers
        rename, re-schedule, brief rewrites, and the enable/disable switch, so nothing forces a
        duplicate.
      </P>
      <P>
        Every change made this way is written to the{" "}
        <DocLink to="/docs/employees">audit log</DocLink>, and creating or deleting a routine also
        lands in the owning employee&apos;s journal, so the humans can always see who rescheduled
        what.
      </P>

      <H2 id="model">Picking a model</H2>
      <P>
        An employee can hold several <DocLink to="/docs/models">AI Models</DocLink> and keeps one
        active. By default a routine runs on that active model — the <Strong>Model</Strong> field in
        the routine editor reads <Strong>Inherit</Strong>, and the routine follows the employee
        whenever you switch their brain.
      </P>
      <P>
        Pick a specific model instead to <Strong>pin</Strong> it. The routine then always runs on
        that model regardless of which one is active. This is how you put a noisy hourly digest on a
        cheap local endpoint while choosing a frontier model in employee Chat — or the reverse,
        pinning the weekly board report to your strongest model.
      </P>
      <UL>
        <LI>
          You can only pin a model that <Strong>belongs to that employee</Strong>. Register it at
          the employee&apos;s <Strong>Settings → Model</Strong> first.
        </LI>
        <LI>
          A pin only affects this routine&apos;s <Strong>Runs</Strong>. Dedicated employee Chat has
          its own per-message picker when multiple models are connected; it defaults to whatever
          model that conversation last answered on, and to the active model for a new thread.
        </LI>
        <LI>
          Remove a pinned model and its routines quietly revert to <Strong>Inherit</Strong> rather
          than breaking. The run log names the model it used and whether it was pinned or inherited.
        </LI>
      </UL>

      <H2 id="runs">Runs</H2>
      <P>
        Every cron tick — and every manual trigger — creates a <Code>Run</Code> row. The runner runs
        the in-process agent in the employee&apos;s directory and stores the agent transcript — the
        model&apos;s messages and tool trace, not captured CLI stdout — on{" "}
        <Code>Run.logContent</Code> (capped at 256 KB; longer logs are head-truncated with a
        notice). While the Run is active, Genosyn checkpoints that transcript to the database about
        once a second, so it survives a server or container crash.
      </P>
      <P>
        A routine&apos;s full run history lives on its <Strong>Runs</Strong> tab — every Run,
        scheduled or manual, with the log viewer. If a Run actually opens a browser, Genosyn also
        captures a silent visual recording automatically, from that browser session&apos;s first
        activity until it finishes. Enabling Browser access alone creates no video, and browser
        recordings contain no audio.
      </P>
      <P>
        The recording player sits beside the Run log, with a download for each finished MP4. A Run
        may have more than one when it delegates independent browser work; use the numbered Browser
        buttons above the player to switch between them. While a Run is active, the player says that
        capture is in progress, then updates when the file is ready.
      </P>
      <Callout kind="warn" title="Recordings follow the Browser access boundary">
        A recording made in Genosyn&apos;s browser is available to company owners and admins, and to
        the Member the AI Employee reports to — supervising an employee&apos;s work should not
        require the admin role over everything else. Where that employee reports to another AI
        Employee, the line is followed upward to the first human on it. A recording made in a{" "}
        <DocLink to="/docs/member-browsers">Member browser</DocLink> is available only to that
        browser&apos;s exact owner, regardless of company role or org chart. Recordings are kept
        whole: the video shows whatever the page rendered, sign-in screens included.
      </Callout>
      <UL>
        <LI>
          <Strong>Status</Strong> starts at <Code>running</Code> and ends at one of{" "}
          <Code>completed</Code>, <Code>failed</Code>, <Code>skipped</Code> (no model was
          connected), <Code>timeout</Code>, or <Code>interrupted</Code> (the server stopped
          mid-run). A Run stopped by the step-limit backstop — the model kept calling tools
          without ever finishing — is marked <Code>failed</Code>, with the reason in the
          transcript. Completed only ever means the loop returned cleanly; whether the work
          met its bar is the <DocLink to="/docs/routines#outcome-check">outcome check</DocLink>
          &apos;s answer, not the status&apos;s.
        </LI>
        <LI>
          Each Run also records the <Strong>tokens</Strong> it consumed — the provider&apos;s own
          per-turn counts, summed. They show on the Run log modal and roll up per employee and
          per routine at <Strong>Settings → Usage</Strong>.
        </LI>
        <LI>
          The Run detail view tails the transcript while it&apos;s running, then renders the full
          transcript when it&apos;s done.
        </LI>
        <LI>
          Manual Runs from the &quot;Run now&quot; button live in the same table as scheduled Runs.
        </LI>
        <LI>
          <Strong>Retry</Strong> a Run that <Code>failed</Code>, <Code>timed out</Code>, or was{" "}
          <Code>interrupted</Code> straight from its run history. It re-triggers the routine
          immediately, outside the schedule, and opens the live log for the new Run.
        </LI>
      </UL>
      <P>
        Recordings stay with the Run history. Deleting the Routine deletes its Run logs and browser
        recordings; deleting the company removes them too. They live in the App-private data
        directory and are included in whole-instance backups.
      </P>
      <P>
        Failures are loud: a Run that ends <Code>failed</Code>, <Code>timeout</Code>, or{" "}
        <Code>interrupted</Code> with no retry still scheduled sends a bell (and web push)
        notification to the company&apos;s owners and admins and to the Member the employee
        reports to, deep-linked to the Run log. The Home page additionally shows a{" "}
        <Strong>Failed routines</Strong> panel for anything that broke in the last 24 hours, and
        every <Strong>Journal</Strong> entry for a Run links straight to that routine&apos;s run
        history — where the Retry button is one click away. Once you&apos;ve looked at a failure, hit the <Strong>✕</Strong> on its row to{" "}
        <Strong>dismiss</Strong> it — the run stays in the routine&apos;s history, but it drops off
        the panel (and out of the System Health failed-runs count) so it stops nagging the whole
        team.
      </P>
      <P>
        Rows marked <Code>interrupted</Code> also carry a <Strong>Rerun</Strong> button. Nothing is
        wrong with the routine in that case — the server stopped part-way through and the work
        simply didn&apos;t happen — so the button runs it again immediately and dismisses the
        interrupted Run, which keeps the panel from inviting a second, duplicate Run. It confirms
        first, because an interrupted Run may already have sent the email or moved the money before
        the process died; read the log if you&apos;re not sure repeating the work is safe. Runs that{" "}
        <Code>failed</Code> or <Code>timed out</Code> get no button here — those broke for a reason
        worth reading before you fire them off again.
      </P>

      <H2 id="outcome-check">The outcome check</H2>
      <P>
        A green <Code>completed</Code> proves the loop returned — it says nothing about whether
        the work was any good. A convincingly wrong Run used to look byte-identical to a great
        one. The outcome check is the second axis: give a routine{" "}
        <Strong>acceptance criteria</Strong> (Settings → Outcome check) — a plain-language
        definition of done, like &quot;the digest was posted to #general and covers every failed
        run since the last digest&quot; — and two things happen.
      </P>
      <UL>
        <LI>
          The criteria ride along in every Run&apos;s brief, so the employee aims at the same bar
          it will be graded against.
        </LI>
        <LI>
          After a completed Run, a restricted checker — a zero-tool model turn on the same brain,
          reading the transcript as untrusted evidence — grades the work and stamps a verdict on
          the Run: <Code>achieved</Code>, <Code>unclear</Code> (not enough evidence either way,
          the honest default), or <Code>off goal</Code>. The verdict shows as a chip beside the
          status everywhere Runs render, with the checker&apos;s one-line reason on hover and in
          the log view.
        </LI>
      </UL>
      <P>
        An <Code>off goal</Code> verdict notifies admins and the employee&apos;s manager the same
        way a failure does — convincing-but-wrong is exactly the failure mode a green checkmark
        hides. The verdict also lands in the employee&apos;s Journal entry for the Run, so the
        employee itself learns from past outcomes instead of only seeing that runs
        &quot;finished&quot;. The check never changes the Run&apos;s status, and a routine with no
        criteria behaves exactly as before — no verdict, no extra model turn, no extra cost.
      </P>
      <Callout kind="info" title="What it costs">
        One short extra model turn per completed Run, on the routine&apos;s own model. Its tokens
        are counted into the Run&apos;s totals like everything else.
      </Callout>

      <H2 id="recovery">Downtime and recovery</H2>
      <P>
        Servers restart, containers get rescheduled, laptops go to sleep. Two things can go wrong,
        and Genosyn handles them differently.
      </P>

      <H3 id="crash-mid-run">The server stopped mid-run</H3>
      <P>
        A Run that was executing when the process died can&apos;t report its own outcome — nobody
        was left to write the row. The scheduler notices on its next heartbeat and marks it{" "}
        <Code>interrupted</Code>, appending a line after the last durable checkpoint. The Run log
        still shows the model text and tool activity captured before the stop, so the final line
        identifies where the visible work ended. Nothing is known about work the employee did after
        that line, which is exactly why the status is its own word and not <Code>failed</Code>.
      </P>
      <P>
        When Genosyn marks an initial scheduled Run on an enabled routine interrupted, it also
        records a durable recovery retry. At the default <Strong>1 attempt</Strong>, exactly one
        recovery attempt becomes due an hour later. Raising Attempts lets later interruptions in
        that retry chain continue with the routine&apos;s configured jittered backoff, up to the
        five-attempt cap. Manual &quot;Run now,&quot; webhook, and approval Runs are excluded.
        Pausing the routine or adding an approval gate before dispatch cancels the automatic
        attempt.
      </P>
      <Callout kind="info" title="Recovery starts with newly interrupted Runs.">
        Upgrading does not sweep old interrupted history and replay it. Only a scheduled or retry
        Run that Genosyn marks interrupted after this recovery behavior is active receives the
        automatic attempt.
      </Callout>
      <H3 id="missed-slots">The server was off across scheduled slots</H3>
      <P>
        A routine fires <Strong>once</Strong> when the server comes back, never once per missed
        slot. An hourly digest that was down overnight produces one run, not twelve. The catch-up
        run records how many occurrences it stands in for — you&apos;ll see <Code>+11 missed</Code>{" "}
        on the run row — and its brief tells the employee to cover the whole period rather than just
        the last interval.
      </P>
      <P>
        Set <Strong>After downtime</Strong> to <Strong>Skip</Strong> in the routine&apos;s Settings
        when a late run is worse than no run — a 09:00 standup digest arriving at 16:00 is noise.
        The skipped occurrences are recorded in the employee&apos;s Journal so the gap is still
        visible.
      </P>
      <Callout kind="info" title="Missed slots are never replayed one-for-one.">
        There is no setting that re-runs every occurrence you missed. A week of downtime on a
        15-minute routine would be 672 runs and a very large model bill, so the ceiling is
        deliberately one catch-up run per routine.
      </Callout>

      <H3 id="retries">Retries</H3>
      <P>
        Retries after <Code>failed</Code> Runs are <Strong>off by default.</Strong> Raise{" "}
        <Strong>Attempts</Strong> above 1 in the routine&apos;s Settings to retry them
        automatically, up to 5 attempts, waiting a randomized, doubling interval between each (from{" "}
        <Strong>Retry backoff</Strong>, capped at six hours). Timeouts are opted in separately,
        because retrying one re-burns the routine&apos;s whole time budget. An interrupted initial
        scheduled Run on an enabled routine without an approval gate is the safety exception: even
        at 1 attempt, it receives one recovery attempt after an hour. Above 1, interrupted retries
        use the configured bounded backoff until the chain reaches its cap.
      </P>
      <Callout kind="warn" title="Retries are at-least-once.">
        An interrupted Run may already have sent the email, posted the update, or moved the money
        before the process died — Genosyn can&apos;t know. The recovery attempt may do it again.
        Make routine actions safe to repeat, or use <Strong>Cancel retry</Strong> on the Run before
        its retry becomes due.
      </Callout>
      <UL>
        <LI>
          Only <Strong>scheduled</Strong> Runs and Runs created by an automatic retry are eligible.
          A manual &quot;Run now,&quot; a webhook, or an approved Run had someone present who saw
          the outcome, so nothing respawns behind their back.
        </LI>
        <LI>
          A run with a retry pending stays out of the Home <Strong>Failed routines</Strong> panel
          until its last attempt is spent — it isn&apos;t something to act on yet. It shows under{" "}
          <Strong>Runs waiting to retry</Strong> in System Health instead.
        </LI>
        <LI>
          <Strong>Cancel retry</Strong> from the run&apos;s log view stops the chain without pausing
          the whole routine — the escape hatch when you&apos;ve decided to fix the failure by hand.
        </LI>
        <LI>
          These are operator settings. AI employees managing their own routines through{" "}
          <Code>update_routine</Code> cannot change them.
        </LI>
      </UL>

      <H2 id="system-health">System Health</H2>
      <P>
        <Strong>Settings → System Health</Strong> (also a card on the Home page) rolls up everything
        that might be quietly broken for the company, over a 24-hour window:
      </P>
      <UL>
        <LI>
          <Strong>Failed</Strong> runs — failures, timeouts, and restarts that interrupted a run,
          excluding anything already scheduled for a retry.
        </LI>
        <LI>
          <Strong>Runs waiting to retry</Strong> — an in-progress retry chain, so it&apos;s visible
          rather than silent. Nothing to do.
        </LI>
        <LI>
          <Strong>Stuck</Strong> runs — still <Code>running</Code> after 8 hours. Crash recovery
          clears orphans within a heartbeat now, so anything here means the scheduler itself
          isn&apos;t running.
        </LI>
        <LI>
          <Strong>Skipped runs</Strong> and <Strong>employees missing an AI model</Strong> —
          routines that never actually ran because no model was connected.
        </LI>
        <LI>
          <Strong>Approvals waiting too long</Strong>, <Strong>email delivery failures</Strong>, and{" "}
          <Strong>integration connections</Strong> in an error/expired state.
        </LI>
      </UL>
      <P>
        Every row deep-links to where you fix it — the routine&apos;s run history, the
        employee&apos;s model settings, the approvals inbox, or the relevant settings page. It is
        read-only and computed live from existing data, so there is nothing to configure.
      </P>

      <H2 id="approvals">Approvals</H2>
      <P>
        Some routines should not auto-fire. Flip <Code>approvalRequired</Code> on and the runner
        stops the moment the routine would take a sensitive action — raising an ad budget, sending
        an email, hitting a third-party API. The action is recorded as an <Code>Approval</Code> row.
        A company owner or admin must approve or reject it from a logged-in browser session with
        recent primary and second-factor authentication; API keys and ordinary Members cannot open
        the inbox or decide approvals. Approval claims are one-shot, so double-clicks and concurrent
        reviewers cannot replay the action. If the approved action fails, the row moves to{" "}
        <Code>execution_failed</Code> for investigation instead of becoming eligible to run again.
        Replay payloads, provider results, and raw provider failures are never returned by the inbox
        API.
      </P>
      <P>
        A pending Approval never expires, so a gated tick nobody answers is lost, not queued.
        Genosyn no longer lets that happen in silence: an Approval still pending after{" "}
        <Strong>24 hours</Strong> re-pages the owners and admins with a stall reminder — once per
        row, so the bell nags exactly one extra time. Pending <Strong>Decisions</Strong> and
        overdue <Strong>Handoffs</Strong> get the same treatment; see{" "}
        <DocLink to="/docs/decisions">the Decision Stack</DocLink> and{" "}
        <DocLink to="/docs/employees">AI Employees</DocLink>.
      </P>

      <H3 id="approval-kinds">Built-in approval kinds</H3>
      <UL>
        <LI>
          <Code>routine</Code> — the whole Run is gated.
        </LI>
        <LI>
          <Code>browser_action</Code> — a form submit from an employee whose{" "}
          <DocLink to="/docs/browser">Browser</DocLink> requires approval for submits.
        </LI>
        <LI>
          <Code>mcp_tool</Code> — a guarded tool on a company-configured{" "}
          <DocLink to="/docs/integrations">MCP server</DocLink>. The call is snapshotted and
          replayed on approve.
        </LI>
        <LI>
          <Code>ad_spend</Code> — a spend-increasing ad-platform change above the Connection&apos;s
          threshold. See <DocLink to="/docs/marketing">Paid Marketing</DocLink>.
        </LI>
        <LI>
          <Code>lightning_payment</Code> — a retired kind. Nothing issues one any more; it stays
          readable so Approvals decided before the Lightning connector was removed keep their
          meaning.
        </LI>
      </UL>
    </>
  );
}
