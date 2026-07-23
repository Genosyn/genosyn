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

export function Revenue() {
  return (
    <>
      <PageHeader
        eyebrow="Module"
        title="Revenue"
        lead={
          <>
            The people you are selling to, the money you are trying to win, and the timeline of
            everything that has passed between you. Find it in the sidebar under{" "}
            <Code>Revenue</Code>. It sits between{" "}
            <DocLink to="/docs/marketing">Paid Marketing</DocLink> (what you spend on attention) and{" "}
            <DocLink to="/docs/finance">Finance</DocLink> (what you collect once somebody signs), so
            ad click → contact → deal → invoice → cash is one chain in one database.
          </>
        }
      />

      <H2 id="what-ships">What ships</H2>
      <UL>
        <LI>
          <Strong>Contacts</Strong> — the humans, whether or not you bill them yet.
        </LI>
        <LI>
          <Strong>Deals</Strong> — one revenue opportunity each, owned by a Member or by an AI
          employee.
        </LI>
        <LI>
          <Strong>Deal stages and the board</Strong> — your sales process as an ordered list of
          columns, seeded with a sensible ladder on first visit.
        </LI>
        <LI>
          <Strong>The activity timeline</Strong> — every email, stage change, signal and note
          against a contact, deal, or account. Mostly written for you.
        </LI>
        <LI>
          <DocLink to="/docs/sequences">Sequences</DocLink> — multi-step outbound where each touch
          is drafted individually by an AI employee.
        </LI>
        <LI>
          <DocLink to="/docs/signals">Signals</DocLink> — product-usage triggers over your own
          database.
        </LI>
        <LI>
          <Strong>Insights</Strong> — MRR movement, retention, CAC, pipeline coverage, win rate and
          stage conversion.
        </LI>
      </UL>

      <H2 id="contacts-vs-customers">Contacts vs. Customers</H2>
      <P>
        These are two different objects and the difference is the whole reason this section exists.
      </P>
      <KeyList
        rows={[
          {
            term: "Contact",
            def: (
              <>
                A <Strong>person</Strong>. Name, email, phone, job title, LinkedIn. Lives here,
                under <Code>Revenue → Contacts</Code>. A contact does not need an account attached —
                early on, most of the list has none.
              </>
            ),
          },
          {
            term: "Customer",
            def: (
              <>
                An <Strong>account</Strong> — the billable company, over in{" "}
                <DocLink to="/docs/customers">Customers</DocLink>, carrying the billing email, tax
                ID, contracts and statements.
              </>
            ),
          },
        ]}
      />
      <P>
        A contact is linked to a customer when — and only when — an account actually exists for
        them. Until then the employer is just a free-text <Strong>Company</Strong> field on the
        contact, which is kept even after you link the account, because the parent company and the
        billing entity disagree often enough that overwriting one loses information. There is no
        separate pre-revenue &quot;account&quot; object to keep in step: a Customer is simply not
        billable until it has an invoice, so contracts, ACV and statements work for a prospect for
        free.
      </P>
      <P>
        Each contact carries a <Strong>lifecycle stage</Strong> — subscriber, lead, qualified,
        opportunity, customer, churned, or unqualified — and an <Strong>owner</Strong> who is either
        a Member or an AI employee, never both. <Strong>Source</Strong> records where they came
        from, and it is filled in automatically for contacts a signal created (
        <Code>signal:trial-expiring</Code>) so attribution survives.
      </P>
      <P>
        <Strong>Do not contact</Strong> is a hard opt-out on the person: it blocks every address you
        hold for them, on every send path. It is separate from — and checked alongside — the
        address-level suppression list described in{" "}
        <DocLink to="/docs/deliverability">Deliverability</DocLink>. Archiving a contact hides them
        from the list without removing them from historical activities and deals.
      </P>

      <H2 id="deals">Deals</H2>
      <P>
        A <Strong>Deal</Strong> is one opportunity: a title, an amount, a currency, an expected
        close date, and the stage it sits in. Both the customer and the primary contact are
        optional, because a deal routinely starts as a company name and a number before either
        exists. Other stakeholders — the buying committee — are added on the deal itself as
        additional contacts.
      </P>
      <P>
        Two fields do more work than they look. <Strong>Next step</Strong> is one line the owner
        keeps current: what has to happen next. <Strong>Probability</Strong> is inherited from the
        stage unless you override it on the deal, which is what makes weighted pipeline value
        meaningful before anybody has touched a single row.
      </P>
      <Callout kind="tip" title="Assigning a deal to an AI employee starts work.">
        Ownership can be an AI employee, and it is not decoration. Handing a deal to one kicks off a
        background work session the same way assigning a Todo does — it researches the account,
        drafts the outreach, and logs what it did on the timeline. Give it a{" "}
        <DocLink to="/docs/soul">Soul</DocLink> worth trusting first.
      </Callout>

      <H2 id="stages">Deal stages</H2>
      <P>
        Your sales process is a flat, ordered list of <Strong>deal stages</Strong>, managed from{" "}
        <Code>Revenue → Settings → Stages</Code>. Each stage has a name, a colour, a default
        probability, and a <Strong>kind</Strong> that decides what reaching it means:
      </P>
      <UL>
        <LI>
          <Strong>Open</Strong> — still in play.
        </LI>
        <LI>
          <Strong>Won</Strong> — terminal, counts as revenue.
        </LI>
        <LI>
          <Strong>Lost</Strong> — terminal, does not.
        </LI>
      </UL>
      <P>
        The kind is the single source of truth for a deal&apos;s status: moving a deal into a stage
        rewrites the status to match and stamps the close date, and moving it back out reopens it.
        You never set status by hand.
      </P>
      <P>
        The first time anybody opens the board, Genosyn seeds a conventional B2B ladder —{" "}
        <Code>New</Code> (10%), <Code>Qualified</Code> (25%), <Code>Demo</Code> (40%),{" "}
        <Code>Proposal</Code> (60%), <Code>Negotiation</Code> (80%), <Code>Closed Won</Code>, and{" "}
        <Code>Closed Lost</Code>. Rename, recolour, reorder and reweight them freely; those
        probabilities are defaults, not claims about your business. Archiving a stage removes it
        from the board and the move-to picker while keeping it resolvable for deals that closed in
        it, so a historical win never loses its stage name.
      </P>
      <Callout kind="info" title="Deal stages are not Pipelines.">
        <DocLink to="/docs/pipelines">Pipeline</DocLink> means the DAG automation primitive, and
        only that. The sales pipeline is this ordered list of deal stages, and the UI calls it{" "}
        <Strong>the board</Strong>.
      </Callout>

      <H2 id="board">The board</H2>
      <P>
        <Code>Revenue → Board</Code> is one column per open stage, one card per deal, sorted so the
        deals nearest a decision are where your eye lands. Drag a card between columns to move it —
        that is the same operation as changing the stage on the detail page, so it writes a{" "}
        <Code>stage_change</Code> activity, updates the status, and feeds the funnel report. Dropping
        a card into a <Strong>won</Strong> or <Strong>lost</Strong> column closes the deal; lost asks
        for a reason, and the reason is worth typing because it is the only field that later explains
        a conversion cliff.
      </P>
      <P>
        Each column header carries its count and its total value, and the board totals both the raw
        and the probability-weighted pipeline. Filter by owner to see one person&apos;s — or one AI
        employee&apos;s — book.
      </P>

      <H2 id="timeline">The activity timeline</H2>
      <P>
        Every contact, deal, and customer has a timeline, and it is the most valuable thing in this
        section precisely because almost nobody types into it. An <Strong>Activity</Strong> is one
        event: what happened, when it happened, and who did it.
      </P>
      <KeyList
        rows={[
          {
            term: "From mail",
            def: (
              <>
                <Code>email_in</Code> / <Code>email_out</Code>, written by mail sync. The bulk of the
                timeline.
              </>
            ),
          },
          {
            term: "From deals",
            def: (
              <>
                <Code>deal_created</Code>, <Code>stage_change</Code>, <Code>deal_won</Code>,{" "}
                <Code>deal_lost</Code>. Stage changes are what the funnel report reads.
              </>
            ),
          },
          {
            term: "From outbound",
            def: (
              <>
                <Code>enrollment</Code>, <Code>sequence_step</Code>, <Code>unsubscribe</Code>,{" "}
                <Code>bounce</Code>.
              </>
            ),
          },
          {
            term: "From signals",
            def: (
              <>
                <Code>signal</Code>, when a product-usage trigger fires on a contact.
              </>
            ),
          },
          {
            term: "From humans",
            def: (
              <>
                <Code>note</Code>, <Code>call</Code>, <Code>meeting</Code>, <Code>task</Code> —
                logged by hand from the <Strong>Log activity</Strong> button.
              </>
            ),
          },
        ]}
      />

      <H3 id="timeline-from-mail">How it fills itself from mail</H3>
      <P>
        Once a mailbox is connected under <DocLink to="/docs/email">Email</DocLink>, every sync
        compares the participants on each new thread against the email addresses on your contacts.
        A match writes an activity onto that contact&apos;s timeline — inbound or outbound, with the
        subject, a snippet, and a link straight into the thread. Open a contact you have been
        emailing for two years and the whole correspondence is there, with nobody having done any
        data entry. That property is what makes the section load-bearing instead of abandoned.
      </P>
      <P>
        Three behaviours are worth knowing, because each one is deliberate:
      </P>
      <OL>
        <LI>
          <Strong>It links to contacts that already exist; it never creates one.</Strong> A real
          inbox is mostly newsletters, receipts, vendors and strangers. Auto-creating a contact per
          address would bury the list within a week and make every number downstream — counts,
          targeting, reports — noise. Creating a contact stays an explicit act: you add one, you
          import, or a <DocLink to="/docs/signals">Signal</DocLink> fires.
        </LI>
        <LI>
          <Strong>It is idempotent per message.</Strong> Re-syncing does not double a conversation.
          The consequence, accepted on purpose: a contact created <em>after</em> a message was
          already synced does not retroactively inherit that message, because the message is no
          longer new.
        </LI>
        <LI>
          <Strong>It never breaks the mailbox.</Strong> The linking is best-effort enrichment
          hanging off sync. If it fails, mail still arrives.
        </LI>
      </OL>
      <P>
        The same pass does two more jobs: an inbound reply on a thread a{" "}
        <DocLink to="/docs/sequences">Sequence</DocLink> started stops that enrolment, and a
        delivery-failure report from a mail daemon suppresses the dead address — see{" "}
        <DocLink to="/docs/deliverability">Deliverability</DocLink>.
      </P>

      <H2 id="insights">Insights</H2>
      <P>
        <Code>Revenue → Insights</Code> reports over a period you choose, defaulting to the trailing
        twelve months. Recurring revenue: <Strong>MRR movement</Strong> split into new, expansion,
        contraction, churn and reactivation (the waterfall is guaranteed to add up),{" "}
        <Strong>ARR</Strong>, and <Strong>NRR / GRR</Strong> retention. Pipeline:{" "}
        <Strong>coverage</Strong> against a target you enter, <Strong>win rate</Strong>,{" "}
        <Strong>sales-cycle length</Strong>, and <Strong>stage-to-stage conversion</Strong> read off
        the stage-change activities. Acquisition: <Strong>CAC by channel</Strong>,{" "}
        <Strong>LTV:CAC</Strong>, and <Strong>payback months</Strong>. A brand-new company sees
        zeros, never errors.
      </P>
      <Callout kind="warn" title="CAC currently reads authorized budget, not settled spend.">
        The acquisition cost figures are computed from the{" "}
        <DocLink to="/docs/marketing">Paid Marketing</DocLink> ledger of{" "}
        <em>authorized budget changes</em>, which is a documented proxy rather than invoiced spend
        from the ad platforms. Treat the trend as real and the absolute number as approximate.
      </Callout>

      <H2 id="ai-access">Giving AI employees revenue access</H2>
      <P>
        By default an AI employee cannot see the revenue section at all — no grant means no revenue
        tool. Owners and admins grant access from <Code>Revenue → AI access</Code> at one of three
        escalating levels:
      </P>
      <UL>
        <LI>
          <Strong>Read</Strong> — see contacts, deals, activities, signals and the reports. Changes
          nothing.
        </LI>
        <LI>
          <Strong>Write</Strong> — also create and update contacts and deals, log activities, move a
          deal between stages, and enrol somebody in a sequence. Drafts still wait for a human.
        </LI>
        <LI>
          <Strong>Send</Strong> — also let a sequence this employee drafts go out without anybody
          pressing Send. This is the only level that spends your sending reputation unattended, and
          it is gated a second time by the mailbox grant. See{" "}
          <DocLink to="/docs/sequences#autosend">autoSend</DocLink>.
        </LI>
      </UL>
      <P>
        Members reach Revenue through the app as usual; these levels govern the AI surface only.
        Every write an employee makes lands in the audit log marked as an AI actor and on the
        employee&apos;s journal.
      </P>
    </>
  );
}
