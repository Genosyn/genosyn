import { Callout, Code, DocLink, H2, KeyList, LI, P, PageHeader, Strong, UL } from "@/docs/Prose";

export function Reactivity() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Reactivity"
        lead={
          <>
            A cron answers <em>when</em>. This page covers the four features that answer everything
            cron can&apos;t: <Strong>Triggers</Strong> fire a{""}
            <DocLink to="/docs/routines">Routine</DocLink> the moment something changes,{""}
            <Strong>Wakeups</Strong> let an employee check back later, <Strong>Workstreams</Strong>
            {""}
            carry working state across Runs, and <Strong>Initiatives</Strong> let an employee
            propose new standing work that a human accepts.
          </>
        }
      />

      <H2 id="triggers">Triggers — Routines that fire on change</H2>
      <P>
        A <Strong>Trigger</Strong> is an event subscription attached to a Routine: when a resource
        family changes anywhere in the company — a deal moves, mail lands, a Run finishes, a{""}
        <DocLink to="/docs/goals">Goal</DocLink> updates — the Routine fires without waiting for its
        next cron slot. Triggers are managed by admins on the routine&apos;s{""}
        <Strong>Settings → Triggers</Strong> card, and the list of subscribable kinds is served from
        the same registry the app&apos;s own live updates run on — anything that refreshes on your
        screen can fire a Routine.
      </P>
      <Callout kind="info" title="An event routes work. It never carries content.">
        Event frames are coarse and <Strong>id-only</Strong>: a fire tells the Routine only that its
        subscribed family changed. The employee then reads the actual state through its own
        grant-gated tools, the same way it would on a cron tick — so a Trigger decides <em>when</em>
        {""}
        work happens, and never smuggles data past a{""}
        <DocLink to="/docs/integrations">Grant</DocLink>.
      </Callout>
      <UL>
        <LI>
          <Strong>Gated Routines stay gated.</Strong> A trigger fire on a routine with{""}
          <Code>approvalRequired</Code> enqueues the same{""}
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
        {""}
        tool, with a note its future self will read (and <Code>cancel_wakeup</Code> when the
        follow-up becomes moot). At the time named, a fresh session starts under the employee&apos;s
        own authority, briefed with that note. The session&apos;s report lands on the wakeup and in
        the employee&apos;s journal, so a timer never fires into silence — and if no AI Model is
        connected when it comes due, the note itself is delivered to the journal instead of being
        lost. Pending wakeups show in a card on the employee&apos;s page.
      </P>
      <UL>
        <LI>
          At most <Strong>20</Strong> pending wakeups per employee, and at most{""}
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
        a migration, a long negotiation, a multi-week cleanup. The employee maintains it with{""}
        <Code>create_workstream</Code>, <Code>update_workstream</Code>, and{""}
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
        actionable slack — a report nobody compiles, a follow-up nobody owns — calls{""}
        <Code>propose_initiative</Code> and files the evidence, the case, and the{""}
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
                brief, and optional{""}
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
        {""}
        section under the AI nav. <Strong>Accepting</Strong> creates precisely the Routine proposed
        — owned by the proposing employee, scheduled immediately. <Strong>Declining</Strong>
        {""}
        journals the reason back to the employee, so the next proposal is better aimed. At most{""}
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
