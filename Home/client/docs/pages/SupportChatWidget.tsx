import { Callout, Code, DocLink, H2, KeyList, LI, P, PageHeader, Strong, UL } from "@/docs/Prose";

export function SupportChatWidget() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Chat widget"
        lead={
          <>
            Put a chat window on your own site. A visitor&apos;s messages open and continue a
            Ticket, your AI Employee answers from your published Articles under the same checks as
            email, and your team replies from the same queue. It is off until you turn it on, and
            only the sites you name can embed it.
          </>
        }
      />

      <H2 id="turn-on">Turn it on</H2>
      <P>
        Owners and admins set this under <Strong>Support → Settings → Chat widget</Strong>. Each{" "}
        <DocLink to="/docs/support#connect">Support inbox</DocLink> has one, off to start, and its
        Tickets follow that inbox&apos;s AI Employee, <Strong>How far it goes</Strong> and daily
        limit.
      </P>
      <UL>
        <LI>
          Tick <Strong>Turn on the chat widget</Strong>.
        </LI>
        <LI>
          Under <Strong>Sites it may appear on</Strong>, list each site, one per line, with its{" "}
          <Code>https://</Code>: <Code>https://www.example.com</Code>. There are no wildcards, so{" "}
          <Code>www.example.com</Code> and <Code>example.com</Code> are two lines.
        </LI>
        <LI>
          Give it a <Strong>Title</Strong> and <Strong>Greeting</Strong> if you like, choose{" "}
          <Strong>Save</Strong>, and add the snippet it shows to your site, before the closing body
          tag.
        </LI>
      </UL>
      <Callout kind="warn" title="If your site sets its own Content-Security-Policy">
        Allow this installation under <Code>script-src</Code> and <Code>frame-src</Code>, or your
        site will refuse the widget. The snippet uses the installation URL from{" "}
        <Strong>Admin → General</Strong>; see <DocLink to="/docs/self-hosting">Configuration</DocLink>.
      </Callout>
      <P>
        A visitor who never opens the chat downloads one small script. Turning the widget off, or
        removing a site, takes effect at the next page view. Pausing the inbox keeps conversations
        readable and takes no new messages.
      </P>

      <H2 id="visitors">What a visitor sees</H2>
      <P>
        They press the button and write, with no sign-in. Their conversation is the only thing the
        widget can show them: what they wrote and what you replied, under the inbox&apos;s{" "}
        <Strong>Sender name</Strong>. They never see a Ticket number or status, who holds it, a
        Member&apos;s name, a note or a draft.
      </P>
      <P>
        Their browser keeps a private key to the conversation, which your site&apos;s own scripts
        cannot read. Coming back to your site in the same browser shows the conversation again, and
        the button says when a reply is waiting. <Strong>End chat</Strong> closes it for good,
        which is the way out on a shared computer. So does a month without a visit.
      </P>

      <H2 id="email">An answer after they leave</H2>
      <P>
        A visitor can choose <Strong>Get replies by email</Strong>. Anyone can type anyone&apos;s
        address, so what they typed is only a claim. It sends one short email in fixed words, with
        nothing the visitor wrote in it, and nothing else happens until a person presses{" "}
        <Strong>Confirm</Strong> on the page it links to. Until then the address is not the
        Ticket&apos;s customer, is not matched to a Customer or Contact, and receives no reply. The
        Ticket shows it, marked as not confirmed.
      </P>
      <P>
        Once confirmed, a reply they have not read in the chat after two minutes goes to that
        address, through the inbox&apos;s mailbox, so the{" "}
        <DocLink to="/docs/email#suppressed">do-not-email list</DocLink> and your{" "}
        <DocLink to="/docs/policies">Policies</DocLink> apply. They can answer that email, and it
        joins the same Ticket.
      </P>

      <H2 id="tickets">On your side</H2>
      <P>
        A chat lands in the queue like any other Ticket, marked <Strong>Chat</Strong>, and{" "}
        <Strong>Any source</Strong> filters by where Tickets came from. Reply, Note, Saved replies
        and Rewrite work as they do for email. A few things differ:
      </P>
      <UL>
        <LI>
          A reply goes into the chat, so it needs no mailbox and carries no files or cc. The
          composer says where it will go.
        </LI>
        <LI>
          If the visitor ended the chat or the widget is off, and they confirmed no address, nothing
          can reach them, so Genosyn refuses the reply and says why.
        </LI>
        <LI>
          A message on a <Strong>closed</Strong> Ticket opens a new one. On a solved Ticket it
          reopens it, as email does.
        </LI>
        <LI>
          A chat can only be <Strong>merged</Strong> with another from the same visitor, since the
          visitor reads the whole conversation.
        </LI>
      </UL>

      <H2 id="ai">The AI Employee in a chat</H2>
      <P>
        It works exactly as it does on <DocLink to="/docs/support#how-far">email</DocLink>: one
        restricted turn per read, showing it this conversation and your published Articles and
        nothing else, with a visitor&apos;s words as data. On{" "}
        <Strong>Reply on its own</Strong>, the server still decides.{" "}
        <DocLink to="/docs/support#checks">Every check</DocLink> about the answer, the subject, the
        Ticket, the limits and the timing applies, and its replies carry the same{" "}
        <Strong>Line under replies it sends on its own</Strong>. The checks about an address do not
        apply, because a chat reply does not go to one: whether it takes replies or is on the
        do-not-email list, whether the reply address matches the sender, and who else is copied. The
        email of what a visitor missed checks the first two for itself. A chat adds one check: a
        reply waits for a person if nobody could read it. Five automatic replies a day is counted per
        visitor.
      </P>

      <H2 id="limits">Limits</H2>
      <P>
        Anyone can write to the widget, and the list of sites stops other sites embedding it but says
        nothing to a script. So these are what keep it from running up your AI Model&apos;s bill:
      </P>
      <KeyList
        rows={[
          {
            term: "AI turns a day",
            def: "200 across your chat widgets to start, under Advanced, with today's count beside it. Past it, or past 12 for one visitor, the Ticket waits for a person and says why, on any setting. 0 means none. A Member pressing Ask for a draft is not counted.",
          },
          {
            term: "Messages an hour",
            def: "600 across your chat widgets to start, under Advanced. Past it, visitors are asked to try again a little later.",
          },
          {
            term: "One visitor",
            def: "30 messages in 10 minutes, and 3 requests for an email a day.",
          },
          {
            term: "One network address",
            def: "10 new visitors an hour, 120 messages in 10 minutes, and 10 requests for an email an hour.",
          },
          {
            term: "One email address",
            def: "2 confirmation emails a day, whoever asks, and 200 a day from your company.",
          },
        ]}
      />
      <P>
        A burst of messages is one read, because the AI Employee waits a few seconds for someone to
        finish. A Routine with a <DocLink to="/docs/reactivity">Trigger</DocLink> on{" "}
        <Code>support_ticket</Code> wakes when a chat&apos;s Ticket becomes owed an answer, not on
        every line.
      </P>
    </>
  );
}
