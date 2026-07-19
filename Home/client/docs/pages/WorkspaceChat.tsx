import {
  Callout,
  Code,
  DocLink,
  H2,
  LI,
  P,
  PageHeader,
  Strong,
  UL,
} from "@/docs/Prose";

export function WorkspaceChat() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Workspace chat"
        lead={
          <>
            Company channels and direct messages for Members and AI employees,
            with realtime replies, files, reactions, mentions, and resource
            references.
          </>
        }
      />

      <H2 id="channels-and-dms">Channels and direct messages</H2>
      <P>
        Open <Strong>Workspace</Strong> from the section menu. Use the{" "}
        <Strong>+</Strong> beside Channels for a public or private room, or the{" "}
        <Strong>+</Strong> beside Direct messages to choose a Member or AI
        employee. In a DM with an AI employee, every message gets a reply; in a
        channel, type <Code>@</Code> and choose the employee you want to answer.
      </P>
      <UL>
        <LI>Press Enter to send and Shift+Enter for a new line.</LI>
        <LI>Use the paperclip for files up to 25 MB.</LI>
        <LI>
          Hover your own message for reactions, editing, or soft deletion.
        </LI>
        <LI>
          Archive a DM from its sidebar row or the conversation header. Deleting
          an AI employee automatically archives their DMs, so no empty
          counterparty is left in the live sidebar.
        </LI>
      </UL>

      <H2 id="new-context">Start a new AI context</H2>
      <P>
        Type <Code>/new</Code> by itself in an AI-employee DM to start fresh.
        Genosyn keeps the earlier messages visible, inserts a context marker,
        and stops replaying anything before it to the employee. The dedicated{" "}
        <DocLink to="/docs/employees">employee Chat</DocLink> uses the same
        command to open a new conversation, while per-email Ask AI clears that
        email&apos;s AI context.
      </P>

      <H2 id="resource-references">Tag company resources</H2>
      <P>
        Type <Code>#</Code> followed by two or more characters in any
        AI-employee chat composer. The picker searches the company content you
        can see: Skills, Routines, channels, Projects, Todos, Bases, notebooks,
        Notes, Resources, Charts, Dashboards, code repositories, Pipelines, and
        Customers. Choose a result to insert a clickable resource tag.
      </P>
      <P>
        The AI employee treats the link as the exact work target and opens it
        with its Genosyn tools. A tag does not silently widen access: existing{" "}
        <DocLink to="/docs/integrations">Grants</DocLink> and restricted-project
        membership still apply, and the employee tells you when it cannot reach
        the tagged row.
      </P>
      <Callout kind="tip" title="The same pattern works everywhere">
        Resource tags are available in employee Chat, channels and DMs,
        per-email Ask AI, Base Assistant, and Todo discussions.
      </Callout>
    </>
  );
}
