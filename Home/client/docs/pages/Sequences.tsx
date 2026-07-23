import {
  Callout,
  Code,
  DocLink,
  H2,
  H3,
  KeyList,
  LI,
  OL,
  P,
  PageHeader,
  Strong,
  UL,
} from "@/docs/Prose";

export function Sequences() {
  return (
    <>
      <PageHeader
        eyebrow="Revenue"
        title="Sequences"
        lead={
          <>
            Multi-step outbound where every touch is <em>written</em>, not interpolated. A sequence
            names an <DocLink to="/docs/employees">AI employee</DocLink> and a brief; the employee
            drafts each step for each contact from that person&apos;s real context — the threads on
            their timeline, the open deal, the signal that enrolled them. Find it under{" "}
            <Code>Revenue → Sequences</Code>.
          </>
        }
      />

      <H2 id="why">Why it is not a mail merge</H2>
      <P>
        A template engine can put a first name in a subject line. It cannot write step 3 as{" "}
        <em>&quot;reference whatever they said in reply to step 2&quot;</em>. That is the difference
        here: a <Strong>Sequence</Strong> stores instructions, never message bodies. At send time the
        named employee reads the contact&apos;s timeline and writes the actual email. The cost of
        that is real — every touch is a model call, and a bad brief produces bad mail at volume — so
        the default is that a human still presses Send.
      </P>

      <H2 id="build">Building one</H2>
      <OL>
        <LI>
          <Code>Revenue → Sequences → New sequence</Code>. Give it a name and a description.
        </LI>
        <LI>
          Pick the <Strong>mailbox</Strong> every touch sends from — one of the accounts connected
          under <DocLink to="/docs/email">Email</DocLink> — and the <Strong>AI employee</Strong> that
          writes them.
        </LI>
        <LI>
          Write the <Strong>Brief</Strong>. Who this is for, what you sell, what a good reply looks
          like, and what never to say. This is the single highest-leverage field in the whole
          feature; it is markdown, and it is handed to the employee on every step.
        </LI>
        <LI>
          Add <Strong>steps</Strong>. Each one has a name, a delay, and an instruction: what this
          specific touch should accomplish.
        </LI>
        <LI>
          Set the guardrails — <DocLink to="/docs/sequences#windows">send window</DocLink>,{" "}
          <DocLink to="/docs/sequences#caps">daily cap</DocLink>, stop-on-reply — then move the
          status from <Code>Draft</Code> to <Code>Active</Code>.
        </LI>
      </OL>
      <P>
        A step&apos;s delay is measured <Strong>from the previous touch&apos;s send</Strong>, not
        from enrolment, so pausing a sequence for a week does not bunch every pending touch into the
        moment you resume it. <Strong>Reply in the same thread</Strong> is on by default: a
        follow-up with no quoted history reads as spam. Turn it off for a step that is a genuinely
        new angle rather than a bump.
      </P>
      <Callout kind="info" title="Editing the ladder is safe.">
        Saving the builder replaces the whole step list. Enrolments already past a step that no
        longer exists simply complete — the honest outcome for &quot;the steps they had left were
        deleted&quot; — and the history of what was already sent survives, because each run
        snapshots its own step position and subject line.
      </Callout>

      <H2 id="enrol">Enrolling contacts</H2>
      <P>
        Select contacts in <Code>Revenue → Contacts</Code> and press <Strong>Enrol</Strong>, pick
        the sequence from a deal, or let a{" "}
        <DocLink to="/docs/signals">Signal</DocLink> enrol somebody the moment they hit a condition
        in your product.
      </P>
      <P>
        Bulk enrolment <Strong>refuses per contact rather than failing the batch</Strong> — one
        blocked person in eighty must not lose the other seventy-nine — and reports exactly who was
        skipped and why:
      </P>
      <UL>
        <LI>
          <Strong>No email</Strong> — you only hold a phone number for them.
        </LI>
        <LI>
          <Strong>Do not contact</Strong> — the person is flagged as a hard opt-out.
        </LI>
        <LI>
          <Strong>Suppressed</Strong> — the address is on the do-not-email list. See{" "}
          <DocLink to="/docs/deliverability">Deliverability</DocLink>.
        </LI>
        <LI>
          <Strong>Already enrolled</Strong> — somebody is in a sequence exactly once. Re-enrolling a
          person who finished resets their existing row rather than adding a second, because
          receiving the same opening line twice is the most visible way an outbound tool embarrasses
          its owner.
        </LI>
        <LI>
          <Strong>Archived</Strong> — the contact or the sequence is archived.
        </LI>
      </UL>

      <H2 id="review">The review queue</H2>
      <P>
        With autoSend off — the default — a drafted touch lands in{" "}
        <DocLink to="/docs/email#drafts">Email → Drafts</DocLink>, the same review queue built for
        exactly this job. Every row shows the AI employee and the routine or sequence that produced
        it next to the recipient, subject and preview, so a night&apos;s drafting is one scannable
        list. Filter or group by employee, open a draft to see the message, its attachments and the
        thread it replies to, then send the ones you like — individually, by ticking a selection, or
        with <Strong>Send all</Strong>.
      </P>
      <P>
        Because a send cannot be undone, a batch stops at a confirmation showing who is about to
        receive mail — real addresses, a breakdown per source, and the mailbox it goes out from.
        Past 25 drafts the confirm button stays disabled until you acknowledge the size explicitly.
      </P>

      <H2 id="autosend">autoSend, and its two grants</H2>
      <P>
        <Strong>autoSend</Strong> is the one switch in Genosyn that spends your sending reputation
        with no human in the loop. It is off by default, and turning it on requires{" "}
        <em>two independent grants</em> on the same employee:
      </P>
      <KeyList
        rows={[
          {
            term: "Revenue: send",
            def: (
              <>
                Granted from <Code>Revenue → AI access</Code>. The employee is trusted to run
                outbound unattended.
              </>
            ),
          },
          {
            term: "Mailbox: send",
            def: (
              <>
                Granted from <Code>Email → Settings → AI access</Code> for that specific mailbox. The
                employee is trusted to speak from that address.
              </>
            ),
          },
        ]}
      />
      <P>
        Both are re-checked <Strong>at send time</Strong>, not just when you saved the sequence.
        Downgrade either grant and the next touch drafts instead of sending — nothing goes out on
        the strength of permission somebody has since revoked. Toggling autoSend is written to the
        audit log with the employee it applies to, because it is the field worth reading back a year
        later.
      </P>
      <Callout kind="warn" title="autoSend bypasses nothing else.">
        The suppression list, the send window, and the daily cap all still apply, on exactly the
        same code path. autoSend removes the human, not the guardrails.
      </Callout>

      <H2 id="windows">Send windows</H2>
      <P>
        A sequence sends only inside its <Strong>send window</Strong>: a set of weekdays, a start
        hour, an end hour, and a timezone. The default is conservative — weekdays, 08:00 to 17:00,
        UTC — because a sequence that mails at 3am reads as automated however good the copy is. Set
        the timezone to the one your buyers work in.
      </P>
      <UL>
        <LI>
          A window whose start and end are the <Strong>same hour</Strong> means <em>never</em>, not
          all day. &quot;09:00 to 09:00&quot; is far more likely to be a mistake than a request to
          mail around the clock.
        </LI>
        <LI>
          An <Strong>empty day list</Strong> also means never — the supported way to freeze a
          sequence without pausing it.
        </LI>
        <LI>
          A window that wraps past midnight is fine: set an end hour lower than the start hour.
        </LI>
        <LI>
          Daylight saving is handled by the platform&apos;s timezone database, so a window pinned to{" "}
          <Code>America/New_York</Code> stays correct across the change.
        </LI>
      </UL>
      <P>
        A touch that comes due outside the window is not dropped. It waits for the next opening.
      </P>

      <H2 id="caps">Daily caps</H2>
      <P>
        <Strong>Daily cap</Strong> is the maximum number of touches the whole sequence may produce in
        a day, defaulting to 50. Both sent and drafted touches count against it — the drafting is
        what costs model time and what you will have to review — and <Code>0</Code> removes the
        sequence-level cap entirely, which you should reserve for a sequence you have already watched
        run.
      </P>
      <P>
        Underneath, the scheduler dispatches a bounded number of touches per sweep across the whole
        installation, and it makes the cheap refusals first: enrolments belonging to a paused
        sequence or one that has burned its allowance are filtered out <em>before</em> the budget is
        spent, so a large blocked backlog can never starve a live campaign.
      </P>

      <H2 id="stop">Stop on reply, and the other ways an enrolment ends</H2>
      <P>
        <Strong>Stop on reply</Strong> is on by default, and turning it off is almost always wrong.
        Because mail sync already ingests inbound mail, a reply on the thread the sequence started
        stops the enrolment within a heartbeat — the prospect answers and the machine gets out of the
        way. An enrolment ends in exactly one of these states, and the distinction is operational:
      </P>
      <KeyList
        rows={[
          { term: "completed", def: <>Every step was delivered. Nothing went wrong.</> },
          {
            term: "stopped_replied",
            def: <>They answered. The success case — hand it to a human, or to a deal owner.</>,
          },
          {
            term: "stopped_unsubscribed",
            def: <>They opted out. A compliance record; the address is suppressed too.</>,
          },
          {
            term: "stopped_bounced",
            def: <>The address is dead. Fix your data before mailing that domain again.</>,
          },
          { term: "stopped_manual", def: <>Somebody pressed Stop.</> },
          {
            term: "failed",
            def: (
              <>
                Something broke. Deliberately not retried — an employee producing a malformed draft
                would otherwise mail the same prospect every hour. Fix it, then resume the enrolment.
              </>
            ),
          },
        ]}
      />

      <H3 id="history">What was actually sent</H3>
      <P>
        Every attempt at every step is recorded on the enrolment: <Code>sent</Code>,{" "}
        <Code>drafted</Code>, <Code>skipped</Code> with the reason, or <Code>failed</Code> with the
        error, plus the subject line and a link to the message. A skip is not a failure — the most
        common one is a suppressed address, which is the system working correctly — but a silent
        non-send would be indistinguishable from a bug, so it is always written down. This is the
        page to open the first time somebody claims they were mailed after unsubscribing.
      </P>

      <H2 id="related">Related</H2>
      <UL>
        <LI>
          <DocLink to="/docs/deliverability">Deliverability</DocLink> — the suppression list,
          unsubscribe links, bounces, and how not to burn your domain. Read it before you turn
          autoSend on.
        </LI>
        <LI>
          <DocLink to="/docs/signals">Signals</DocLink> — enrol people automatically when your
          product says the moment is right.
        </LI>
        <LI>
          <DocLink to="/docs/revenue">Revenue</DocLink> — contacts, deals, and the timeline the
          drafter reads from.
        </LI>
      </UL>
    </>
  );
}
