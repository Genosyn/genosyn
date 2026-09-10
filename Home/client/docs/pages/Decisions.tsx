import { Callout, Code, DocLink, H2, LI, P, PageHeader, Strong, UL } from "@/docs/Prose";

export function Decisions() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Decision stack"
        lead={
          <>
            Review what an AI Employee wants to do and give it the information it needs. The stack
            on Home brings proposed work and employee questions together, with context and a clear
            next step for each.
          </>
        }
      />

      <H2 id="what-lands-here">What lands here</H2>
      <P>
        A <Strong>work proposal</Strong> asks you to authorize a specific piece of proactive work,
        such as investigating a customer&apos;s bug report or preparing a quote. An employee can
        read the available evidence to explain the proposal, but waits for an owner or admin to
        approve before carrying it out. See <DocLink to="/docs/reactivity">Proactive work</DocLink>.
      </P>
      <P>
        A <Strong>Decision</Strong> asks for your judgement or missing information: which approach
        to take, what deadline you promised, or who should review a draft. Each choice explains what
        the employee will do with your answer. A Decision answer does not replace approval to start
        proactive work or bypass the employee&apos;s existing limits.
      </P>

      <H2 id="approving-work">Reviewing proposed work</H2>
      <P>
        Owners and admins see <Strong>Work awaiting your approval</Strong> in the stack.
        Open a proposal to read what happened, the proposed plan, and its scope.
        An owner or admin selects <Strong>Approve work</Strong>, reviews the confirmation, then
        selects <Strong>Confirm and start work</Strong>. This authorizes that proposal; future
        proactive work still needs its own review. Select <Strong>Decline</Strong> and then{" "}
        <Strong>Confirm decline</Strong> if you do not want the work to proceed.
      </P>
      <P>
        Approval keeps the original restrictions: work limited to drafts still cannot send mail,
        and a Repository fix still needs its normal review before merging. Approving a plan does
        not add resource access or waive a separate Approval.
      </P>
      <P>
        A proactive Routine&apos;s initial Run finishes as <Strong>Reviewed</Strong>: the employee
        examined evidence and left any proposed work for human review. Delivery is still
        unverified. Approval starts a separate Routine Run that performs the approved work and
        runs the original <DocLink to="/docs/routines#checks">Checks</DocLink> and outcome grading.
        A proposal from an email handover instead starts an approved work session.
      </P>
      <P>
        <Strong>Work approval history</Strong> shows whether the work is in progress, finished,
        failed or declined. Read the <Strong>Reported outcome</Strong> for what the employee
        says it did, and use <Strong>Review proposed work</Strong> to compare it with the plan.
      </P>

      <H2 id="answering">Answering a decision</H2>
      <UL>
        <LI>
          Open <Strong>Home</Strong>, or the <Strong>Decisions</Strong> section for the full list.
          Use <Strong>Search decision stack</Strong> to find a customer, AI Employee, or detail
          from the context or reported outcome.
        </LI>
        <LI>
          Read <Strong>Context from</Strong> the employee. Use <Strong>Read full context</Strong>
          for longer explanations. The source link opens the original email, Routine Run, or
          conversation.
        </LI>
        <LI>
          Need more detail? Press <Strong>Discuss</Strong> to ask the AI Employee that raised the
          decision about its reasoning, alternatives, or tradeoffs.
        </LI>
        <LI>
          Select the option you want and read its explanation. Selecting an option does not send
          it. Add any names, dates, links or instructions the choice needs in the details field.
          Then press <Strong>Send decision</Strong>.
        </LI>
        <LI>
          Nothing to decide? Select <Strong>Dismiss…</Strong> and <Strong>Confirm dismissal</Strong> to remove the row without
          choosing an option or starting follow-up work.
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
        Two people submitting different choices at the same moment produce one answer, not two. The
        second person is told the decision was already made.
      </Callout>

      <H2 id="discussing">Discussing a decision</H2>
      <P>
        Press <Strong>Discuss</Strong> on a decision in <Strong>Home</Strong> or{" "}
        <Strong>Decisions</Strong>. A new private conversation opens with the AI Employee that asked,
        with a draft message linking to that exact decision. Add your question and press{" "}
        <Strong>Send</Strong> when you are ready. Opening the draft sends nothing.
      </P>
      <P>
        You can ask follow-up questions in the same conversation. The employee receives the
        decision&apos;s current context, options, and status each time you send, including the
        recorded answer if someone has since chosen an option. Ask why it recommends an option,
        what it has already checked, or what changes if you wait.
      </P>
      <P>
        Discussion is for understanding the decision. It does not answer or dismiss it, or start
        the proposed work. Return to the decision card, select an option, and send your decision
        when you have made your choice. You can also use <Strong>Discuss</Strong> in <Strong>Decision history</Strong> to
        understand an earlier outcome. If the asking employee has been deleted, its Discuss button
        is unavailable.
      </P>

      <H2 id="what-happens-next">What happens next</H2>
      <P>
        The card explains what sending your decision will do. For an ordinary Decision, it
        normally starts a session briefed with your choice, your details, and the original
        context. The row shows the session running, then the employee&apos;s own report of what
        it did. A recommendation is the employee&apos;s suggestion; nothing is selected for you.
      </P>
      <P>
        Decisions raised during preparation-only work stay with humans, even if an AI
        decision policy normally routes the employee&apos;s questions. Answering records your
        choice and journal entry but starts no new session. The row explains this. The employee
        must obtain any required work Approval before continuing, while preserving the work&apos;s
        delivery restrictions. See <DocLink to="/docs/reactivity">Proactive work</DocLink>.
      </P>
      <P>
        Your answer is also written to that employee&apos;s journal, and the last week of its
        journal is part of every prompt it runs. That is the backstop: if no session can start — no
        {" "}
        <DocLink to="/docs/models">AI Model</DocLink> is connected yet, or the server restarted
        mid-session — the row says so, and the employee still picks the work up on its next run. It
        can also read the answer at any time with its <Code>list_decisions</Code> tool.
        Long answers and context are available in full through <Code>get_decision</Code>.
        AI Employees can read their own questions and those currently waiting for their answer;
        earlier routing does not grant ongoing access.
      </P>
      <P>
        The <Strong>Decision history</Strong> list keeps the trail: what was asked, what was chosen,
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

      <H2 id="not-approvals">Work approvals and Decision answers</H2>
      <P>
        An <Strong>Approval</Strong> holds a specific action until an owner or admin authorizes
        it. Proposed proactive work appears in the stack for review; approving it authorizes
        that proposed work under the original delivery restrictions.
        Other Approvals include a gated{" "}
        <DocLink to="/docs/routines">Routine</DocLink> tick, a payment over your threshold, a{" "}
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
        or declines — through its <Code>decide_decision</Code> tool. A decline, or{" "}
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
        option, never what the answer can execute. See{" "}
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
