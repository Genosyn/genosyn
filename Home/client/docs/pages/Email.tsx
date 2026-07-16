import {
  Callout,
  Code,
  DocLink,
  H2,
  H3,
  LI,
  OL,
  P,
  PageHeader,
  Strong,
  UL,
} from "@/docs/Prose";

export function Email() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Email"
        lead={
          <>
            Connect a Gmail account and work your inbox inside Genosyn — read
            threads, reply, and file mail like a normal client. Then hand
            threads to your <DocLink to="/docs/employees">AI employees</DocLink>{" "}
            to draft answers, and set <Strong>rules</Strong> that triage new
            mail the moment it arrives. Everything syncs both ways.
          </>
        }
      />

      <H2 id="what">What this is</H2>
      <P>
        The <Strong>Email</Strong> section is a real mail client backed by
        your Gmail mailbox. Genosyn imports your <Strong>whole mailbox</Strong>{" "}
        into a local index and keeps it in step with Gmail in both directions:
        mail that arrives in Gmail shows up here within about a minute, and
        anything you do here — read, star, archive, label, draft, send,
        forward — is written straight back to Gmail. The goal is that you
        never need to open Gmail to work your inbox; read it there or here,
        act on it here, and neither drifts.
      </P>

      <Callout kind="info" title="Different from the email that Genosyn sends.">
        This is your inbox. It is unrelated to the transactional email Genosyn
        sends for password resets and invoices (Settings → Email), which stays
        exactly as it was.
      </Callout>

      <H2 id="connect">Connecting a mailbox</H2>
      <P>
        Email rides on the existing{" "}
        <DocLink to="/docs/integrations">Google integration</DocLink>, so a
        mailbox is one Google connection that granted the Gmail product at
        consent time.
      </P>
      <OL>
        <LI>
          Open <Strong>Settings → Integrations</Strong> and add (or reconnect)
          a <Strong>Google</Strong> connection. On Google&apos;s consent
          screen, tick the <Strong>Gmail</Strong> product so the connection
          carries the Gmail scope.
        </LI>
        <LI>
          Open <Strong>Email</Strong> from the section menu and pick that
          connection. Genosyn reads the account address and starts the first
          sync in the background.
        </LI>
        <LI>
          The first sync imports your <Strong>entire mailbox</Strong>, newest
          first, so everything is searchable here. A big account fills in over
          a few minutes in the background (the sidebar shows the running
          count); after that, sync is incremental. You can connect more than
          one mailbox and switch between them from the account picker at the
          top of the sidebar.
        </LI>
      </OL>

      <Callout kind="info" title="No Google Cloud Pub/Sub required.">
        Sync is poll-based on a short interval, so there is nothing to set up
        beyond the OAuth client you already registered for Google. Self-hosted
        installs get a working inbox with zero extra ceremony. (On a very large
        account you can cap the first import to recent mail with{" "}
        <Code>config.mail.backfillDays</Code>; the default imports everything.)
      </Callout>

      <H2 id="using">Reading and answering mail</H2>
      <P>
        The folder rail carries the usual views — Inbox, Starred, Sent, Drafts,
        All mail, Spam, Trash — plus your Gmail labels. Open a thread to read
        it, then <Strong>Reply</Strong>, <Strong>Reply all</Strong>,{" "}
        <Strong>Forward</Strong>, or <Strong>Compose</Strong> a new message —
        with file attachments if you need them. Star, archive, trash, mark
        read/unread, and apply labels all act on the whole thread and land in
        Gmail immediately. The search box matches subjects, participants, and
        the <Strong>full text of every message</Strong> in the index, not just
        what&apos;s visible in the list.
      </P>
      <P>
        Message bodies are rendered safely — scripts are stripped and remote
        images stay blocked behind a <Strong>Show images</Strong> click, so a
        tracking pixel can&apos;t phone home just because you opened a message.
      </P>

      <H2 id="hand-to-ai">Handing a thread to an AI employee</H2>
      <P>
        Open any thread and click <Strong>Hand to AI</Strong>. Pick an
        employee, write a short instruction, and choose what it should do:
      </P>
      <UL>
        <LI>
          <Strong>Draft a reply.</Strong> The employee writes a reply as a
          Gmail draft on the thread. Nothing is sent — you review the draft and
          press <Strong>Send</Strong> when it is right. This is the default and
          the safe way to put AI on your inbox.
        </LI>
        <LI>
          <Strong>Reply directly.</Strong> The employee composes and sends the
          reply itself. Only offered to employees you trust with{" "}
          <Strong>send</Strong> access.
        </LI>
        <LI>
          <Strong>Triage.</Strong> No writing — the employee reads the thread
          and files it: applies a label, archives, stars, or marks it read.
        </LI>
      </UL>
      <P>
        The handover runs the employee with its full{" "}
        <DocLink to="/docs/soul">Soul</DocLink>,{" "}
        <DocLink to="/docs/skills">Skills</DocLink>, and memory, and its
        progress and result show up right on the thread and on the{" "}
        <Strong>AI handovers</Strong> page. You get a notification when it
        finishes.
      </P>

      <H2 id="access">Giving AI employees mailbox access</H2>
      <P>
        Under <Strong>Email → Settings → AI access</Strong>, grant the
        employees who should be able to act on the mailbox, at one of three
        levels:
      </P>
      <UL>
        <LI>
          <Strong>Read.</Strong> Browse and search threads and labels — no
          changes.
        </LI>
        <LI>
          <Strong>Draft.</Strong> Also write drafts, apply labels, archive,
          star, and mark read. The default: an employee can triage the inbox
          and put a finished reply in the thread, but a human still sends it.
        </LI>
        <LI>
          <Strong>Send.</Strong> Also send mail on the account&apos;s behalf.
          Reserve this for employees trusted to speak for the company
          unattended.
        </LI>
      </UL>
      <Callout kind="warn" title="Members always have full access; grants govern AI only.">
        Human members of the company can already use every connected mailbox.
        These levels only decide what an AI employee&apos;s tools and rules are
        allowed to do.
      </Callout>

      <H2 id="rules">Rules — automating the inbox</H2>
      <P>
        A <Strong>rule</Strong> runs on every new message that arrives:{" "}
        <em>when an email matches these conditions, do these actions.</em>{" "}
        Conditions match on sender, recipient, subject, body text, and whether
        there&apos;s an attachment. Actions can apply a label, mark read, star,
        archive — and, the headline feature,{" "}
        <Strong>hand the thread to an AI employee</Strong> with an instruction
        and a mode.
      </P>
      <P>
        That is how you wire up &ldquo;when a support email comes in, ask an AI
        employee to categorize it and draft a first response&rdquo;: one rule,
        condition <Code>to contains support@</Code>, action{" "}
        <Strong>hand to employee</Strong> in <Strong>draft</Strong> mode. Every
        rule that matches fires, so labelling and handing off compose naturally.
      </P>
      <Callout kind="info" title="Rules never fire on your backfill.">
        Connecting a mailbox imports history quietly; rules only run on genuinely
        new mail after that, and never on drafts or your own sent messages — so
        connecting an account can&apos;t stampede an employee with hundreds of
        historical handovers.
      </Callout>

      <H3 id="routines">Rules vs. Routines</H3>
      <P>
        Rules are reactive — they fire when mail arrives. For scheduled email
        work (&ldquo;every morning, summarize yesterday&apos;s unread support
        threads&rdquo;), give an employee a{" "}
        <DocLink to="/docs/routines">Routine</DocLink> instead: a granted
        employee can search, read, draft, and send through the same mailbox
        from any routine, no new machinery required.
      </P>

      <H2 id="ai-tools">What employees can do with mail</H2>
      <P>
        Granted employees get a <Code>mail</Code> tool on the built-in{" "}
        <Code>genosyn</Code> MCP surface, with operations to list accounts,
        search and read threads, write drafts, triage (label / archive / mark
        read), and — with <Strong>send</Strong> access — send. Search runs over
        the same full-text index humans use and takes structured filters
        (sender, recipient, date range, label, has-attachment), so an employee
        can answer &ldquo;what did the vendor say about pricing last
        quarter?&rdquo; without a human forwarding anything. Every action an
        employee takes is checked against its grant level and recorded in the
        audit log and the employee&apos;s journal, so you can always see what
        it did after the fact.
      </P>

      <Callout kind="warn" title="Disconnecting is safe.">
        Removing a mailbox from Genosyn deletes the local mirror, rules, AI
        handovers, and grants here. Your Gmail account and the underlying Google
        connection are never touched — other Google surfaces keep working.
      </Callout>
    </>
  );
}
