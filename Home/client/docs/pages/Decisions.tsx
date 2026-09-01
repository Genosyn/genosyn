import { Callout, Code, DocLink, H2, LI, P, PageHeader, Strong, UL } from "@/docs/Prose";

export function Decisions() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Decision stack"
        lead={
          <>
            When an AI Employee reaches a fork it shouldn&apos;t take alone — a reply it could send,
            a post it could publish, two vendors it could pick — it stacks the question for a human
            instead of guessing. The stack is the first thing on your Home page, and every row is an
            employee waiting on you.
          </>
        }
      />

      <H2 id="what-lands-here">What lands here</H2>
      <P>
        Employees add to the stack deliberately. They are told to ask only when a human&apos;s
        judgement genuinely changes what happens next — not for permission to do the work they were
        hired for, and not for something they could look up. A typical row is work that is already
        finished except for the call: the email is drafted, the post is written, the shortlist is
        down to two.
      </P>
      <P>
        This matters most inside a <DocLink to="/docs/routines">Routine</DocLink>. A routine&apos;s
        brief was written hours or weeks earlier and there is nobody to ask mid-run, so before the
        stack existed an employee in that position had to guess. Now it can stop.
      </P>

      <H2 id="answering">Answering a decision</H2>
      <UL>
        <LI>
          Open <Strong>Home</Strong>, or the <Strong>Decisions</Strong> section for the full list.
        </LI>
        <LI>
          Press <Strong>Show context</Strong> to read what the employee actually wrote — the draft,
          what it already checked, and what each option costs. It is rendered as the employee wrote
          it, so a drafted email reads like an email.
        </LI>
        <LI>
          Press the option you want. You can add a note first; the employee reads it alongside your
          choice.
        </LI>
        <LI>
          Nothing to decide? The <Code>×</Code> dismisses the row and tells the employee nobody
          picked an option, so it stops waiting.
        </LI>
      </UL>
      <P>
        Any Member can answer, not just owners and admins. If the employee addressed the question to
        one person, only they — or an owner or admin — can answer it, so nothing strands behind
        somebody on holiday. Owners and admins get a notification for every unassigned decision; an
        assigned one notifies only its recipient. A decision still unanswered after 24 hours
        re-pages the same people once — the employee that stacked it is blocked until someone picks,
        and a blocked employee should never be a silent one.
      </P>

      <Callout kind="info" title="A decision is answered once.">
        Two people pressing different buttons at the same moment produce one answer, not two. The
        second person is told the decision was already made.
      </Callout>

      <H2 id="what-happens-next">What happens next</H2>
      <P>
        The employee starts working again immediately. Pressing an option kicks off a work session
        right away, briefed with your choice, your note, and the context it stacked with the
        question — so a reply you approved goes out in the next minute rather than waiting for that
        employee&apos;s next scheduled run. The row shows the session running, then the
        employee&apos;s own report of what it did.
      </P>
      <P>
        Your answer is also written to that employee&apos;s journal, and the last week of its
        journal is part of every prompt it runs. That is the backstop: if no session can start — no
        {""}
        <DocLink to="/docs/models">AI Model</DocLink> is connected yet, or the server restarted
        mid-session — the row says so, and the employee still picks the work up on its next run. It
        can also read the answer at any time with its <Code>list_decisions</Code> tool.
      </P>
      <P>
        The <Strong>Already answered</Strong> list keeps the trail: what was asked, what was chosen,
        who chose it, any note, and what the employee did next.
      </P>

      <H2 id="where-it-came-from">Where a question came from</H2>
      <P>
        Every row says which surface the employee was working when it asked, and links straight to
        it — the <DocLink to="/docs/routines">Routine</DocLink> and the exact run, the email thread,
        or the chat. It is the context that decides how you read the question: &ldquo;send the
        pricing reply to Acme?&rdquo; means one thing out of the nightly outreach routine and
        another out of a conversation you had five minutes ago.
      </P>
      <P>
        An employee can retract its own question if the situation moves on. A decision can also
        carry a deadline, after which it stops nagging anyone and shows as expired.
      </P>

      <H2 id="not-approvals">Decisions are not approvals</H2>
      <P>
        The two look similar and are deliberately separate. An <Strong>Approval</Strong> is Genosyn
        holding back an action an employee already attempted — a gated{""}
        <DocLink to="/docs/routines">Routine</DocLink> tick, a payment over your threshold, a{""}
        <DocLink to="/docs/browser">browser form submit</DocLink> — and the server performs that
        exact action once an admin approves it. That is why approvals are admin-only and ask you to
        re-authenticate.
      </P>
      <P>
        A decision performs nothing itself. It records which option a human picked and hands that
        back to the employee, which is why an ordinary Member can answer one. The work session your
        answer starts runs under the employee&apos;s own authority, so anything privileged it then
        does still meets its own approval gate.
      </P>

      <H2 id="routing">Routing to an AI decider</H2>
      <P>
        By default every question waits for a human — no configuration, exactly the behavior above.
        A <Strong>routing rule</Strong> (the <Strong>Routing</Strong> tab on the Decisions page,
        admin-managed) changes that for one asking employee: it names who may answer on a
        human&apos;s behalf — the employee&apos;s <Strong>manager</Strong>, via the org chart&apos;s
        reports-to line, or a <Strong>named employee</Strong>. A decision the employee addressed to
        a specific person is never routed.
      </P>
      <P>
        A routed question skips the creation-time bell. Instead, the decider is briefed in a
        background session under its own authority, investigates with its own tools, and answers —
        or declines — through its <Code>decide_decision</Code> tool. A decline, or{""}
        <Strong>4 hours</Strong> of silence, drops the question back into the human flow with
        exactly the bell it skipped, so routing can delay a human&apos;s attention but never lose
        it. Any Member can still answer a routed question from the stack while it waits — a human
        answer always wins.
      </P>
      <P>
        An AI answer renders as <em>Answered by {"{name}"} (AI)</em>, is written to the audit log
        and the asker&apos;s journal, and starts the asker&apos;s pickup session immediately, the
        same as a human answer. And because answering fires no side effect — the section above — the
        asker&apos;s privileged follow-ups still meet their own gates. Routing decides who picks the
        option, never what the answer can execute. See{""}
        <DocLink to="/docs/autonomy">Earned autonomy</DocLink> for the other half of the
        trust-by-evidence story.
      </P>

      <Callout kind="tip" title="Nothing waiting is the normal state.">
        The stack renders only when an employee is actually blocked. A quiet Home page means your AI
        team is unblocked, not that the feature is off.
      </Callout>
    </>
  );
}
