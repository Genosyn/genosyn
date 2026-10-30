import { Callout, Code, DocLink, H2, H3, KeyList, LI, P, PageHeader, Pre, Strong, UL } from "@/docs/Prose";

export function Collaboration() {
  return (
    <>
      <PageHeader
        eyebrow="Core concepts"
        title="AI Employees working together"
        lead={
          <>
            Ask several AI Employees to work something out together, let one ask a colleague in
            the middle of its own work, or hand work on — each one acting as itself, with its own
            Grants.
          </>
        }
      />

      <KeyList
        rows={[
          {
            term: "Group discussion",
            def: (
              <>
                You ask several AI Employees at once. They take turns in rounds, read each other,
                and come back with one outcome — a summary, a recommendation, open questions, and
                who does what. See{" "}
                <DocLink to="/docs/workspace-chat#group-chats">Group chats</DocLink>.
              </>
            ),
          },
          {
            term: "Asking a colleague",
            def: "An AI Employee asks another a question mid-work and waits for the answer — the figure finance owns, a judgement in support's area, a check of a draft.",
          },
          {
            term: "Handoff",
            def: (
              <>
                An AI Employee hands a piece of work to a colleague, who starts on it at once. See{" "}
                <DocLink to="/docs/employees">AI Employees</DocLink>.
              </>
            ),
          },
          {
            term: "Parallel work",
            def: "An AI Employee splits its own task across temporary copies of itself and gathers their results, all within its own Grants.",
          },
        ]}
      />

      <H2 id="group-discussions">Group discussions</H2>
      <P>
        Start a group chat from Workspace or from an AI Employee&apos;s page, pick who takes part,
        and ask. Every Member message in a group chat is worked out by the AI Employees in it; in
        a public or private channel, <Strong>Discuss</Strong> asks one question the same way. The
        full walkthrough — rounds, the live bar, Stop and Wrap up, the outcome card and{" "}
        <Strong>Start the work</Strong> — is in{" "}
        <DocLink to="/docs/workspace-chat#group-chats">Workspace chat</DocLink>.
      </P>
      <H3 id="discussion-unavailable">When an AI Model is unavailable</H3>
      <P>
        An AI Employee whose <DocLink to="/docs/models#unavailable">AI Model is
        unavailable</DocLink> keeps its turn — unlike a stood-down one, nobody decided it should sit
        out. The others speak, and when nobody else is left the discussion waits: the bar says{" "}
        <em>Waiting for the AI Model to come back</em>, a note in the chat says so once, and it
        carries on by itself when the model answers again. A turn the outage cut short posts
        nothing and is taken again. The outcome is written only whole, by the lead or the next
        participant whose model answers, and waits for one if none does.
      </P>
      <P>
        The discussion&apos;s time limit keeps running while it waits. If it runs out, the
        discussion ends with what was said — or, when the outcome itself cannot be written, without
        one, saying the AI Model was unavailable; the transcript stays in the chat for your next
        question. Stop and a company Standdown end it at once, and a server restart while it waits
        ends it as interrupted. <Strong>Start the work</Strong> waits per owner: a share whose
        owner&apos;s model is unavailable reads <em>Waiting for its AI Model</em> and starts by
        itself once it is back, under the Member who pressed it.
      </P>

      <H2 id="ask-a-colleague">Asking a colleague mid-work</H2>
      <P>
        An AI Employee working on something — a Routine Run, a chat with you, a Handoff — can call{" "}
        <Code>ask_colleague</Code> with a colleague&apos;s handle, a question, and whatever context
        they need. The colleague answers in its own voice, from its own Soul, Skills, Memory and
        Grants, and the answer comes straight back into the asking employee&apos;s turn so it can
        carry on. Both Journals record the exchange, and the audit log records it as{" "}
        <Code>colleague.ask</Code>.
      </P>
      <P>
        Point an employee at it from its Soul or a Skill when a colleague owns the facts it
        depends on:
      </P>
      <Pre lang="markdown">{`Before quoting a price above $10k, ask @ben for the current
discount policy and the customer's payment history.`}</Pre>
      <UL>
        <LI>
          <Strong>The answer reads, it does not act.</Strong> The colleague can look things up
          with its read tools; it cannot send, write, schedule or delegate. Asking is never a way
          to borrow a colleague&apos;s access to do something the asker cannot — what should be
          done comes back as advice.
        </LI>
        <LI>
          <Strong>One hop.</Strong> A colleague answering a question cannot ask a third, so
          questions never chain.
        </LI>
        <LI>
          <Strong>Three per turn.</Strong> An employee can ask at most three questions in one turn,
          counted whether or not they were answered.
        </LI>
        <LI>
          <Strong>Whose authority.</Strong> When you are chatting with the asking employee, the
          colleague answers with your access, intersected with its own Grants. In a Routine Run it
          answers as it would in its own Run.
        </LI>
        <LI>
          <Strong>Standdowns hold.</Strong> A stood-down colleague, or one with no AI Model, is not
          asked; the asker is told why.
        </LI>
        <LI>
          <Strong>Outside content travels.</Strong> If the asking turn had read a web page, the
          answer is treated as having read it too, and an answer that read one marks the asking
          turn the same way — so anything either then tries to send or schedule is held for
          review.
        </LI>
      </UL>

      <H2 id="handing-work-on">Handing work on</H2>
      <P>
        When something is genuinely another employee&apos;s job, an AI Employee creates a{" "}
        <Strong>Handoff</Strong> with <Code>create_handoff</Code>. The receiver starts on it at
        once and closes it with <Code>complete_handoff</Code> or <Code>decline_handoff</Code>. You
        can see and create Handoffs at an AI Employee&apos;s{" "}
        <Strong>Settings → Advanced → Handoffs</Strong>. After a group discussion,{" "}
        <Strong>Start the work</Strong> does the same for everything the outcome assigned, in one
        press.
      </P>

      <Callout kind="info" title="None of this is a way around a gate">
        Every AI Employee acts with its own Grants, under every company{" "}
        <DocLink to="/docs/policies">Policy</DocLink>. Talking — a discussion turn, an answer to a
        colleague — only reads. Work that acts runs as an ordinary turn and meets every{" "}
        <DocLink to="/docs/decisions">Approval, Decision</DocLink> and delivery limit a direct
        request would, and a <DocLink to="/docs/standdowns">Standdown</DocLink> stops all of it.
      </Callout>
    </>
  );
}
