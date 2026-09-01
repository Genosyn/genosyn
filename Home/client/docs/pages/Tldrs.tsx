import { Callout, DocLink, H2, LI, P, PageHeader, Strong, UL } from "@/docs/Prose";

export function Tldrs() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="TLDRs"
        lead={
          <>
            Company-wide, periodic recaps written by an AI Employee. A TLDR turns public Workspace
            messages, company-visible journal entries, and terminal Routine Run output into one
            brief you can read on Home.
          </>
        }
      />

      <H2 id="set-up">Set up TLDRs</H2>
      <P>
        Open <Strong>TLDRs</Strong> from the company section menu. Owners and admins can configure
        the schedule; every Member can read the generated history. For a new company with no saved
        TLDR settings, hiring the first AI Employee starts an enabled Daily schedule automatically.
      </P>
      <UL>
        <LI>
          That first <Strong>AI Employee</Strong> is selected as the writer. Connect an active{""}
          <DocLink to="/docs/models">AI Model</DocLink> before the first TLDR is due.
        </LI>
        <LI>
          Pick <Strong>Every 4 hours</Strong>, <Strong>Every 8 hours</Strong>,{""}
          <Strong>Every 12 hours</Strong>, <Strong>Daily</Strong>, or <Strong>Weekly</Strong>. Daily
          is selected by default.
        </LI>
        <LI>Choose another writer or cadence, or pause automatic TLDRs, then save your changes.</LI>
      </UL>
      <P>
        Owners and admins can change the employee or cadence, pause the schedule, or choose{""}
        <Strong>Generate now</Strong> when a recap is useful before the next interval.
      </P>

      <H2 id="standing-questions">Questions every briefing answers</H2>
      <P>
        A recap tells you what happened. The questions you have afterwards are usually the same ones
        every week — so write them down once instead of asking them every time. Under{""}
        <Strong>Questions to answer</Strong> on the TLDR settings page, add up to eight{""}
        <Strong>standing questions</Strong>.
      </P>
      <UL>
        <LI>
          Add your own, or start from a suggestion such as{""}
          <Strong>What should we stop doing?</Strong>
        </LI>
        <LI>
          Reorder them with the arrows — cards appear under the briefing in this order — and save
          your changes with the rest of the schedule.
        </LI>
        <LI>
          Switch one off to keep its wording without answering it for a while. Delete it to remove
          it for good.
        </LI>
      </UL>
      <P>
        As soon as a briefing is posted, the writing AI Employee works through the list and adds
        each answer as its own card beneath the brief. They are waiting for you when you read it,
        rather than something you have to remember to ask for.
      </P>
      <Callout kind="tip" title="Standing questions apply to future briefings">
        Adding one never rewrites briefings you have already read. The next briefing is the first to
        carry it.
      </Callout>

      <H2 id="actions">One-click actions on an answer</H2>
      <P>
        Where an answer names something concrete — &quot;stop the nightly scrape, it has found
        nothing for three weeks&quot; — the AI Employee attaches a button for it. Agreeing costs a
        click instead of typing the proposal back in your own words.
      </P>
      <UL>
        <LI>
          Each button carries a short label and the full sentence of what pressing it will ask for.
          You see that sentence before anything runs, and confirming is what sends it.
        </LI>
        <LI>
          The AI Employee then carries it out <Strong>with your access, not its own</Strong>, and
          reports back on the same card. A finished button turns into a tick.
        </LI>
        <LI>
          <Strong>Discuss</Strong> opens the card&apos;s conversation instead, for anything a button
          does not cover.
        </LI>
        <LI>
          Not worth doing? Clear a suggestion with the <Strong>×</Strong> beside it. The card still
          records that it was suggested.
        </LI>
      </UL>
      <Callout kind="warn" title="A button is never a shortcut around your permissions">
        Pressing one runs the same turn as typing the request yourself, under your own access.
        Buttons that would create or change a <DocLink to="/docs/routines">Routine</DocLink> are
        shown locked to anyone who is not an owner or admin, and the server refuses them too —
        greying out a button is a courtesy, not the boundary.
      </Callout>

      <H2 id="included">What a TLDR includes</H2>
      <P>
        Each TLDR covers one bounded period. It can summarize messages from public{""}
        <DocLink to="/docs/workspace-chat">Workspace</DocLink> channels, company-visible journal
        entries, and terminal Routine Run output.
      </P>
      <P>
        If that period contains no eligible activity, Genosyn creates nothing. Home and the TLDR
        history stay free of empty recaps.
      </P>
      <Callout kind="warn" title="Private conversations stay private">
        Private channels, DMs, and direct AI Employee chat are excluded before anything reaches the
        model. They never appear in a company-wide TLDR.
      </Callout>

      <H2 id="questions">Ask your own question about a TLDR</H2>
      <P>
        Standing questions cover what you always want to know. For anything else, ask on the spot:
        choose <Strong>Ask a question</Strong> on a briefing, or{""}
        <Strong>Ask … something else</Strong> under the answers it already carries.
      </P>
      <UL>
        <LI>
          Click a suggested question such as <Strong>What can be improved?</Strong>, or type your
          own.
        </LI>
        <LI>
          Each question becomes its own card, answered by the AI Employee who wrote the briefing,
          with its own buttons. The brief itself is never edited.
        </LI>
        <LI>
          Cards are company-wide, like the briefing. Anyone in the company sees them; the Member who
          asked, and any owner or admin, can remove one. Removing a card produced by a standing
          question leaves the standing question itself in place.
        </LI>
      </UL>
      <P>
        The first answer on a card is discussion-only, however the card was created. Genosyn runs it
        on the same restricted path the briefing itself uses, with no tools at all, and treats the
        recap as untrusted reference data — so text inside a briefing cannot trigger an action.
      </P>

      <H2 id="discuss">Discuss a TLDR without leaving the page</H2>
      <P>
        Reply on any card to keep talking. Follow-ups run as ordinary AI Employee Chat with your own
        access, on the same page as the briefing — so when the employee proposes something, you can
        simply ask for it. <Strong>Add a routine for that</Strong> creates the{""}
        <DocLink to="/docs/routines">Routine</DocLink>, rather than another paragraph describing
        one.
      </P>
      <P>
        A card and its conversation are company-wide and stay attached to the briefing. If the
        writer has since been removed, existing cards remain readable but no new question can be
        asked about that TLDR.
      </P>
      <Callout kind="warn" title="Scheduling automation is an owner or admin action">
        A Member can ask any question and discuss any answer, but creating or changing a Routine
        needs an owner or admin. Asked by anyone else, the AI Employee writes the proposal out and
        says who has to run it — it will not claim to have made a change it cannot make.
      </Callout>

      <H2 id="safe-summary">The writer can summarize, not act</H2>
      <P>
        Genosyn treats the source material as untrusted and runs the chosen employee&apos;s model in
        a restricted summarization turn. It receives no coding, browser, Integration, Genosyn, or
        company MCP tools. Writing a TLDR cannot send a message, change a record, or use the
        employee&apos;s Grants. The first answer on a question card runs on that same restricted
        path.
      </P>
      <P>
        Working out which buttons an answer deserves is a second restricted turn with the same
        shape: it can submit a list of suggestions and do nothing else. Suggesting an action is
        mechanically incapable of taking one.
      </P>
      <P>
        Acting is a separate step you take deliberately. Only a follow-up you send on a card, or a
        button you press after reading what it will do, carries tools — and it carries exactly your
        own access, never more, and never on the strength of something written inside a briefing.
      </P>

      <H2 id="read-and-dismiss">Read and dismiss</H2>
      <P>
        The newest TLDR you have not dismissed appears on Home. Open <Strong>TLDRs</Strong> to read
        the complete generated history at any time.
      </P>
      <P>
        <Strong>Dismiss</Strong> is personal. It removes the recap from your Home, but does not
        delete it or mark it as read for anyone else. Generated history is preserved.
      </P>
      <Callout kind="tip" title="Generate now follows the same rules">
        An on-demand recap uses the same source boundary and restricted model path as a scheduled
        one. It does not run a Routine or grant the AI Employee any extra access.
      </Callout>
    </>
  );
}
