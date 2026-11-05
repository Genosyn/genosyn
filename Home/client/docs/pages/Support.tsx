import {
  Callout,
  Code,
  DocLink,
  H2,
  KeyList,
  LI,
  OL,
  P,
  PageHeader,
  Strong,
  UL,
} from "@/docs/Prose";

export function Support() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Support"
        lead={
          <>
            Customer email becomes Tickets, and so do messages from a{" "}
            <DocLink to="/docs/support-chat-widget">chat widget</DocLink> on your own site. Connect
            the mailbox your customers write to, say which addresses count, and an AI Employee
            summarizes and files every Ticket and drafts its reply from your published Articles,
            quoting them. A Member sends the reply or, where you allow it and every check holds, the
            AI Employee does.
          </>
        }
      />

      <H2 id="connect">Connect a Support inbox</H2>
      <P>
        Open <Strong>Support</Strong> in the sidebar (<Code>G</Code> then <Code>/</Code>). Until
        there is an inbox, the page asks for one under{" "}
        <Strong>Connect your first Support inbox</Strong>. Owners and admins set this up, and add
        more later under <Strong>Support → Settings → Support inboxes</Strong>.
      </P>
      <OL>
        <LI>
          <Strong>Who works Support?</Strong> The AI Employee that reads every Ticket.
        </LI>
        <LI>
          <Strong>Mailbox.</Strong> Pick one, or choose <Strong>Connect a mailbox</Strong> to add
          one the same way as in <DocLink to="/docs/email#connect">Email</DocLink>.
        </LI>
        <LI>
          <Strong>Which mail becomes a ticket?</Strong> Certain addresses, or the whole mailbox.
        </LI>
        <LI>
          <Strong>How far it goes.</Strong>{" "}
          <DocLink to="/docs/support#how-far">Draft replies</DocLink> is the default.
        </LI>
        <LI>
          <Strong>Bring in existing mail.</Strong> New mail only, or the last 7, 30 or 90 days.
        </LI>
        <LI>
          Choose <Strong>Create Support inbox</Strong>.
        </LI>
      </OL>
      <P>
        <Strong>Only mail sent to certain addresses</Strong> watches a mailbox for{" "}
        <Code>support@</Code> and leaves the rest of it alone. List several, separated by commas. It
        works for aliases, Google Groups and forwarding addresses.{" "}
        <Strong>Everything sent to</Strong> the mailbox is for one used only for support. Whatever
        no inbox takes stays in <DocLink to="/docs/email">Email</DocLink>. An inbox watching an
        address takes that mail ahead of one taking the whole mailbox, and two inboxes on one
        mailbox cannot take the same mail.
      </P>
      <P>
        <Strong>Advanced</Strong> holds <Strong>Reply from</Strong> (left empty, the address the
        customer wrote to), <Strong>Sender name</Strong>, a <Strong>Signature</Strong> added under
        every reply, <Strong>What the AI Employee should know about this inbox</Strong>,{" "}
        <Strong>Most automatic replies a day</Strong> (100 to start),{" "}
        <Strong>Acknowledge new tickets</Strong> (one automatic note when a Ticket opens) and{" "}
        <Strong>Archive in the mailbox when solved</Strong>.
      </P>
      <Callout kind="warn" title="Replying from an alias">
        Replies go out through the connected mailbox, so the mail server has the last word on the
        address. On Gmail, an alias must be set up under <Strong>Send mail as</Strong>. An SMTP
        server may refuse an address it does not know; the reply then does not go out, and a person
        is told why.
      </Callout>
      <P>
        <Strong>Bring in existing mail</Strong> makes at most 500 Tickets, newest first, as soon as
        the inbox exists. The AI Employee works the newest 50 still owed an answer, and nothing
        imported goes out on its own, whatever the inbox&apos;s setting.
      </P>

      <H2 id="mail">What happens to mail</H2>
      <UL>
        <LI>
          A customer&apos;s email opens a Ticket and their next one joins it, reopening it if it was
          solved or closed. Replies someone sends from Gmail itself join the Ticket too.
        </LI>
        <LI>
          The answer goes to the sender, or to the address in <Code>Reply-To</Code> or{" "}
          <Code>X-Original-From</Code> when a web form or a Google Group relayed the message.
          Support matches them to a Contact if you have one and never creates one.
        </LI>
        <LI>
          Bulk mail lands in <Strong>Spam</Strong> with its reason on it, and{" "}
          <Strong>Not spam</Strong> brings it back. Your own Google Group is not treated as bulk. An
          AI Employee can file only a stranger&apos;s first email as spam.
        </LI>
        <LI>
          A bounce flags its Ticket <Strong>Needs a person</Strong>. An auto-reply never reopens a
          Ticket or earns an answer.
        </LI>
        <LI>
          A plain thank-you after your team has answered solves the Ticket with no further reply,
          unless the customer sounds unhappy or the AI Employee says it needs a person. If they
          write again, it reopens.
        </LI>
        <LI>
          Mail a Support inbox takes is read by Support and not again by the mailbox&apos;s{" "}
          <DocLink to="/docs/email#analysis">AI analysis</DocLink>, so a Project&apos;s{" "}
          <DocLink to="/docs/tasks#email-intake">email intake</DocLink> does not file it as a Todo
          as well. Its <DocLink to="/docs/email#rules">rules</DocLink> and Pipelines still run.
        </LI>
      </UL>

      <P>
        A <DocLink to="/docs/support-chat-widget">chat widget</DocLink> is a second way in: off until
        you turn it on, only on the sites you name, and its Tickets follow the inbox&apos;s AI
        Employee and how far it goes.
      </P>

      <H2 id="how-far">How far the AI Employee goes</H2>
      <P>
        <Strong>How far it goes</Strong> is set per inbox, and each step adds to the last:
      </P>
      <KeyList
        rows={[
          { term: "Off", def: "No AI Employee reads this inbox." },
          {
            term: "Triage only",
            def: "Summarizes each Ticket and sets its topic, priority and sentiment. Writes no replies.",
          },
          {
            term: "Draft replies",
            def: "The default. Triage, plus a reply drafted from your Articles for a Member to review and send.",
          },
          {
            term: "Reply on its own",
            def: "Triage and drafts, and sends a reply itself when every check holds. Anything else waits for a Member.",
          },
        ]}
      />
      <P>
        The AI Employee working an inbox needs no Grant for this. Each job is a single restricted
        turn the server starts, with one tool to submit its result. It reads this Ticket&apos;s
        conversation and your published Articles and nothing else: no internal notes, draft
        Articles, other customers&apos; Tickets, Soul, Memory or Skills. Your instructions (
        <Strong>How to answer</Strong> under <Strong>Support → Settings</Strong>, and the
        inbox&apos;s note) shape tone and judgement. A customer&apos;s words travel only as data,
        and a message that tries to instruct the AI Employee is flagged{" "}
        <Strong>The email tried to instruct the AI</Strong>. What it can tell a customer comes only
        from published Articles: each fact cites a passage copied word for word, and Genosyn removes
        any quote it does not find in the Article.
      </P>

      <H2 id="checks">The checks an automatic reply must pass</H2>
      <P>
        The AI Employee reports what it found and the server decides, so nothing a customer writes
        can argue its way past a check. The default answer is no. A reply goes out on its own only
        when none of these applies:
      </P>
      <UL>
        <LI>
          <Strong>The answer.</Strong> The Articles do not fully answer it, the reply quotes no
          Article, a quote was not found, the AI Employee&apos;s confidence was not high, or the
          message tried to instruct it.
        </LI>
        <LI>
          <Strong>The subject.</Strong> The AI Employee says this needs a person: they ask for one;
          money, refunds or a contract; a legal threat or a complaint; a security incident or a lost
          account; deleting or exporting personal data; anything it would have to take an action to
          solve.
        </LI>
        <LI>
          <Strong>The Ticket.</Strong> It fits no topic, its topic&apos;s{" "}
          <Strong>May reply on its own</Strong> is off, it is Urgent, the customer sounds angry, or
          a Member owns it.
        </LI>
        <LI>
          <Strong>The limits.</Strong> The AI Employee has already replied twice on this Ticket,
          this customer has had five automatic replies today, or the inbox reached its daily limit.
        </LI>
        <LI>
          <Strong>The address.</Strong> The message looks automated, the address does not take
          replies or is on the <DocLink to="/docs/email#suppressed">do-not-email list</DocLink>, the
          reply address is on a different domain from the sender, or more than three other people
          are copied.
        </LI>
        <LI>
          <Strong>The timing.</Strong> The message waited more than 24 hours, or the Ticket was
          imported.
        </LI>
      </UL>
      <P>
        Each reason is written on the draft, under <Strong>Held for a person because:</Strong>. On
        Draft replies the same card says <Strong>Would wait for a person because:</Strong> or{" "}
        <Strong>Every check passed</Strong>, so you can read how it would behave before you let it
        send. Asking for a draft yourself never sends one, on any setting.{" "}
        <DocLink to="/docs/support-chat-widget#ai">In a chat</DocLink>, the checks about an address
        do not apply, since the reply does not go to one.
      </P>
      <P>
        Customers are told. Every reply it sends on its own ends with{" "}
        <Strong>Line under replies it sends on its own</Strong>, by default &ldquo;This reply was
        written by an AI Employee. Reply here if you would like a person to take a look.&rdquo;
        Replies a person sends do not carry it. Automatic mail carries <Code>Auto-Submitted</Code>{" "}
        headers, so other systems do not answer it. A send that fails goes to a person and is never
        retried; if the server stopped partway through one, the draft says it may already have gone
        out.
      </P>

      <H2 id="queue">Work the queue</H2>
      <P>
        The rail leads with what is waiting, counted by the server: <Strong>Inbox</Strong>,{" "}
        <Strong>Assigned to me</Strong>, <Strong>Unassigned</Strong>,{" "}
        <Strong>AI drafts to review</Strong> and <Strong>SLA at risk</Strong>, then{" "}
        <Strong>By status</Strong> from <Strong>Answered by AI</Strong> to <Strong>Spam</Strong>.
        Filter by priority or topic, search by subject, customer or #number (here or in{" "}
        <Code>⌘K</Code>), and select Tickets to solve, mark as spam or set their priority together.{" "}
        <Strong>New ticket</Strong> writes to a customer; turn off{" "}
        <Strong>Email the customer now</Strong> to record what they said on a call instead.
      </P>
      <P>On a Ticket:</P>
      <UL>
        <LI>
          <Strong>The draft</Strong> offers Send, Edit first, Try again and Discard, beside the
          quotes it relied on.
        </LI>
        <LI>
          <Strong>The composer</Strong> writes a Reply, or a Note that stays inside the company,
          with Attach, Saved replies and Rewrite (Fix grammar and clarity, Make it shorter, Make it
          friendlier, Make it more formal, Translate to the customer&apos;s language). Send, or Send
          and solve. If someone wrote meanwhile, the button says Send anyway.
        </LI>
        <LI>
          <Strong>Snooze</Strong> runs for 4 hours, until tomorrow, for 3 days or for a week.{" "}
          <Strong>More actions</Strong> holds Ask for a draft, Hand to an AI Employee, Write an
          Article from this, Merge into another ticket and Mark as spam.
        </LI>
      </UL>
      <P>
        Assign a Ticket to a Member or an AI Employee from the side panel. A person&apos;s priority
        or topic stands over the AI Employee&apos;s. Every Member can work Tickets, Articles and
        saved replies; <Strong>Settings</Strong>, inboxes and <Strong>AI access</Strong> are for
        owners and admins.
      </P>
      <P>
        In the queue, <Code>J</Code> / <Code>K</Code> or the arrows move, <Code>Enter</Code> opens
        and <Code>X</Code> selects. On a Ticket, <Code>R</Code> starts a reply, <Code>N</Code> a
        note, and <Code>E</Code> solves it. <Code>⌘/Ctrl+Enter</Code> sends from the composer.
      </P>

      <H2 id="tasks">Tickets and Tasks</H2>
      <P>
        A ticket&apos;s page shows the Todos linked to it, and <Strong>Create task</Strong> files a
        new one from it. An AI Employee working a Todo links any ticket it works on to that Todo. See{" "}
        <DocLink to="/docs/tasks#links">Where a todo came from</DocLink>.
      </P>

      <H2 id="articles">Articles and knowledge gaps</H2>
      <P>
        <Strong>Knowledge</Strong> holds the Articles your AI Employee answers from. Choose{" "}
        <Strong>New Article</Strong>, give it a <Strong>Title</Strong>, a <Strong>Topic</Strong> if
        one fits and the <Strong>Answer</Strong>, then <Strong>Save draft</Strong> or{" "}
        <Strong>Publish</Strong>. Only published Articles are read, so what is published is what
        customers can be told. <Strong>Unpublish</Strong> takes one back. A customer sees an Article
        through the replies that quote it or, once you turn it on, on your public{" "}
        <DocLink to="/docs/help-center">help center</DocLink>.
      </P>
      <P>
        <Strong>Asked, and no Article answers it</Strong> lists the last 30 days&apos; questions
        with nothing behind them, most-asked first. <Strong>Write it</Strong> starts an Article with
        that question as its title, and it is answered from then on.{" "}
        <Strong>Write an Article from this</Strong> on a Ticket has the AI Employee write a draft
        for a Member to review. It goes nowhere until someone publishes it.
      </P>

      <H2 id="saved-replies">Saved replies</H2>
      <P>
        <Strong>Saved replies</Strong> are answers your team writes once and inserts from the
        composer. Blanks fill in as they go: <Code>{"{{customer.first_name}}"}</Code>,{" "}
        <Code>{"{{customer.name}}"}</Code>, <Code>{"{{customer.email}}"}</Code>,{" "}
        <Code>{"{{ticket.number}}"}</Code>, <Code>{"{{ticket.subject}}"}</Code>,{" "}
        <Code>{"{{agent.name}}"}</Code> (you) and <Code>{"{{company.name}}"}</Code>. A blank Genosyn
        does not know is left as written, so you catch the typo in the composer before the customer
        does.
      </P>

      <H2 id="topics">Topics and routing</H2>
      <P>
        Under <Strong>Support → Settings → Topics</Strong>, a Topic says what a Ticket is about and
        what follows from that. Each has a name, <Strong>When this topic fits</Strong> (which the AI
        Employee reads to choose it), <Strong>May reply on its own</Strong>, and who it goes to: a
        Member or an AI Employee who gets the Ticket when nobody holds it yet. You start with six.{" "}
        <Strong>How-to question</Strong> and <Strong>Feedback or feature request</Strong> may reply
        on their own. <Strong>Bug or problem</Strong>, <Strong>Billing</Strong>,{" "}
        <Strong>Account access</Strong> and <Strong>Something else</Strong> wait for a person until
        you decide otherwise.
      </P>

      <H2 id="targets">Response targets and working hours</H2>
      <P>
        <Strong>Track response targets</Strong> is on by default. In hours, to the first reply and
        to solved: Urgent 1 and 8, High 4 and 24, Normal 8 and 72, Low 24 and 168. Turn on{" "}
        <Strong>Count only working hours</Strong> and choose the days, <Strong>Opens</Strong>,{" "}
        <Strong>Closes</Strong> and <Strong>Time zone</Strong> for the clock to run only then. A
        Ticket within an hour of a target, or past it, shows under <Strong>SLA at risk</Strong>.
      </P>

      <H2 id="after">Ratings, solving and closing</H2>
      <P>
        Under <Strong>Support → Settings → After the answer</Strong>,{" "}
        <Strong>Ask customers for a rating</Strong> (off by default) sends one short email two hours
        after a Ticket is solved, with a link good for 30 days. Nothing is recorded until they press
        Send, and a score of 2 or below notifies the Member holding the Ticket. Rating links use the
        installation URL from <Strong>Admin → General</Strong>; see{" "}
        <DocLink to="/docs/self-hosting">Configuration</DocLink>.{" "}
        <Strong>Solve after a silent customer (days)</Strong> starts at 5, and{" "}
        <Strong>Close after solved (days)</Strong> at 7. 0 means never. A customer who writes again
        reopens the Ticket either way.
      </P>

      <H2 id="insights">Insights</H2>
      <P>
        <Strong>Insights</Strong> shows Tickets, First reply, Time to solve, Met their target,
        Solved by AI, Drafts sent untouched, Customer rating and Frustrated or angry for the last 7,
        30 or 90 days, then volume per day and a table by Topic. Genosyn counts all of them, never
        the model. <Strong>What customers are running into</Strong> is the AI Employee&apos;s
        reading of recent Tickets: themes, gaps and what to do next. It is read again each week once
        at least five new Tickets have come in, or when you choose <Strong>Read again</Strong>.
      </P>

      <H2 id="hand-to-ai">Hand to an AI Employee</H2>
      <P>
        The restricted turn answers from Articles and does nothing else. For a Ticket that needs
        real work, choose <Strong>Hand to an AI Employee</Strong>, pick who, and say{" "}
        <Strong>What should it do?</Strong> It works the conversation with its Soul, Skills and
        tools, through the mailbox&apos;s <DocLink to="/docs/email#hand-to-ai">handover</DocLink>,
        then brings the reply it wants to send to your{" "}
        <DocLink to="/docs/decisions">Decision stack</DocLink> for a person. It needs Draft access
        to the mailbox or higher, under <Strong>Email → Settings → AI access</Strong>.
      </P>

      <H2 id="ai-employees">AI Employees and Support</H2>
      <P>
        For an AI Employee to work with Tickets through its own tools, in chat or in a Routine, give
        it access under <Strong>Support → AI access</Strong>:
      </P>
      <UL>
        <LI>
          <Strong>Read only</Strong> reads Tickets, Articles and the figures, and changes nothing (
          <Code>list_support_tickets</Code>, <Code>get_support_ticket</Code>,{" "}
          <Code>search_support_articles</Code>, <Code>get_support_article</Code>,{" "}
          <Code>get_support_overview</Code>).
        </LI>
        <LI>
          <Strong>Prepare replies</Strong> also adds notes, updates Tickets, drafts replies for a
          Member to send and drafts Articles (<Code>add_support_note</Code>,{" "}
          <Code>update_support_ticket</Code>, <Code>draft_support_reply</Code>,{" "}
          <Code>create_support_article</Code>, <Code>update_support_article</Code>). Nobody outside
          the company hears from it.
        </LI>
        <LI>
          <Strong>Reply to customers</Strong> also sends replies (
          <Code>reply_to_support_ticket</Code>) and publishes Articles or changes a published
          Article&apos;s words, since replies repeat what they say.
        </LI>
      </UL>
      <P>
        A Ticket holds what a stranger wrote. Listing or reading Tickets marks the turn under the{" "}
        <DocLink to="/docs/policies#taint-policy">taint policy</DocLink>, so a reply sent in that
        turn is held as an Approval for a person, and so is publishing an Article or changing a
        published one&apos;s words. The do-not-email list and the company&apos;s
        Policies apply to every reply. Replies that go out on their own come only from the
        inbox&apos;s restricted turn.
      </P>
      <P>
        A Routine can start when a customer writes: give it a Trigger on <Code>support_ticket</Code>
        . It fires when a customer&apos;s message arrives, not on the replies, notes and updates the
        Routine&apos;s own work makes. See <DocLink to="/docs/reactivity">Reactivity</DocLink>.
        Support is in the <DocLink to="/docs/api">API</DocLink> too, under its own area.
      </P>

      <H2 id="unavailable">When the AI Employee cannot work</H2>
      <UL>
        <LI>
          <Strong>Its AI Model is unavailable.</Strong> Work waits without spending its attempts and
          resumes when the <DocLink to="/docs/models">model</DocLink> answers again. A message more
          than 24 hours old by then gets a draft for a person rather than an automatic reply.
        </LI>
        <LI>
          A <DocLink to="/docs/standdowns">Standdown</DocLink> is placed. AI work waits, and is
          checked again at the moment of sending. People can still reply.
        </LI>
        <LI>
          <Strong>No AI Employee, or no model.</Strong> The Ticket says so, with Try again for when
          there is one.
        </LI>
      </UL>

      <H2 id="disconnect">Disconnecting a mailbox</H2>
      <P>
        Tickets stay, and so does every message&apos;s text, because Support keeps its own copy.
        Attachments do not move: their bytes stay on the mail server, so after a disconnect a file
        says it is no longer in the mailbox. You cannot reply on those Tickets until you connect the
        mailbox again under <Strong>Support → Settings</Strong>, except in a chat, whose replies need
        no mailbox. Removing a Support inbox keeps its Tickets too, and ends its chat widget.
      </P>
    </>
  );
}
