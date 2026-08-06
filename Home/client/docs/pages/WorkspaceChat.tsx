import { Callout, Code, DocLink, H2, LI, P, PageHeader, Pre, Strong, UL } from "@/docs/Prose";

export function WorkspaceChat() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Workspace chat"
        lead={
          <>
            Company channels and direct messages for Members and AI employees, with realtime
            replies, files, reactions, mentions, and resource references.
          </>
        }
      />

      <H2 id="channels-and-dms">Channels and direct messages</H2>
      <P>
        Open <Strong>Workspace</Strong> from the section menu. Use the <Strong>+</Strong> beside
        Channels for a public or private room, or the <Strong>+</Strong> beside Direct messages to
        choose a Member or AI employee. In a DM with an AI employee, every message gets a reply; in
        a channel, type <Code>@</Code> and choose the employee you want to answer.
      </P>
      <UL>
        <LI>Press Enter to send and Shift+Enter for a new line.</LI>
        <LI>
          Use the paperclip for files up to 25 MB, or paste a screenshot and drag files straight
          onto the composer.
        </LI>
        <LI>Hover your own message for reactions, editing, or soft deletion.</LI>
        <LI>
          A channel opens on its most recent messages. Scroll upward to load earlier messages in
          batches; a loading indicator appears while each older batch is fetched.
        </LI>
        <LI>
          Open <Strong>Settings</Strong> in a public or private channel to change its name or topic,
          see its current Members and AI employees, add people, and manage its incoming webhook.
        </LI>
        <LI>
          Archive a DM from its sidebar row or the conversation header. Deleting an AI employee
          automatically archives their DMs, so no empty counterparty is left in the live sidebar.
        </LI>
      </UL>

      <H2 id="incoming-webhooks">Connect Slack-compatible incoming webhooks</H2>
      <P>
        Open a public or private channel, choose <Strong>Settings</Strong>, then enable{" "}
        <Strong>Incoming webhook</Strong>. Copy the generated URL into any service that can send to
        a Slack incoming webhook. Each channel has its own URL, and you can regenerate or disable it
        from the same dialog.
      </P>
      <P>
        Genosyn accepts Slack&apos;s top-level <Code>text</Code>, <Code>username</Code>,{" "}
        <Code>blocks</Code>, and <Code>attachments</Code> fields. It also accepts the older
        form-encoded <Code>payload</Code> shape. The payload cannot redirect a message to another
        channel: Genosyn always uses the channel embedded in the URL.
      </P>
      <Pre lang="json">{`{
  "username": "Deployments",
  "text": "Production deploy completed successfully."
}`}</Pre>
      <Callout kind="warn" title="Treat the URL like a password">
        Anyone holding the URL can post to that channel without signing in. Regenerate it
        immediately if it leaks. Archiving the channel disables its webhook automatically.
      </Callout>
      <P>
        External services must be able to reach your Genosyn installation. If the generated URL
        starts with <Code>localhost</Code>, set the browser-facing URL under{" "}
        <Strong>Admin → General</Strong>; see{" "}
        <DocLink to="/docs/self-hosting">Self-hosting</DocLink> for reverse proxy and HTTPS
        guidance.
      </P>

      <H2 id="queue-follow-ups">Queue follow-up messages</H2>
      <P>
        In the dedicated <DocLink to="/docs/employees">employee Chat</DocLink>, the composer stays
        available while the AI Employee replies. Keep typing and press Enter: Genosyn adds each
        follow-up to an <Strong>Up next</Strong> queue beneath the live response, then sends the
        messages in order as soon as the employee finishes.
      </P>
      <P>
        Queued messages keep their attachments. Remove one with its <Strong>×</Strong> button before
        it starts, or navigate around the app and return—the queue remains with that employee&apos;s
        chat session.
      </P>

      <H2 id="new-context">Start a new AI context</H2>
      <P>
        Type <Code>/new</Code> by itself in an AI-employee DM to start fresh. Genosyn keeps the
        earlier messages visible, inserts a context marker, and stops replaying anything before it
        to the employee. The dedicated <DocLink to="/docs/employees">employee Chat</DocLink> uses
        the same command to open a new conversation, while per-email Ask AI clears that email&apos;s
        AI context.
      </P>

      <H2 id="resource-references">Tag product areas and company resources</H2>
      <P>
        Type <Code>#</Code> followed by two or more characters in any AI-employee chat composer. The
        picker includes product areas such as <Strong>Estimates</Strong>, <Strong>Invoices</Strong>,
        <Strong>Workspace</Strong>, <Strong>Contacts</Strong>, and <Strong>Deals</Strong>, alongside
        the company content you can see: Skills, Routines, channels, Projects, Todos, Bases,
        notebooks, Notes, Resources, Charts, Dashboards, code repositories, Pipelines, and
        Customers. Choose a result to insert a clickable tag.
      </P>
      <P>
        Use <Code>@</Code> for a person or AI Employee and <Code>#</Code> for a place, product area,
        or record. That keeps &ldquo;who should answer?&rdquo; separate from &ldquo;what should they
        work on?&rdquo; A product-area tag is a hint to the AI Employee&apos;s tool discovery: for
        example, tagging <Code>#Estimates</Code> points it at Finance estimates and{" "}
        <Code>create_estimate</Code>, while a named channel points it at Workspace messaging.
      </P>
      <Pre lang="text">{`Create a #Estimates draft for #Acme, then post the result in #finance-team.`}</Pre>
      <P>
        Add as many tags as the instruction needs. The AI Employee treats a named record or channel
        as the exact work target and a product area as the intended operating surface. A tag does
        not silently widen access: existing <DocLink to="/docs/integrations">Grants</DocLink> and
        restricted-project membership still apply, and the employee tells you when it cannot reach
        the tagged row.
      </P>
      <Callout kind="tip" title="The same pattern works everywhere">
        Product-area and resource tags are available in employee Chat, channels and DMs, per-email
        Ask AI, Base Assistant, and Todo discussions.
      </Callout>
    </>
  );
}
