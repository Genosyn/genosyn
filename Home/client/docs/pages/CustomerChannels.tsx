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

export function CustomerChannels() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Customer channels"
        lead={
          <>
            Put an AI Employee in the Slack channels you share with your customers. It reads the
            conversation, writes notes onto each customer&apos;s record, and answers their questions
            from instructions you write.
          </>
        }
      />

      <H2 id="what-it-is">What this is</H2>
      <P>
        A <Strong>customer channel</Strong> is a Slack channel — usually a Slack Connect channel
        shared with a customer&apos;s own workspace — linked to one{" "}
        <DocLink to="/docs/customers">Customer</DocLink>. The{" "}
        <DocLink to="/docs/employees">AI Employee</DocLink> you choose to work it does three things
        there that it does nowhere else in Slack:
      </P>
      <UL>
        <LI>
          <Strong>It reads every message</Strong>, not just the ones that @-mention it.
        </LI>
        <LI>
          <Strong>It takes notes.</Strong> Once the channel goes quiet it writes a short summary —
          what the customer asked for, reported or decided, and what either side promised — onto the
          Customer&apos;s timeline, and files what your side committed to as Follow-ups.
        </LI>
        <LI>
          <Strong>It answers the customer</Strong>, when you let it, from the instructions you wrote
          for that channel.
        </LI>
      </UL>
      <P>
        Everywhere else the Slack app behaves exactly as{" "}
        <DocLink to="/docs/chat-surfaces">External chat surfaces</DocLink> describes: a DM is
        answered, a channel only when it is @-mentioned, and other channels are never read — and in a
        Slack Connect channel you have not linked, it still answers without anyone&apos;s access.
      </P>

      <H2 id="setup">Set it up</H2>
      <OL>
        <LI>
          Connect Slack and grant the Connection to an AI Employee, as in{" "}
          <DocLink to="/docs/chat-surfaces#slack">the Slack setup</DocLink>. Make sure the Slack app
          has the <Code>groups:read</Code> scope and subscribes to the <Code>message.channels</Code>{" "}
          and <Code>message.groups</Code> events — without them it only ever hears @-mentions, and
          has nothing to take notes on.
        </LI>
        <LI>
          In Slack, invite the app to the channel with <Code>/invite @your-app</Code>. In a Slack
          Connect channel, someone in your own workspace does the inviting; the customer cannot add
          your app.
        </LI>
        <LI>
          In Genosyn open <Strong>Settings → Integrations</Strong> and click{" "}
          <Strong>Channels</Strong> on the Slack Connection, then <Strong>Link a channel</Strong>.
        </LI>
        <LI>
          Pick the <Strong>Slack channel</Strong> (only channels the app is in are listed), the{" "}
          <Strong>Customer</Strong> it is with, and the <Strong>AI Employee</Strong> who works it.
        </LI>
        <LI>
          Choose how it <Strong>replies</Strong>, write its{" "}
          <Strong>Instructions for this channel</Strong>, and click <Strong>Link channel</Strong>.
        </LI>
      </OL>
      <P>
        Each linked channel shows when notes were last written, how many messages are waiting for
        the next ones, and — when the employee cannot work — why. <Strong>Write notes now</Strong>{" "}
        writes them straight away instead of waiting for the channel to go quiet.
      </P>

      <H2 id="replies">Replies</H2>
      <KeyList
        rows={[
          {
            term: "Only take notes",
            def: "It reads the channel and never posts in it, even when someone @-mentions it.",
          },
          {
            term: "Answer when @-mentioned",
            def: "The default. Anyone in the channel — the customer or your own people — can ask it something by name, and it answers in that thread.",
          },
          {
            term: "Answer customer questions",
            def: (
              <>
                It also answers questions from people outside your Slack workspace without being
                named, when its instructions cover them. It stays quiet when a message is people
                talking to each other, thanks, an update, or something only a colleague can answer,
                and it lets a question go once anyone has replied to it. Your own people are only
                answered when they @-mention it.
              </>
            ),
          },
        ]}
      />
      <P>
        Every reply goes in a thread, and a channel gets at most 100 replies a day. Telling the
        customer from your own people relies on Slack Connect: a customer invited as a guest into
        your own workspace looks like a colleague to Slack, so in that setup the employee answers
        them when they @-mention it.
      </P>

      <H2 id="instructions">What it may say: the instructions</H2>
      <P>
        Everyone in a shared channel can read what the employee posts, customers included, and
        nothing in Slack proves who anyone is. So in a customer channel the employee answers from{" "}
        <Strong>the instructions you wrote for that channel</Strong> and nothing else — never its{" "}
        <DocLink to="/docs/soul">Soul</DocLink>, Memory, <DocLink to="/docs/skills">Skills</DocLink>
        , company data or tools. That holds even when one of your own colleagues asks: their access
        is for a direct message, not for a room the customer reads. Write what it should know — the
        product, where the docs are, what it may promise — and what to hand to a person.
      </P>
      <Callout kind="info" title="Leave the instructions empty and it stays cautious.">
        It introduces itself, answers only general questions about what it can help with, says a
        colleague will follow up on anything else, and makes no commitments. It never agrees to a
        price, a refund, a deadline or a contract unless your instructions say it may.
      </Callout>

      <H2 id="notes">Notes on the customer&apos;s record</H2>
      <P>
        Notes are written when the channel has been quiet for 30 minutes, or four hours after the
        oldest message still waiting if it never goes quiet. Each set lands on the Customer&apos;s
        timeline as a <Strong>note</Strong> by the AI Employee, titled with the channel&apos;s name.
        Small talk and thanks are read and written up as nothing, so the record is not padded.
      </P>
      <UL>
        <LI>
          <Strong>Follow-ups</Strong> are filed for what someone on your side committed to, assigned
          to the AI Employee and linked to the Customer — when the employee has{" "}
          <DocLink to="/docs/revenue">Revenue</DocLink> write access. Without it, the note is still
          written.
        </LI>
        <LI>
          <Strong>A note is an ordinary note.</Strong> Correct or delete it on the timeline like any
          other.
        </LI>
        <LI>
          <Strong>The words in the channel never drive anything.</Strong> The employee reads them in
          a turn whose only tool hands the notes back, and Genosyn files them on the Customer you
          linked. Nothing a customer types can send an email, change a record, or move the notes
          somewhere else.
        </LI>
      </UL>

      <H3 id="when-it-stops">When it stops working a channel</H3>
      <P>
        Messages are always kept, but the employee writes no notes and posts nothing while it has no
        connected <DocLink to="/docs/models">AI Model</DocLink>, is no longer granted the Slack
        Connection, or is covered by a <DocLink to="/docs/standdowns">Standdown</DocLink>. Deleting
        the employee leaves its channels linked with nobody working them until you pick someone
        else. Unlinking a channel keeps the notes already written and discards the messages not yet
        written up; disconnecting the Slack Connection unlinks all of its channels. A Customer with
        a linked channel cannot be deleted, and merging two Customers moves the channel to the one
        you keep.
      </P>

      <Callout title="Related">
        <DocLink to="/docs/chat-surfaces">External chat surfaces</DocLink> covers the Slack app
        itself. <DocLink to="/docs/meetings">Meetings</DocLink> takes the same kind of notes from
        calls. <DocLink to="/docs/phone-numbers">Phone numbers</DocLink> answer strangers from
        instructions in the same way.
      </Callout>
    </>
  );
}
