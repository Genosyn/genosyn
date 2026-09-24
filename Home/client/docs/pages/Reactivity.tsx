import { Callout, Code, DocLink, H2, KeyList, LI, P, PageHeader, Strong, UL } from "@/docs/Prose";

export function Reactivity() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Proactive work"
        lead={
          <>
            Proactive work is on by default. AI Employees notice what needs attention and handle
            routine preparation within their Grants. Consequential choices and major work come to
            you for review. A customer reply arrives as the exact email for you to send, edit,
            discuss, or discard. Genosyn assigns ready responsibilities as their AI Models,
            resources, and Grants become available.
            <Strong> Triggers</Strong> fire a <DocLink to="/docs/routines">Routine</DocLink> the
            moment something changes, <Strong>Wakeups</Strong> let an employee check back later,{" "}
            <Strong>Workstreams</Strong> carry working state across Runs, and{" "}
            <Strong>Initiatives</Strong> let an employee propose new standing work that a human
            accepts.
          </>
        }
      />

      <H2 id="start">Review your proactive work</H2>
      <P>
        Open <Strong>Proactive</Strong> from the company navigation.{" "}
        <Strong>How proactive work moves</Strong> explains preparation and human review,{" "}
        <Strong>Automatic setup</Strong>
        controls future automatic assignments, <Strong>Standing work</Strong> shows what is running
        or paused, and the <Strong>Starter library</Strong> holds ready-made responsibilities you
        can customize.
      </P>
      <P>
        Owners and admins can add work in two ways. <Strong>New Routine</Strong> opens the existing
        Routine flow and creates scheduled work directly. <Strong>Ask AI Employee</Strong> opens an
        editable, unsent Chat draft asking the selected employee to inspect the evidence and propose
        an Initiative. Nothing is sent until the Member submits that Chat message, and nothing is
        scheduled from the Initiative until an owner or admin accepts it.
      </P>
      <P>
        <Strong>Automatic setup</Strong> starts <Strong>On</Strong> for both new and existing
        companies. Genosyn assigns ready responsibilities in the background, without a first visit
        or setup click. Shared responsibilities get one automatic owner; daily responsibility
        reviews and weekly work reviews go to every ready employee. Assignment never adds Grants,
        and work waits until an AI Employee has a connected AI Model and the required resource
        access.
      </P>
      <Callout kind="info" title="Routine preparation moves without another approval">
        Proactive Routines, automatic email handovers and Routines started by a Trigger or webhook
        inspect the available evidence and can complete bounded, reversible preparation. Within
        existing Grants, this includes factual Contact details, Deal descriptions and next steps,
        Activity notes, ordinary Follow-ups, the employee&apos;s own Workstream tracking, and
        marking, starring or archiving email. Research, duplicate checks and reply preparation do
        not need a separate work review. Major work needs a concrete reason for human judgement or
        authority before it reaches the <DocLink to="/docs/decisions">Decision stack</DocLink>.
        Preparation cannot change ownership, Deal value or Deal Stage, consent or access, spend
        money, start Repository work or create automation. It creates no Gmail or IMAP draft and
        sends no mail.
        <Strong> Send now</Strong> authorizes only the reviewed email;{" "}
        <Strong>Approve &amp; start</Strong> authorizes only the reviewed work. Original Grants and
        delivery restrictions remain in force, including on retry.
        <Strong> Improve my work</Strong> keeps its separate Revision proposal process below.
      </Callout>
      <P>
        A proactive Run finishes as <Strong>Reviewed</Strong> after examining evidence and any
        permitted preparation. This leaves delivery unverified. A reply-only email can show its
        exact in-Genosyn review without creating provider-side state. When you approve underlying
        work, a separate Routine Run or approved email handover carries out the plan under the
        original Checks and outcome grading. Any final customer reply returns to the stack as a
        separate review after the work has real results. The outcome step in the stack summarizes
        the work; open the Run to inspect its independent verification.
      </P>
      <H2 id="daily-ownership">A useful next step across the app</H2>
      <P>
        Every ready AI Employee receives <Strong>Advance my responsibilities</Strong>, scheduled for
        weekdays at 08:00 in the server&apos;s timezone. Find it in <Strong>Standing work</Strong>
        and select <Strong>Open</Strong> to edit its schedule or brief. This daily Routine reads
        current assignments, deadlines and granted records, inspects the original evidence, and
        completes routine preparation or proposes consequential work for your review. It also checks
        due Workstreams, earlier outcomes, and review feedback from previous Runs.
      </P>
      <KeyList
        rows={[
          {
            term: "Projects and Todos",
            def: "Find assigned work and reviews that need attention, prioritizing urgency and due dates. Read existing comments and status before proposing work so immediate assignment work is not duplicated.",
          },
          {
            term: "Handoffs and Decisions",
            def: "Notice pending handoffs, resolved handoffs, and answers that unblock earlier work. Prepare a recommendation for a Decision routed to the employee; answering retains its own authority requirements.",
          },
          {
            term: "Goals and meetings",
            def: "Check owned Goals approaching a deadline or missing a fresh measurement, and meetings assigned to the employee. Use actual notes and commitments; avoid creating duplicate follow-ups.",
          },
          {
            term: "Repositories",
            def: "Recover recent ready, failed or published Work sessions even if their original turn forgot to track them. Inspect actual session state and propose the next step for review.",
          },
          {
            term: "Finance and Revenue",
            def: "Review assigned Revenue Follow-ups that are due, accepted estimates awaiting a Member’s conversion, and unreviewed Finance transactions. Inspect the live records before preparing work; never create a second invoice to imitate conversion.",
          },
          {
            term: "Marketing and signing",
            def: "Review Experiments past their planned end on the employee’s active Campaigns, and signature requests expiring within seven days. Existing Grants, Campaign controls, Approvals and sending limits continue to apply.",
          },
          {
            term: "Company knowledge",
            def: "Review recent changes in granted Notes, Base tables, Charts and Resources, plus failed Resource ingestion. A changed or old document is a cue to inspect, not a reason to rewrite it.",
          },
        ]}
      />
      <P>
        The evidence snapshot is bounded and read-only. It selects current assignments and Grants
        before limiting results, provides real record IDs, and names the existing readers for
        follow-up. It does not read private credentials, raw transcripts, database row contents or
        arbitrary external systems. The employee records source changes and artifact IDs in its
        Workstream and stays quiet when neither evidence nor feedback changed. Shared commercial
        work is coordinated with its existing owner.
      </P>
      <P>
        The daily starter handles permitted preparation and asks for approval when consequential
        work needs human authority. An exact customer reply must still return to the Decision stack
        for an owner or admin to send or discard. It does not start new automation, spend money,
        launch outreach, or send signature reminders. For low-stakes uncertainty, the employee
        checks sources, chooses a conservative reversible default, records assumptions or skips the
        update. A Decision is reserved for a consequential choice a human needs to make. Answering
        it records information; it does not approve work or perform a side effect. Creating this
        daily Routine alone does not add half-hourly checks; existing immediate assignment handling
        and specialist Routines continue their work.
      </P>
      <H2 id="routine-ideas">Initiatives for new Routines and improvements to existing ones</H2>
      <P>
        Repeated manual work, recurring customer questions, missed handoffs and reports rebuilt by
        hand can become <Strong>Initiatives</Strong>. AI Employees read pending, accepted and
        declined Initiatives across the company, including the reviewer&apos;s feedback, before
        filing another. Each Initiative includes concrete evidence, a full Routine brief, a schedule
        and measurable success criteria. The daily brief asks for at most one Initiative per Run and
        normally no more than one a week.
      </P>
      <P>
        Use <Strong>New Routine</Strong> when you already know the scheduled work you want. Use
        <Strong>Ask AI Employee</Strong> when you want an employee to inspect the company&apos;s
        evidence, check existing Routines and earlier Initiatives, and make a recommendation first.
        The editable Chat draft asks for the evidence, exact Routine brief, schedule, and measurable
        success criteria; opening it does not send the request or create work.
      </P>
      <P>
        Open <Strong>Initiatives</Strong> from the Proactive page to review what employees have
        filed. An admin&apos;s <Strong>Accept</Strong> creates the proposed Routine. Exact duplicate
        pending work and already accepted work are refused, including after the accepted Routine was
        paused or deleted. A declined Initiative needs changed work or new evidence before it can be
        filed again. The queue permits at most five pending Initiatives per employee. Improvements
        to an existing Routine use a<DocLink to="/docs/improvement"> Revision proposal</DocLink>{" "}
        instead of overlapping work.
      </P>
      <P>
        Owners and admins can turn <Strong>Automatic setup</Strong> off to stop future automatic
        assignments. Existing work keeps running: use its individual <Strong>Pause</Strong> control
        to stop future starts. Automatic setup preserves customized and paused work, and does not
        recreate work you deliberately deleted. Every Member can see the setting and standing work.
      </P>
      <P>
        In <Strong>Standing work</Strong>, use <Strong>Open</Strong> to edit an existing rule or
        Routine. To assign a ready-made responsibility, open the <Strong>Starter library</Strong>{" "}
        and select <Strong>Set up</Strong>, or <Strong>Add another</Strong> when that starter is
        already assigned. Choose an AI Employee and (where needed) a mailbox, review its
        instructions, then select <Strong>Assign work</Strong>. The form lists missing Grants or a
        disconnected AI Model. Manual setup remains available when Automatic setup is off.
      </P>
      <P>
        Email starters also need a working AI analysis reader in <Strong>Email → Settings</Strong>.
        That reader can be different from the employee doing the work; it needs mailbox Read access
        and a connected AI Model so new messages receive the categories that start work.
      </P>
      <P>
        An email starter creates an ordinary rule under <Strong>Email → Rules</Strong>. New incoming
        messages match the existing AI analysis category and are handed to the assigned employee;
        setup never replays historical mail. Turn on AI analysis in Email → Settings and keep the
        mailbox active. Classification alone does not complete the work: the employee reads the
        request and either prepares an exact reply review or proposes underlying work through its
        own Grants. A failed analysis does not fire a rule. The following describes what each
        starter can do after work approval.
      </P>
      <KeyList
        rows={[
          {
            term: "Quote requests",
            def: "Match or create the Customer, verify pricing, prepare an estimate, and return an exact customer reply for review. Missing prices or scope become a clarification, never an invented quote.",
          },
          {
            term: "Customer code issues",
            def: "First show the customer report and proposed investigation in a work review. After approval, start a Work session on a separate branch in a granted Repository, investigate, prepare a fix with tests, and track it to PR review. The customer reply returns for separate review only after there are real results.",
          },
          {
            term: "Sales enquiries",
            def: "Create or update the Contact and Deal, record the enquiry as an Activity, and prepare the next reply without assuming marketing consent.",
          },
          {
            term: "Confirmed spam",
            def: "Review suspected spam, then file confirmed spam and create an exact-sender rule. Future matching mail moves to Spam when Genosyn syncs; it is not a provider-wide sender block. Disable or delete the exact-sender rule in Email → Rules to undo it.",
          },
          {
            term: "Unwanted newsletters",
            def: "Apply the Soul’s explicit preferences. Use verified one-click unsubscribe for legitimate unwanted subscriptions; retain wanted mail and avoid unsubscribe links in suspicious spam.",
          },
        ]}
      />
      <P>
        The scheduled starters cover overdue invoice reminders, stalled Deals, meeting commitments,
        unanswered customer requests, open Workstreams, daily responsibility reviews,
        evidence-backed improvement Initiatives, and reviews of an employee&apos;s own work. They
        create ordinary <DocLink to="/docs/routines">Routines</DocLink> with editable briefs,
        schedules, acceptance criteria, and Run history. Selected starters also get a Trigger with a
        one-hour minimum interval; the schedule catches work that becomes due without another
        change. Times use the server&apos;s timezone. Each brief limits the employee to ten
        actionable items per Run and asks it to keep unchanged checks quiet.
      </P>
      <P>
        <Strong>Improve my work</Strong> is assigned automatically to each AI Employee with a
        connected AI Model, with no extra resource Grant needed to review its own work. It runs on
        Fridays at 15:00 in the server&apos;s timezone. The employee reviews its recent Runs,
        Lessons, email handovers, Repository Work sessions, and earlier revision feedback, then
        proposes at most one concrete change supported by that evidence. It stays quiet without new
        evidence and avoids repeating pending or rejected Revision proposals. This review can read
        its own evidence, track its review, and stage a Revision proposal; it cannot apply edits,
        send email, change business records, or propose changes to acceptance criteria or Checks.
      </P>
      <P>
        Under <Strong>How proactive work moves</Strong>, select <Strong>Revisions</Strong>. Owners
        and admins review the proposed change and choose <Strong>Apply</Strong> or
        <Strong> Reject</Strong>; the employee never applies its own Revision proposal. Later
        reviews check meaningful outcomes after an applied change. You can edit or pause this
        Routine like other standing work, and automatic setup preserves your edits, pauses, and
        deletions. See <DocLink to="/docs/improvement">The improvement loop</DocLink> for the review
        process and notifications.
      </P>
      <H2 id="delivery">Review customer delivery separately</H2>
      <P>
        Automatic email starters keep customer delivery separate from work approval. If a message
        needs routine research, factual customer updates or a reply, the employee completes that
        preparation and puts the reply straight into an email review. Consequential work, including
        starting a Repository Work session, needs an approved plan first; completing it still does
        not send mail. The employee returns the exact final message to the stack, where an owner or
        admin can <Strong>Send now</Strong>, <Strong>Edit email</Strong>,{" "}
        <Strong>Ask employee to edit</Strong>, or <Strong>Discard</Strong>.
      </P>
      <P>
        Those review messages live only in Genosyn. They never appear in Gmail Drafts or an IMAP
        Drafts folder, even when the employee has a Send Grant. Editing updates the review only;
        sending delivers the exact reviewed version directly. Genosyn checks the live mailbox
        Connection, Grant, source email, attachments, Suppressions, and company Policies again at
        delivery. The Soul sets commercial judgement, tone, and limits, but cannot grant itself
        access or override a company Policy or Approval. See{" "}
        <DocLink to="/docs/decisions#reviewing-email">Reviewing an email reply</DocLink>.
      </P>
      <P>
        Scheduled starters with the safe email-preparation ceiling also put each exact reply or
        fresh outbound email in the Decision stack. They do not create Gmail or IMAP drafts;
        selecting <Strong>Send now</Strong> is the only delivery action. A quotation PDF made from a
        draft estimate visibly says DRAFT and remains unissued; attaching or mailing it never
        accepts the estimate, creates an invoice, or posts to the ledger. See{" "}
        <DocLink to="/docs/finance">Finance</DocLink> for its lifecycle.
      </P>
      <P>
        A Repository Write Grant lets an employee push its own completed Work session branch using
        the repository&apos;s stored SSH key or HTTPS token. On GitHub or a connected Forgejo /
        Gitea server, a stored HTTPS personal access token can also open pull requests without a
        separate Connection Grant. SSH and Connection-backed repositories need the exact GitHub or
        Forgejo Connection selected under <Strong>Pull request Connection</Strong> in Repository
        Settings and separately granted to that employee. The employee cannot merge or publish the
        default branch. <Strong>Follow through on open work</Strong> lets the same employee revisit
        saved sessions and propose the next step for your review; check its assignment under
        <Strong> Standing work</Strong>. See
        <DocLink to="/docs/repositories"> Repositories</DocLink>.
      </P>
      <P>
        Under <Strong>Standing work</Strong>, use <Strong>Open</Strong> to view the underlying rule
        or Routine and its history. <Strong>Pause</Strong> stops future starts; use a
        <DocLink to="/docs/standdowns"> Standdown</DocLink> when work already in progress must stop.
        Assigning the same starter for the same employee and mailbox twice reuses its existing
        configuration, including a paused state.
      </P>

      <H2 id="triggers">Triggers — Routines that fire on change</H2>
      <P>
        A <Strong>Trigger</Strong> is an event subscription attached to a Routine: when a resource
        family changes anywhere in the company — a deal moves, mail lands, a Run finishes, a{" "}
        <DocLink to="/docs/goals">Goal</DocLink> updates — the Routine fires without waiting for its
        next cron slot. The resulting Run reads evidence, completes permitted preparation and
        requests work approval when consequential work needs human authority. Triggers are managed
        by admins on the routine&apos;s <Strong>Settings → Triggers</Strong> card, and the list of
        subscribable kinds is served from the same registry the app&apos;s own live updates run on —
        anything that refreshes on your screen can fire a Routine.
      </P>
      <Callout kind="info" title="An event routes work. It never carries content.">
        Event frames are coarse and <Strong>id-only</Strong>: a fire tells the Routine only that its
        subscribed family changed. The employee then reads the actual state through its own
        grant-gated tools, the same way it would on a cron tick — so a Trigger decides <em>when</em>{" "}
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
        &quot;check back on the invoice in two days&quot; — using the <Code>schedule_wakeup</Code>{" "}
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
        <Code>create_workstream</Code> and <Code>update_workstream</Code>; each update replaces the
        document in full, so the latest version is always the whole truth. Binding a workstream to
        one of the employee&apos;s Routines makes every future Run brief open with the latest state
        — the context seam that used to be journal archaeology.
      </P>
      <P>
        <Code>list_workstreams</Code> returns compact pages of five active Workstreams by default,
        with a total count and the next offset; <Code>all: true</Code> includes finished work.{" "}
        <Code>get_workstream</Code> reads one known ID directly, including finished work, and pages
        through its state document, objective, or closing reason. Both reads report which text was
        omitted. The employee can read only its own Workstreams, and background business work still
        cannot read self-review tracking. These are live reads; a changed update time means the
        document changed between pages.
      </P>
      <P>
        Shorter unfinished work can{" "}
        <DocLink to="/docs/routines#continuations">continue automatically</DocLink> from a saved Run
        checkpoint without creating a Workstream. For longer work, keep the latest source positions
        and unresolved items in the linked Workstream. Give each scheduled Run a bounded batch of
        changed or due records and save progress after each batch; later Runs can pick up the
        backlog without rereading unchanged records. The initial Run and its automatic continuations
        share the original time limit, with no total model token limit. Genosyn yields at a newly
        saved actionable checkpoint after about two million tokens in a Run, continuing while time
        and automatic continuations remain. An owner or admin can resume unfinished saved work with
        a fresh time window through <Strong>Resume unfinished work</Strong> in the Run log.
        Employees can also page through Journal summaries and retrieve a full entry in chunks, so an
        older audit remains reachable even when recent history or a long entry would fill one
        response.
      </P>
      <P>
        Temporary parallel workers return short previews and stable result IDs. Their evidence is
        saved independently of the parent: after a timeout, a retry or continuation in the same Run
        lineage can use <Code>get_parallel_work_result</Code> to recover it in bounded pages. Direct
        chats retain results within that exact conversation and requester authority. Current access
        is checked again on every read; removed or changed Grants withhold the saved output. Results
        are deleted with their Routine, conversation, employee, company, or requesting Member.
        Unscoped turns retain results only until that turn ends.
      </P>
      <P>
        Repeating an identical brief reuses its saved result. Failed or interrupted work remains
        visibly incomplete; inspect its evidence and Effects before revising the brief. Each parent
        turn retains at most 12 results, 256,000 characters per result and 1,000,000 characters in
        total, with explicit coverage for any text it could not retain. Result listings have their
        own continuation offsets. Include exact <Code>requiredTools</Code> in a delegated brief:
        unavailable tools fail preflight before workers start. Routine retries also verify the tools
        and Grants recorded by earlier attempts before contacting the AI Model.
      </P>
      <UL>
        <LI>
          <Strong>One active workstream per Routine</Strong>, so the brief seam stays unambiguous —
          and at most 20 active per employee. Listings show active capacity. To make space, the
          employee can set <Code>status: archived</Code> with a reason through{" "}
          <Code>update_workstream</Code>; this preserves the objective and state document.
        </LI>
        <LI>
          The terminal states are <Code>done</Code> or <Code>abandoned</Code> with a reason. An
          admin can close a stale workstream from the card on the Routine page.
        </LI>
        <LI>
          Resume explicitly with <Code>status: active</Code>. Resuming needs a free active slot and
          cannot take a Routine already bound to another active Workstream. Archived work stays
          available through <Code>all: true</Code> or a direct ID read.
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
        Admins are paged, and pending Initiatives live in their own <Strong>Initiatives</Strong>{" "}
        section under the AI nav. <Strong>Accepting</Strong> creates precisely the Routine proposed
        — owned by the proposing employee, scheduled immediately. <Strong>Declining</Strong>{" "}
        journals the reason back to the employee, so the next Initiative is better aimed. At most{" "}
        <Strong>5</Strong> Initiatives can be pending per employee.
      </P>
      <Callout kind="info" title="Nothing exists until a human accepts.">
        An Initiative is standing work an employee has put forward, not the work itself. The
        employee cannot schedule it into existence — the accept click is what creates the Routine,
        and it creates exactly what was proposed, nothing more.
      </Callout>
    </>
  );
}
