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
          That first <Strong>AI Employee</Strong> is selected as the writer. Connect an active{" "}
          <DocLink to="/docs/models">AI Model</DocLink> before the first TLDR is due.
        </LI>
        <LI>
          Pick <Strong>Every 4 hours</Strong>, <Strong>Every 8 hours</Strong>,{" "}
          <Strong>Every 12 hours</Strong>, <Strong>Daily</Strong>, or <Strong>Weekly</Strong>. Daily
          is selected by default.
        </LI>
        <LI>Choose another writer or cadence, or pause automatic TLDRs, then save your changes.</LI>
      </UL>
      <P>
        Owners and admins can change the employee or cadence, pause the schedule, or choose{" "}
        <Strong>Generate now</Strong> when a recap is useful before the next interval.
      </P>

      <H2 id="included">What a TLDR includes</H2>
      <P>
        Each TLDR covers one bounded period. It can summarize messages from public{" "}
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

      <H2 id="questions">Ask questions about a TLDR</H2>
      <P>
        A recap says what happened. The questions you actually have afterwards — what to change,
        what to stop — are answered on <Strong>question cards</Strong> beside the brief rather than
        inside it. Choose <Strong>Discuss</Strong> on a TLDR to open them.
      </P>
      <UL>
        <LI>
          Click a suggested question such as <Strong>What can be improved?</Strong> or{" "}
          <Strong>What should we stop doing?</Strong>, or type your own.
        </LI>
        <LI>
          Each question becomes its own card, answered by the AI Employee who wrote the briefing.
          The brief itself is never edited.
        </LI>
        <LI>
          Cards are company-wide, like the briefing. Anyone in the company sees them; the Member who
          asked, and any owner or admin, can remove one.
        </LI>
      </UL>
      <P>
        The first answer on a card is discussion-only. Genosyn runs it on the same restricted path
        the briefing itself uses, with no tools at all, and treats the recap as untrusted reference
        data — so text inside a briefing cannot trigger an action.
      </P>

      <H2 id="discuss">Discuss a TLDR without leaving the page</H2>
      <P>
        Reply on any card to keep talking. Follow-ups run as ordinary AI Employee Chat with your own
        access, on the same page as the briefing — so when the employee proposes something, you can
        simply ask for it. <Strong>Add a routine for that</Strong> creates the{" "}
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
        Acting is a separate step you take deliberately. Only a follow-up you send on a card carries
        tools, and it carries exactly your own access — never more, and never on the strength of
        something written inside a briefing.
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
