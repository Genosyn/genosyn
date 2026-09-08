import { Callout, Code, DocLink, H2, KeyList, LI, P, PageHeader, Strong, UL } from "@/docs/Prose";

export function Reactivity() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Proactive work"
        lead={
          <>
            A cron answers <em>when</em>. This page covers the four features that answer everything
            cron can&apos;t: <Strong>Triggers</Strong> fire a{" "}
            <DocLink to="/docs/routines">Routine</DocLink> the moment something changes,{" "}
            <Strong>Wakeups</Strong> let an employee check back later, <Strong>Workstreams</Strong>
            {" "}
            carry working state across Runs, and <Strong>Initiatives</Strong> let an employee
            propose new standing work that a human accepts.
          </>
        }
      />

      <H2 id="start">Start in Proactive</H2>
      <P>
        Open <Strong>Proactive</Strong> from the company navigation. Choose a starter, pick an
        AI Employee and (where needed) a mailbox, review its instructions, then select
        <Strong> Enable workflow</Strong>. The setup form lists missing Grants or a disconnected
        AI Model. It never grants access for you. Owners and admins can enable, pause, and resume
        standing work; every Member can see what is configured.
      </P>
      <P>
        An email starter creates an ordinary rule under <Strong>Email → Rules</Strong>. New
        incoming messages match the existing AI analysis category and are handed to the assigned
        employee; setup never replays historical mail. Turn on AI analysis in Email → Settings and
        keep the mailbox active. Classification alone does not complete the work: the employee
        reads the request and acts through its own Grants. A failed analysis does not fire a rule.
      </P>
      <KeyList rows={[
        { term: "Quote requests", def: "Match or create the Customer, verify pricing, prepare an estimate, and attach its actual PDF to a reply draft. Missing prices or scope become a clarification, never an invented quote." },
        { term: "Customer code issues", def: "Start an isolated Work session in a granted Repository, investigate the report, prepare a fix with tests, and track it to PR review. A queued session is never reported as a finished fix." },
        { term: "Sales enquiries", def: "Create or update the Contact and Deal, record the enquiry as an Activity, and prepare the next reply without assuming marketing consent." },
        { term: "Confirmed spam", def: "Review suspected spam, then file confirmed spam and create an exact-sender rule. Future matching mail moves to Spam when Genosyn syncs; it is not a provider-wide sender block. Disable or delete the exact-sender rule in Email → Rules to undo it." },
        { term: "Unwanted newsletters", def: "Apply the Soul’s explicit preferences. Use verified one-click unsubscribe for legitimate unwanted subscriptions; retain wanted mail and avoid unsubscribe links in suspicious spam." },
      ]} />
      <P>
        The scheduled starters cover overdue invoice reminders, stalled Deals, meeting commitments,
        unanswered customer requests, open Workstreams, and evidence-backed improvement Initiatives.
        They create ordinary <DocLink to="/docs/routines">Routines</DocLink> with editable briefs,
        schedules, acceptance criteria, and Run history. Selected starters also get a Trigger with
        a one-hour minimum interval; the schedule catches work that becomes due without another
        change. Times use the server&apos;s timezone. Each brief limits the employee to ten
        actionable items per Run and asks it to keep unchanged checks quiet.
      </P>
      <H2 id="delivery">Decide how much can happen unattended</H2>
      <P>
        Email starters default to <Strong>Prepare drafts for review</Strong>. This is enforced
        during the handover even if the employee has a Send Grant. Choose
        <Strong> May send when the Soul permits</Strong> only when you want the employee to send
        and its mailbox Grant allows it. The Soul sets your commercial judgement, tone, and
        limits; it cannot grant itself access or override a company Policy or Approval.
        Draft and triage handovers cannot create unrestricted deferred work or delegate around
        their delivery restriction.
      </P>
      <P>
        Scheduled starters also carry an enforced draft ceiling, preserved when their instructions
        or schedules are edited. Review and send their email from Email → Drafts. A quotation PDF
        made from a draft estimate visibly says DRAFT and remains unissued; attaching or mailing it
        never accepts the estimate, creates an invoice, or posts to the ledger. See
        <DocLink to="/docs/finance"> Finance</DocLink> for its lifecycle.
      </P>
      <P>
        Repository publication needs the employee&apos;s Write Grant plus an explicitly granted,
        pinned GitHub or Forgejo Connection. The employee can open a PR only from its own completed
        session branch; it cannot merge or publish the default branch. Repositories using a private
        token or SSH credential still need Member publication. Enable <Strong>Follow through on
        open work</Strong> for the same employee to revisit saved sessions and finish the next
        authorized step. See <DocLink to="/docs/repositories">Repositories</DocLink>.
      </P>
      <P>
        Under <Strong>Your standing work</Strong>, use <Strong>Review work</Strong> to open the
        underlying rule or Routine and its history. <Strong>Pause</Strong> stops future starts;
        use a <DocLink to="/docs/standdowns">Standdown</DocLink> when work already in progress
        must stop. Enabling the same starter for the same employee and mailbox twice reuses its
        existing configuration, including a paused state.
      </P>

      <H2 id="triggers">Triggers — Routines that fire on change</H2>
      <P>
        A <Strong>Trigger</Strong> is an event subscription attached to a Routine: when a resource
        family changes anywhere in the company — a deal moves, mail lands, a Run finishes, a{" "}
        <DocLink to="/docs/goals">Goal</DocLink> updates — the Routine fires without waiting for its
        next cron slot. Triggers are managed by admins on the routine&apos;s{" "}
        <Strong>Settings → Triggers</Strong> card, and the list of subscribable kinds is served from
        the same registry the app&apos;s own live updates run on — anything that refreshes on your
        screen can fire a Routine.
      </P>
      <Callout kind="info" title="An event routes work. It never carries content.">
        Event frames are coarse and <Strong>id-only</Strong>: a fire tells the Routine only that its
        subscribed family changed. The employee then reads the actual state through its own
        grant-gated tools, the same way it would on a cron tick — so a Trigger decides <em>when</em>
        {" "}
        work happens, and never smuggles data past a{" "}
        <DocLink to="/docs/integrations">Grant</DocLink>.
      </Callout>
      <UL>
        <LI>
          <Strong>Gated Routines stay gated.</Strong> A trigger fire on a routine with{" "}
          <Code>approvalRequired</Code> enqueues the same{" "}
          <DocLink to="/docs/routines#approvals">Approval</DocLink> a cron tick would — the webhook
          precedent, verbatim. An event is never a bypass.
        </LI>
        <LI>
          <Strong>A minimum interval bounds every Trigger</Strong> — 15 minutes by default, floor of
          1 minute. However many changes land inside the window, the Routine fires at most once, so
          a routine that writes the very family it subscribes to converges to one fire per interval
          instead of a hot loop.
        </LI>
      </UL>
      <Callout kind="warn" title="A Trigger is not a Signal.">
        A Revenue <DocLink to="/docs/signals">Signal</DocLink> stays a cron-evaluated query over
        your own database. A Trigger is a change subscription on Genosyn&apos;s own resources. Same
        reflex, different words — deliberately.
      </Callout>

      <H2 id="wakeups">Wakeups — check back later</H2>
      <P>
        A <Strong>Wakeup</Strong> is a timed follow-up session an employee schedules for itself —
        &quot;check back on the invoice in two days&quot; — using the <Code>schedule_wakeup</Code>
        {" "}
        tool, with a note its future self will read (and <Code>cancel_wakeup</Code> when the
        follow-up becomes moot). At the time named, a fresh session starts under the employee&apos;s
        own authority, briefed with that note. The session&apos;s report lands on the wakeup and in
        the employee&apos;s journal, so a timer never fires into silence — and if no AI Model is
        connected when it comes due, the note itself is delivered to the journal instead of being
        lost. Pending wakeups show in a card on the employee&apos;s page.
      </P>
      <UL>
        <LI>
          At most <Strong>20</Strong> pending wakeups per employee, and at most{" "}
          <Strong>90 days</Strong> out — standing work that far ahead should be a Routine, not a
          timer.
        </LI>
      </UL>
      <Callout kind="info" title="A fresh briefed session, not a parked transcript.">
        A wakeup deliberately does not freeze a conversation and thaw it later. It starts a clean
        session carrying only the note — the same shape the platform uses everywhere it resumes
        work, from <DocLink to="/docs/decisions">Decision</DocLink> pickups to Handoff kickoffs.
        What matters survives in writing; what doesn&apos;t, doesn&apos;t.
      </Callout>

      <H2 id="workstreams">Workstreams — state that survives the Run</H2>
      <P>
        A <Strong>Workstream</Strong> is a persistent state document for work that spans many Runs —
        a migration, a long negotiation, a multi-week cleanup. The employee maintains it with{" "}
        <Code>create_workstream</Code>, <Code>update_workstream</Code>, and{" "}
        <Code>list_workstreams</Code>; each update replaces the document in full, so the latest
        version is always the whole truth. Binding a workstream to one of the employee&apos;s
        Routines makes every future Run brief open with the latest state — the context seam that
        used to be journal archaeology.
      </P>
      <UL>
        <LI>
          <Strong>One active workstream per Routine</Strong>, so the brief seam stays unambiguous —
          and at most 20 active per employee.
        </LI>
        <LI>
          The terminal states are <Code>done</Code> or <Code>abandoned</Code> with a reason. An
          admin can close a stale workstream from the card on the Routine page.
        </LI>
      </UL>
      <Callout kind="info" title="A Workstream is not a Project.">
        A <DocLink to="/docs/tasks">Project</DocLink> is the humans&apos; task manager — shared,
        assigned, tracked. A Workstream is one employee&apos;s own working state, written by it and
        read back to it. Humans can read a workstream; they don&apos;t work out of it.
      </Callout>

      <H2 id="initiatives">Initiatives — work an employee proposes</H2>
      <P>
        An <Strong>Initiative</Strong> is proactive work discovery. An employee that notices
        actionable slack — a report nobody compiles, a follow-up nobody owns — calls{" "}
        <Code>propose_initiative</Code> and files the evidence, the case, and the{" "}
        <Strong>exact Routine it wants</Strong>:
      </P>
      <KeyList
        rows={[
          {
            term: "title",
            def: "What the initiative is called. Duplicate pending titles are refused.",
          },
          {
            term: "routine",
            def: (
              <>
                The name, cron expression — validated at propose time, not on accept — markdown
                brief, and optional{" "}
                <DocLink to="/docs/routines#outcome-check">acceptance criteria</DocLink> of the
                Routine the employee is asking for.
              </>
            ),
          },
          {
            term: "evidence & case",
            def: "Why this work should exist — what the employee observed, and what running the routine would change.",
          },
        ]}
      />
      <P>
        Admins are paged, and pending initiatives live in their own <Strong>Initiatives</Strong>
        {" "}
        section under the AI nav. <Strong>Accepting</Strong> creates precisely the Routine proposed
        — owned by the proposing employee, scheduled immediately. <Strong>Declining</Strong>
        {" "}
        journals the reason back to the employee, so the next proposal is better aimed. At most{" "}
        <Strong>5</Strong> initiatives can be pending per employee.
      </P>
      <Callout kind="info" title="Nothing exists until a human accepts.">
        An Initiative is a proposal of standing work, not the work itself. The employee cannot
        schedule its own idea into existence — the accept click is what creates the Routine, and it
        creates exactly what was proposed, nothing more.
      </Callout>
    </>
  );
}
