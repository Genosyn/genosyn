import { Callout, Code, DocLink, H2, LI, P, PageHeader, Strong, UL } from "@/docs/Prose";

export function Decisions() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Decision stack"
        lead={
          <>
            Review consequential choices, major work proposals, and customer replies that need
            your authority. AI Employees handle routine preparation and housekeeping within their
            Grants, keeping this queue focused on work that needs you.
          </>
        }
      />

      <H2 id="what-lands-here">What lands here</H2>
      <P>
        An <Strong>email review</Strong> holds the exact reply or fresh email an AI Employee wants
        to send. It shows the source email, Run, Routine, or conversation, any work already
        completed, and the proposed recipients, subject, and body. The email exists only in Genosyn
        until an owner or admin sends or discards it.
      </P>
      <P>
        A <Strong>work review</Strong> asks you to authorize consequential proactive work, such as
        starting a Repository fix or making a commercial commitment. The proposal explains why
        human judgement or authority is needed. The employee completes permitted research and
        preparation first, then waits for an owner or admin to approve that plan. See{" "}
        <DocLink to="/docs/reactivity">Proactive work</DocLink>.
      </P>
      <P>
        A <Strong>Decision</Strong> asks for consequential judgement or information only a human can
        supply: a change in business direction, a customer commitment, or a significant tradeoff.
        Each choice explains what the employee will do with your answer in up to 240 characters;
        longer context belongs in the Decision body. A Decision answer does not
        replace a required work Approval or bypass the employee&apos;s existing limits.
      </P>
      <P>
        Routine research, reply wording, duplicate checks, recordkeeping and factual customer
        updates do not need their own Decision or work review. Employees inspect sources and use a
        conservative, reversible default when the stakes are low; they record assumptions or skip
        an uncertain update. An exact email review still appears when sending needs your approval.
      </P>

      <H2 id="reading-a-card">Read the timeline, then act</H2>
      <P>
        Cards are timelines rather than blocks of instructions. <Strong>What happened</Strong>
        summarizes the source and links to the original email, Run, or conversation. When the
        employee labels parts of its context, such as <Strong>Why it is blocked</Strong> or{" "}
        <Strong>Recommendation</Strong>, each label becomes its own marked section.{" "}
        <Strong>Why this needs a human decision</Strong> follows on Decisions and work reviews: the
        employee&apos;s own statement of the stakes and why the choice is yours. The next step shows
        what the AI Employee recommends, what it already did, or the exact question it needs
        answered. The final controls are the actions available now. After you answer, approve,
        decline, send, or discard, the card stays in your active stack. Its timeline records your
        choice and updates as the AI Employee continues, finishes, or encounters a problem.
      </P>
      <P>
        Select <Strong>Close</Strong> when you have finished following the outcome. Closing removes
        the card from the active stack; it does not cancel work or delete its timeline. Cards you
        are following stay open across refreshes in this browser, separately for each Member and
        company. Their timelines remain on the <Strong>History</Strong> page after you close them.
      </P>
      <P>
        <Strong>Needs you</Strong> mixes email reviews, work reviews, and questions in urgency and
        age order, so you do not have to learn three separate queues. Open{" "}
        <Strong>Decision stack</Strong> for the complete queue and search.
      </P>
      <P>
        Home shows <Strong>Active decisions</Strong> near the top: up to three pending items,
        ordered by urgency and then oldest first, with the total waiting. Answer a Decision directly
        on Home; owners and admins can also review proposed work and email replies there. The
        section also keeps cards you have acted on visible until you close them, so you can follow
        what happens next. An email you are editing stays visible while new items arrive. Select{" "}
        <Strong>All decisions</Strong> to open the full stack.
      </P>

      <H2 id="active-and-history">Active and History</H2>
      <P>
        The <Strong>Decision stack</Strong> has two pages in its side menu. <Strong>Active</Strong>{" "}
        holds only what still needs someone: waiting questions, email reviews, and work reviews,
        plus the cards you are following after acting on them. <Strong>History</Strong> keeps
        everything already settled: answered, dismissed, and expired Decisions, each with what the
        AI Employee did next, and for owners and admins the email and work reviews that were sent,
        discarded, approved, or declined. On a phone, open the side menu from the top bar, or use
        the <Strong>Decision history</Strong> link on the Active page.
      </P>
      <UL>
        <LI>
          Use <Strong>Search decision history</Strong> to find a customer, AI Employee, answer, or
          reported outcome.
        </LI>
        <LI>
          Narrow Decisions to <Strong>Answered</Strong>, <Strong>Dismissed</Strong>, or{" "}
          <Strong>Expired (legacy)</Strong>. The most recently settled appear first.
        </LI>
        <LI>
          A link to a Decision or review, from a notification, a discussion, or Ask AI, opens
          wherever that item is now: on Active while it waits, on History once it is settled.
        </LI>
      </UL>

      <H2 id="reviewing-email">Reviewing an email</H2>
      <UL>
        <LI>
          Read <Strong>What happened</Strong> and use <Strong>Open original email</Strong> when you
          need the full conversation. If work happened first, the card lists the result and steps
          before the reply.
        </LI>
        <LI>
          Check the exact To, Cc, Bcc, subject, and message under <Strong>Draft reply</Strong> or{" "}
          <Strong>Draft email</Strong>. Select <Strong>Edit email</Strong> to change them.{" "}
          <Strong>Save changes</Strong> updates this review only.
        </LI>
        <LI>
          Select <Strong>Ask employee to edit</Strong> to open a private conversation with a message
          linked to this review. Opening it sends neither the chat message nor the email; add your
          request and send it when ready.
        </LI>
        <LI>
          Select <Strong>Send now</Strong> to send the exact reviewed version, or{" "}
          <Strong>Discard</Strong> to record that it should not be sent. Read the outcome in the
          card&apos;s timeline, then select <Strong>Close</Strong> when you are done.
        </LI>
      </UL>
      <Callout kind="info" title="This is not a mailbox draft.">
        Preparing or editing an email review does not create anything in Gmail Drafts or an IMAP
        Drafts folder. <Strong>Send now</Strong> sends the reviewed message directly;{" "}
        <Strong>Discard</Strong> leaves the mailbox unchanged. A saved mailbox draft appears only
        when a Member deliberately uses the Email composer or another explicit draft flow.
      </Callout>

      <H2 id="approving-work">Reviewing proposed work</H2>
      <P>
        A work review shows <Strong>What happened</Strong>,{" "}
        <Strong>Why this needs a human decision</Strong>, and{" "}
        <Strong>What the AI Employee recommends</Strong>. An owner or admin selects{" "}
        <Strong>Approve &amp; start</Strong> to authorize exactly that plan. Select{" "}
        <Strong>Request changes</Strong> to open a linked conversation with the employee, or{" "}
        <Strong>Don&apos;t do this</Strong> to decline it. Future work that needs human authority
        still needs its own review.
      </P>
      <P>
        Approval keeps the original restrictions: work limited to an email review still cannot send
        mail, and a Repository fix still needs its normal review before merging. Approving a plan
        does not add resource access or waive a separate Approval.
      </P>
      <P>
        A proactive Routine&apos;s initial Run finishes as <Strong>Reviewed</Strong>: the employee
        examined evidence, completed any permitted preparation, and left consequential work for
        human review. Delivery is still unverified. Approval starts a separate Routine Run that
        performs the approved work and runs the original{" "}
        <DocLink to="/docs/routines#checks">Checks</DocLink> and outcome grading. A proposal from an
        email handover instead starts approved handover work. For example, the employee can read a
        customer bug report and related records before proposing a Repository fix. Only{" "}
        <Strong>Approve &amp; start</Strong> lets it begin the Repository work. When it has real
        results, its exact customer reply returns as a separate email review. It is never saved to
        Gmail or IMAP Drafts along the way.
      </P>
      <P>
        The card stays open and shows whether the work is in progress, finished, failed or declined.
        Read its outcome step for what the employee says it did and compare that with the original
        plan. An approval records permission to start; the later outcome shows what actually
        happened. Email timelines record the exact reply as sent, discarded, not sent, or with a
        send outcome Genosyn could not verify. These timelines also remain on the{" "}
        <Strong>History</Strong> page, under <Strong>Email and work reviews</Strong>.
      </P>

      <H2 id="answering">Answering a decision</H2>
      <UL>
        <LI>
          Open <Strong>Decision stack</Strong>. Use <Strong>Search decision stack</Strong> to find a
          customer, AI Employee, or detail from the context or reported outcome.
        </LI>
        <LI>
          Read <Strong>What happened</Strong> and <Strong>Why this needs a human decision</Strong>.
          Longer context opens on its first sections, with the rest named beside{" "}
          <Strong>Read the full context</Strong>; a long reason has{" "}
          <Strong>Read the full reason</Strong>. The source link opens the original email, Routine
          Run, or conversation.
        </LI>
        <LI>
          Need more detail? Press <Strong>Discuss</Strong> to ask the AI Employee that raised the
          decision about its reasoning, alternatives, or tradeoffs.
        </LI>
        <LI>
          Under <Strong>What do you need to decide?</Strong>, select the answer you want and read
          its explanation. Add any names, dates, links or instructions with{" "}
          <Strong>Add guidance</Strong>, then select <Strong>Confirm: {"{answer}"}</Strong>.
        </LI>
        <LI>
          Need more time? Select <Strong>Snooze</Strong>, then choose an hour, one or two days, a
          week, or a month. The question leaves Home and the Decision stack temporarily, then
          returns when that time is up. Snoozing does not answer or dismiss it, or start any work.
        </LI>
        <LI>
          Nothing to decide? Select <Strong>Dismiss</Strong>. It records that outcome without
          choosing an answer; select <Strong>Close</Strong> when you are done reading it. A Decision
          a Member dismissed has an <Strong>Undismiss</Strong> action on the{" "}
          <Strong>History</Strong> page that returns it to the active stack; a question the AI
          Employee retracted does not.
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
        Press <Strong>Discuss</Strong> on a decision in the <Strong>Decision stack</Strong>. A new
        private conversation opens with the AI Employee that asked, with a draft message linking to
        that exact decision. Add your question and press <Strong>Send</Strong> when you are ready.
        Opening the draft sends nothing.
      </P>
      <P>
        You can ask follow-up questions in the same conversation. The employee receives the
        decision&apos;s current context, options, and status each time you send, including the
        recorded answer if someone has since chosen an option. Ask why it recommends an option, what
        it has already checked, or what changes if you wait.
      </P>
      <P>
        Discussion is for understanding the decision. It does not answer or dismiss it, or start the
        proposed work. Return to the decision card, select an option, and confirm your answer when
        you have made your choice. You can also use <Strong>Discuss</Strong> on the{" "}
        <Strong>History</Strong> page to understand an earlier outcome. If the asking employee has
        been deleted, its Discuss button is unavailable.
      </P>

      <H2 id="what-happens-next">What happens next</H2>
      <P>
        Answering an ordinary Decision records your choice and guidance. It does not send mail,
        change a record, or authorize proposed work. Genosyn may then start a pickup session briefed
        with your answer and the original context; that session still runs under the employee&apos;s
        existing authority and meets every normal Approval. The card&apos;s timeline shows the
        answer first, then <Strong>What happened next</Strong>, and stays visible until you close
        it. A recommendation is the employee&apos;s
        suggestion; nothing is selected for you.
      </P>
      <P>
        Decisions raised during preparation-only work stay with humans, even if an AI decision
        policy normally routes the employee&apos;s questions. Answering records your choice and
        journal entry but starts no new session. The row explains this. The employee must obtain any
        required work Approval before continuing, while preserving the work&apos;s delivery
        restrictions. See <DocLink to="/docs/reactivity">Proactive work</DocLink>.
      </P>
      <P>
        Your answer is also written to that employee&apos;s journal, and the last week of its
        journal is part of every prompt it runs. That is the backstop: if no session can start — no{" "}
        <DocLink to="/docs/models">AI Model</DocLink> is connected yet, or the server restarted
        mid-session — the row says so, and the employee still picks the work up on its next run. It
        can also read the answer at any time with its <Code>list_decisions</Code> tool. Long answers
        and context are available in full through <Code>get_decision</Code>. AI Employees can read
        their own questions and those currently waiting for their answer; earlier routing does not
        grant ongoing access.
      </P>
      <P>
        The <Strong>History</Strong> page keeps the trail: what was asked, what was chosen, who
        chose it, any note, and what the employee did next.
      </P>

      <H2 id="where-it-came-from">Where a question came from</H2>
      <P>
        Every row says which surface the employee was working when it asked, and links straight to
        it — the <DocLink to="/docs/routines">Routine</DocLink> and the exact run, the email thread,
        or the chat. It is the context that decides how you read the question: &ldquo;Which pricing
        option should we offer Acme?&rdquo; means one thing out of the nightly outreach routine and
        another out of a conversation you had five minutes ago.
      </P>
      <P>
        A Decision stays pending until someone answers it, a Member dismisses it, or the AI Employee
        retracts its own question because the situation has moved on. It never expires merely
        because time has passed.
      </P>

      <H2 id="not-approvals">Work approvals and Decision answers</H2>
      <P>
        An <Strong>Approval</Strong> holds a specific action until an owner or admin authorizes it.
        Proposed proactive work appears in the stack for review; approving it authorizes that
        proposed work under the original delivery restrictions. An email review is also an Approval:{" "}
        <Strong>Send now</Strong> performs the exact reviewed send. Other Approvals include a gated{" "}
        <DocLink to="/docs/routines">Routine</DocLink> tick, a payment over your threshold, a{" "}
        <DocLink to="/docs/browser">browser form submit</DocLink> — and the server performs that
        exact action once an admin approves it. That is why approvals are restricted to an owner or
        admin in a logged-in browser session; ordinary Members and API keys cannot decide them.
      </P>
      <P>
        A decision performs nothing itself. It records which option a human picked and hands that
        back to the employee, which is why an ordinary Member can answer one. Any later pickup
        session runs under the employee&apos;s own authority, so anything privileged still meets its
        own approval gate.
      </P>

      <H2 id="routing">Routing to an AI decider</H2>
      <P>
        By default every question waits for a human — no configuration, exactly the behavior above.
        A <Strong>routing rule</Strong> (opened with <Strong>Routing</Strong> on the{" "}
        <Strong>Decision stack</Strong> page, admin-managed) changes that for one asking employee,
        or for any employee: it names the AI Employee who may answer on a human&apos;s behalf. The
        first enabled rule that matches the asker decides. A decision the employee addressed to a
        specific person is never routed.
      </P>
      <P>
        Rules once offered <Strong>their manager</Strong> as the decider, read from a reporting
        line. Reporting lines were removed, so a rule saved that way is marked{" "}
        <em>was their manager</em> and no longer routes: its askers&apos; questions page people.
        Delete it and add a rule that names who answers to route them again.
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
        <Strong>Active decisions</Strong> disappears from Home once nothing is waiting and you have
        closed the cards you were following. The full queue remains on the{" "}
        <Strong>Decision stack</Strong> page, and everything settled on its{" "}
        <Strong>History</Strong> page.
      </Callout>
    </>
  );
}
