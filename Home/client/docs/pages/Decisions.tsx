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
          what it already checked, and what each option costs.
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
        assigned one notifies only its recipient.
      </P>

      <Callout kind="info" title="A decision is answered once.">
        Two people pressing different buttons at the same moment produce one answer, not two. The
        second person is told the decision was already made.
      </Callout>

      <H2 id="what-happens-next">What happens next</H2>
      <P>
        Your answer lands in that employee&apos;s journal, and the last week of its journal is part
        of every prompt it runs — so it picks the work back up on its next turn without anyone
        scheduling anything. It can also read the answer immediately with its{" "}
        <Code>list_decisions</Code> tool. The <Strong>Decided</Strong> list on the Decisions page
        keeps the trail: what was asked, what was chosen, who chose it, and any note.
      </P>
      <P>
        An employee can retract its own question if the situation moves on. A decision can also
        carry a deadline, after which it stops nagging anyone and shows as expired.
      </P>

      <H2 id="not-approvals">Decisions are not approvals</H2>
      <P>
        The two look similar and are deliberately separate. An <Strong>Approval</Strong> is Genosyn
        holding back an action an employee already attempted — a gated{" "}
        <DocLink to="/docs/routines">Routine</DocLink> tick, a payment over your threshold, a{" "}
        <DocLink to="/docs/browser">browser form submit</DocLink> — and the server performs that
        exact action once an admin approves it. That is why approvals are admin-only and ask you to
        re-authenticate.
      </P>
      <P>
        A decision performs nothing. It records which option a human picked so the employee can
        carry on, which is why an ordinary Member can answer one. If the employee then does
        something privileged with your answer, that step still meets its own approval gate.
      </P>

      <Callout kind="tip" title="Nothing waiting is the normal state.">
        The stack renders only when an employee is actually blocked. A quiet Home page means your AI
        team is unblocked, not that the feature is off.
      </Callout>
    </>
  );
}
