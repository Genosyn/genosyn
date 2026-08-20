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
        the schedule; every Member can read the generated history.
      </P>
      <UL>
        <LI>
          Choose the <Strong>AI Employee</Strong> that will write the recap. The employee needs a
          connected, active <DocLink to="/docs/models">AI Model</DocLink>.
        </LI>
        <LI>
          Pick <Strong>Every 4 hours</Strong>, <Strong>Every 8 hours</Strong>,{" "}
          <Strong>Every 12 hours</Strong>, <Strong>Daily</Strong>, or <Strong>Weekly</Strong>.
        </LI>
        <LI>Enable TLDRs and save the schedule.</LI>
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

      <H2 id="safe-summary">The writer can summarize, not act</H2>
      <P>
        Genosyn treats the source material as untrusted and runs the chosen employee&apos;s model in
        a restricted summarization turn. It receives no coding, browser, Integration, Genosyn, or
        company MCP tools. Writing a TLDR cannot send a message, change a record, or use the
        employee&apos;s Grants.
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
