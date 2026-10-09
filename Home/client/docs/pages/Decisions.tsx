import { Callout, Code, DocLink, H2, LI, P, PageHeader, Strong, UL } from "@/docs/Prose";

export function Decisions() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Decision stack"
        lead={
          <>
            Answer the few big choices your AI Employees cannot make alone, and review the work
            plans and customer emails that need your authority. Each item is one short row you can
            read in seconds; everything else waits behind <Strong>Details</Strong>.
          </>
        }
      />

      <H2 id="what-lands-here">What lands here</H2>
      <P>
        A <Strong>Decision</Strong> asks for consequential judgement or information only a person
        can supply: a change in business direction, a customer commitment, or a significant
        tradeoff. The AI Employee writes the question in plain words, one or two sentences about
        what is going on, the answer it recommends and why, and two or three choices. Each choice
        can explain what the employee will do with your answer in up to 240 characters; longer
        context belongs in the Decision&apos;s details. A Decision answer does not replace a
        required work Approval or bypass the employee&apos;s existing limits.
      </P>
      <P>
        An <Strong>email review</Strong> holds the exact reply or fresh email an AI Employee wants
        to send. The email exists only in Genosyn until an owner or admin sends or discards it.
      </P>
      <P>
        A <Strong>work review</Strong> asks you to authorize consequential proactive work, such as
        starting a Repository fix or making a commercial commitment. The employee completes
        permitted research and preparation first, then waits for an owner or admin to approve that
        plan. See <DocLink to="/docs/reactivity">Proactive work</DocLink>.
      </P>

      <H2 id="fewer-questions">How the stack stays short</H2>
      <P>
        Routine research, reply wording, duplicate checks, recordkeeping and factual customer
        updates never need a Decision. Employees inspect their sources and choose a conservative,
        reversible default when the stakes are low. Beyond that, every new question passes four
        checks before it reaches you:
      </P>
      <UL>
        <LI>
          <Strong>One combined question.</Strong> An AI Employee cannot ask a question it already
          has waiting. A question counts as the same when its wording matches one that is waiting,
          when it comes from the same Run, email thread or chat as one that is waiting, or when it
          comes from the same Routine and is about the same thing — the same customer, deal or
          reference. Nothing new is created and nobody is paged again; the employee is pointed at
          the question already waiting and told to fold any new facts into it.
        </LI>
        <LI>
          <Strong>A few at a time.</Strong> Each AI Employee can have at most{" "}
          <Strong>3 questions</Strong> waiting at once, snoozed ones included. A fourth is refused
          until one is answered, dismissed, or retracted by the employee, which keeps working within
          its own authority meanwhile.
        </LI>
        <LI>
          <Strong>Your instructions.</Strong> The company&apos;s{" "}
          <DocLink to="/docs/decisions#settings">Settings</DocLink> decide which kinds of questions
          belong at all.
        </LI>
        <LI>
          <Strong>Plain words.</Strong> The question, its one-line summary and the recommendation
          are written for a busy owner, without IDs or jargon, and are kept short.
        </LI>
      </UL>
      <P>
        None of this touches email or work reviews: they are Approvals, and each still needs its
        own answer from a person.
      </P>

      <H2 id="reading-a-row">Read a row, then act</H2>
      <P>
        Every item is one short row. A Decision shows who asks and when, the question, one plain
        line about what is going on, and <Strong>Recommends:</Strong> with the answer the employee
        suggests (its choice is also marked with a light bulb). The answers sit right below. An
        email review shows who the email is for, its subject and its first lines, with{" "}
        <Strong>Send now</Strong>, <Strong>Edit email</Strong>,{" "}
        <Strong>Ask employee to edit</Strong> and <Strong>Discard</Strong>. A work review shows why
        it needs you and the plan in a line, with <Strong>Approve &amp; start</Strong>,{" "}
        <Strong>Request changes</Strong> and <Strong>Don&apos;t do this</Strong>.
      </P>
      <P>
        Select <Strong>Details</Strong> on a row for everything else, and{" "}
        <Strong>Hide details</Strong> to fold it away. For a Decision that is{" "}
        <Strong>Why it needs you</Strong> (the employee&apos;s statement of the stakes),{" "}
        <Strong>Background</Strong> (its context, split into the sections it labelled, such as{" "}
        <Strong>What I checked</Strong>), <Strong>The choices</Strong> with what each one means,
        and <Strong>Asked from</Strong> with links to the Routine and Run, email thread or chat.
        Rows asked before Genosyn kept a one-line summary show the first sentence of the stated
        reason instead, and recommend the option the employee marked.
      </P>
      <P>
        When several emails are waiting they gather under one heading, such as{" "}
        <Strong>3 emails to review</Strong>; several work plans do the same. Each one keeps its own
        buttons — a group never sends or approves two at once.
      </P>

      <H2 id="after-you-act">After you act</H2>
      <P>
        Answering a Decision, <Strong>Send now</Strong> and <Strong>Approve &amp; start</Strong>{" "}
        collapse the row to a single status line that follows the work, for example{" "}
        <em>You chose “Pursue” · Jamie Mallers is on it</em>, then{" "}
        <em>Done · Registered on BidNet and saved the solicitation to the deal</em>. Other lines
        read <em>Couldn&apos;t finish</em>, <em>Answer saved</em>, <em>Sent</em>,{" "}
        <em>Not sent</em> or <em>Send not confirmed</em>. <Strong>Details</Strong> on that row
        holds your answer and guidance, the employee&apos;s report, and{" "}
        <Strong>Show the full log</Strong> for every step it took. Select the{" "}
        <Strong>×</Strong> (<em>Close</em>) on the row when you have seen enough; it does not cancel
        work. Rows you are following stay across refreshes in this browser, separately for each
        Member and company.
      </P>
      <P>
        <Strong>Dismiss</Strong>, <Strong>Snooze</Strong>, <Strong>Discard</Strong> and{" "}
        <Strong>Don&apos;t do this</Strong> have nothing left to follow, so the row leaves the
        stack in that same click and keyboard focus moves to the next row. Dismissed Decisions and
        discarded or declined reviews are in <Strong>History</Strong>; a snoozed Decision comes
        back on its own.
      </P>
      <P>
        Home shows <Strong>Active decisions</Strong> near the top with the same rows: up to three
        items, ordered by urgency and then oldest first, with the total waiting. Answer a Decision
        directly on Home; owners and admins can also review proposed work and email replies there.
        A row you are following, or an email you are editing, keeps its place while new items
        arrive. Select <Strong>All decisions</Strong> to open the full stack.
      </P>

      <H2 id="active-and-history">Active and History</H2>
      <P>
        The <Strong>Decision stack</Strong> has three pages in its side menu.{" "}
        <Strong>Active</Strong> holds only what still needs someone, plus the rows you are
        following after acting on them. <Strong>History</Strong> keeps everything already settled:
        answered, dismissed and expired Decisions, and for owners and admins the email and work
        reviews that were sent, discarded, approved or declined. History uses the same one-line
        rows; an answered Decision also says who chose what.{" "}
        <DocLink to="/docs/decisions#settings">Settings</DocLink> decides which questions reach
        you. On a phone, open the side menu from the top bar, or use the{" "}
        <Strong>Decision history</Strong> link on the Active page.
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
          A Decision a Member dismissed has <Strong>Undismiss</Strong>, which returns it to the
          active stack; a question the AI Employee withdrew does not.
        </LI>
        <LI>
          A link to a Decision or review, from a notification, a discussion, or Ask AI, opens
          wherever that item is now: on Active while it waits, on History once it is settled.
        </LI>
      </UL>

      <H2 id="settings">Settings: which questions reach you</H2>
      <P>
        Open <Strong>Settings</Strong> in the Decision stack&apos;s side menu. Every Member can read
        it; only owners and admins can change it.
      </P>
      <P>
        <Strong>Let AI Employees add decisions</Strong> is on by default. Turn it off and AI
        Employees stop adding questions. When they reach a choice they would have asked about, they
        follow their instructions and Policies, take only steps that are easy to undo, note open
        questions in their work reports, and never take a consequential step they lack authority
        for. Questions already waiting stay in the stack to answer, snooze, or dismiss, and the
        stack shows <Strong>The Decision stack is off</Strong>. Email and work reviews still arrive:
        they are Approvals that hold an action for you, not Decisions. Turn it back on to take new
        questions again.
      </P>
      <P>
        <Strong>Which questions belong</Strong> holds your <Strong>Instructions</Strong>: plain
        language, one instruction per line, up to 30. It starts with a default that asks only about
        spending, contracts, legal, security or reputation risks, conflicting policies, the
        company&apos;s direction, and anything hard to undo. A <Strong>Default</Strong> pill shows
        while you follow it. Edit the text and select <Strong>Save instructions</Strong> (or press
        ⌘/Ctrl+Enter), <Strong>Cancel</Strong> to drop an edit, or{" "}
        <Strong>Restore default</Strong>. Leave the box empty to let every question through.
      </P>
      <P>
        AI Employees read your instructions before they ask. Every new question is also checked
        against them by the asking employee&apos;s own AI Model before it is added. A question your
        instructions keep off is never created and pages nobody: the employee is told which
        instruction applied and handles it within the authority it already has. That
        employee&apos;s work timeline says it kept the question off the Decision stack, and the
        audit log records it, so you can tune the wording. If the check cannot run — no AI Model
        connected, the model is busy or fails, or no answer within a minute — the question reaches
        the stack as before. Existing companies start with the stack on and the default
        instructions.
      </P>

      <H2 id="reviewing-email">Reviewing an email</H2>
      <UL>
        <LI>
          The row shows who the email is for, its subject and its first lines. Select{" "}
          <Strong>Details</Strong> for <Strong>The customer email</Strong> (or{" "}
          <Strong>Why this email</Strong> for a fresh message) with{" "}
          <Strong>Open original email</Strong>, what the employee did first, and{" "}
          <Strong>The reply</Strong> (or <Strong>The email</Strong>): the exact To, Cc, Bcc,
          subject, message and attachments.
        </LI>
        <LI>
          Select <Strong>Edit email</Strong> to change it. <Strong>Save changes</Strong> updates
          this review only.
        </LI>
        <LI>
          Select <Strong>Ask employee to edit</Strong> to open a private conversation with a message
          linked to this review. Opening it sends neither the chat message nor the email; add your
          request and send it when ready.
        </LI>
        <LI>
          Select <Strong>Send now</Strong> to send the exact reviewed version; the row then reads{" "}
          <em>Sent</em> until you close it. <Strong>Discard</Strong> records that it should not be
          sent and takes the row off the stack in the same click.
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
        A work review&apos;s <Strong>Details</Strong> show <Strong>Why it needs you</Strong>,{" "}
        <Strong>What happened</Strong>, <Strong>The plan</Strong> in full, and a link to the
        source. An owner or admin selects <Strong>Approve &amp; start</Strong> to authorize exactly
        that plan; the row then follows the work (<em>Approved</em>, then <em>Done</em>,{" "}
        <em>Couldn&apos;t finish</em> or <em>Outcome not confirmed</em>) with the reported outcome
        in Details. Select <Strong>Request changes</Strong> to open a linked conversation with the
        employee, or <Strong>Don&apos;t do this</Strong> to decline it. Future work that needs human
        authority still needs its own review.
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
        email handover instead starts approved handover work. When it has real results, its exact
        customer reply returns as a separate email review. It is never saved to Gmail or IMAP
        Drafts along the way. An approval records permission to start; the later outcome shows what
        actually happened.
      </P>

      <H2 id="answering">Answering a decision</H2>
      <UL>
        <LI>
          Open <Strong>Decision stack</Strong>. Use <Strong>Search decision stack</Strong> to find a
          customer, AI Employee, or detail from the question, its summary or reported outcome.
        </LI>
        <LI>
          Read the row. Need more? Select <Strong>Details</Strong>, or press{" "}
          <Strong>Discuss</Strong> to ask the AI Employee about its reasoning, alternatives or
          tradeoffs, right on the row.
        </LI>
        <LI>
          Pick an answer. It explains what the employee will do; add names, dates, links or
          instructions with <Strong>Add guidance</Strong>, then select{" "}
          <Strong>Confirm: {"{answer}"}</Strong>. Nothing is recorded until you confirm.
        </LI>
        <LI>
          Need more time? Select <Strong>Snooze</Strong>, then choose an hour, one or two days, a
          week, or a month. The question leaves Home and the Decision stack, then returns when that
          time is up. Snoozing does not answer or dismiss it, or start any work.
        </LI>
        <LI>
          Nothing to decide? Select <Strong>Dismiss</Strong>. It records that outcome without
          choosing an answer and takes the row off the stack at once; <Strong>Undismiss</Strong>{" "}
          on the <Strong>History</Strong> page brings it back.
        </LI>
      </UL>
      <P>
        Any Member can answer, not just owners and admins. If the employee addressed the question to
        one person, only they — or an owner or admin — can answer it, so nothing strands behind
        somebody on holiday. Owners and admins get a notification for every unassigned decision; an
        assigned one notifies only its recipient. The notification carries the employee&apos;s
        one-line summary. A decision still unanswered after 24 hours re-pages the same people once
        — the employee that stacked it is blocked until someone picks, and a blocked employee should
        never be a silent one.
      </P>

      <Callout kind="info" title="A decision is answered once.">
        Two people submitting different choices at the same moment produce one answer, not two. The
        second person is told the decision was already made.
      </Callout>

      <H2 id="discussing">Discussing a decision</H2>
      <P>
        Press <Strong>Discuss</Strong> on a decision, on Home or in the{" "}
        <Strong>Decision stack</Strong>. A <Strong>Discussion with {"{employee}"}</Strong> step
        opens on that row, with a message box. Type your question and press{" "}
        <Strong>Send</Strong>, or Enter. The AI Employee that asked replies in the same thread, and
        you can keep asking follow-ups there without leaving the decision. Opening the discussion
        sends nothing, and <Strong>Hide discussion</Strong> folds it away.
      </P>
      <P>
        The discussion is private to you and stays with the decision: press{" "}
        <Strong>Discuss</Strong> again later, after a reload or on another device, and the
        conversation is still there. It also appears in your chat with that AI Employee, titled{" "}
        <Strong>Discuss: {"{decision}"}</Strong>. Each time you send, the employee reads the
        decision&apos;s current question, summary, context, options, and status, including the
        recorded answer and report if someone has since chosen an option.
      </P>
      <P>
        Discussion is for understanding the decision. The employee can only read it: the discussion
        does not answer or dismiss the decision, or start the proposed work. A discussion you have
        open stays in place when you answer. You can also use <Strong>Discuss</Strong> on the{" "}
        <Strong>History</Strong> page to understand an earlier outcome. If the asking employee has
        been deleted, its Discuss button is unavailable.
      </P>

      <H2 id="what-happens-next">What happens next</H2>
      <P>
        Answering an ordinary Decision records your choice and guidance. It does not send mail,
        change a record, or authorize proposed work. Genosyn may then start a pickup session briefed
        with your answer and the original context; that session still runs under the employee&apos;s
        existing authority and meets every normal Approval. The employee ends with a short report
        of what it did; that report is what the row&apos;s status line and{" "}
        <Strong>What happened next</Strong> in its Details show, while{" "}
        <Strong>Show the full log</Strong> keeps every step. A recommendation is the
        employee&apos;s suggestion; nothing is selected for you.
      </P>
      <P>
        Decisions raised during preparation-only work stay with humans, even if an AI decision
        policy normally routes the employee&apos;s questions. Answering records your choice and
        journal entry but starts no new session, and the row reads <em>Answer saved</em>. The
        employee must obtain any required work Approval before continuing, while preserving the
        work&apos;s delivery restrictions. See{" "}
        <DocLink to="/docs/reactivity">Proactive work</DocLink>.
      </P>
      <P>
        Your answer is also written to that employee&apos;s journal, and the last week of its
        journal is part of every prompt it runs. That is the backstop: if no session can start — no{" "}
        <DocLink to="/docs/models">AI Model</DocLink> is connected yet, or the server restarted
        mid-session — the row says so, and the employee still picks the work up on its next run. It
        can also read the answer at any time with its <Code>list_decisions</Code> tool, and{" "}
        <Code>get_decision</Code> reads long answers and context in full. AI Employees can read
        their own questions and those currently waiting for their answer; earlier routing does not
        grant ongoing access.
      </P>
      <P>
        A Decision stays pending until someone answers it, a Member dismisses it, or the AI Employee
        withdraws its own question because the situation has moved on. It never expires merely
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
        specific person is never routed. A routed row says <em>routed to {"{name}"} (AI)</em>.
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
        answer always wins. An AI answer reads <em>{"{name}"} (AI) chose …</em>, is written to the
        audit log and the asker&apos;s journal, and starts the asker&apos;s pickup session
        immediately, the same as a human answer. See{" "}
        <DocLink to="/docs/autonomy">Earned autonomy</DocLink> for the other half of the
        trust-by-evidence story.
      </P>

      <Callout kind="tip" title="Nothing waiting is the normal state.">
        <Strong>Active decisions</Strong> disappears from Home once nothing is waiting and you have
        closed the rows you were following. The full queue remains on the{" "}
        <Strong>Decision stack</Strong> page, and everything settled on its{" "}
        <Strong>History</Strong> page.
      </Callout>
    </>
  );
}
