import { Callout, Code, DocLink, H2, KeyList, LI, P, PageHeader, Strong, UL } from "@/docs/Prose";

export function AskAi() {
  return (
    <>
      <PageHeader
        eyebrow="Get started"
        title="Ask AI"
        lead={
          <>
            One chat window, in the top bar on every page, that already knows what you are looking
            at. Ask any AI Employee — or several at once — about the invoice, email, Routine or
            record in front of you.
          </>
        }
      />

      <H2 id="open">Open it from anywhere</H2>
      <P>
        Press <Strong>Ask AI</Strong> in the top bar, or <Code>⌘J</Code> on a Mac and{" "}
        <Code>Ctrl J</Code> elsewhere. The panel docks beside the page you are on, so you can keep
        reading while you ask; drag its left edge to resize it. On a phone it opens full screen
        under the top bar. Press <Strong>Ask AI</Strong> again, or the <Strong>×</Strong>, to close
        it — any reply still being written carries on and is there when you reopen.
      </P>

      <H2 id="who-answers">Choose who answers</H2>
      <P>
        Type <Code>@</Code> and pick an <DocLink to="/docs/employees">AI Employee</DocLink>. Tag
        two or three to hear from each of them: they answer one after another, in the order you
        tagged them, and each later answer can read the earlier ones — so you get a second opinion,
        not the same answer twice. The <Strong>To</Strong> line above the message box always shows
        who will answer; remove someone with their <Strong>×</Strong> or add someone with{" "}
        <Strong>Add</Strong>. Up to five employees can answer one message.
      </P>
      <P>When you don&apos;t tag anyone, Ask AI chooses the same way every time:</P>
      <UL>
        <LI>the employees you picked on the To line;</LI>
        <LI>otherwise whoever answered your previous message in this conversation;</LI>
        <LI>
          otherwise whoever the page naturally belongs to — a Routine&apos;s or Run&apos;s owner, a
          Todo&apos;s AI assignee, the employee whose page you are on, the employee that raised a
          Decision;
        </LI>
        <LI>otherwise nobody, and Ask AI asks you to tag someone.</LI>
      </UL>
      <P>
        When the one employee answering has more than one connected{" "}
        <DocLink to="/docs/models">AI Model</DocLink>, a selector appears beside the To line. A
        conversation stays on whichever model an employee last answered on.
      </P>

      <H2 id="page-context">What it knows about the page</H2>
      <P>
        Whatever you have open travels with your message. The <Strong>Context</Strong> chips above
        the message box show exactly what: open an invoice and you see the invoice and its customer;
        open an email and you see the thread. Remove a chip with its <Strong>×</Strong> to leave
        that record out of the next message (<Strong>Restore</Strong> brings it back). On a page
        with no single record — a list, a dashboard of sections — the employee is told which page
        you are on and works from there with its tools.
      </P>
      <KeyList
        rows={[
          {
            term: "Finance",
            def: "Invoices (with their customer), estimates, credit notes, recurring invoices, bills and vendor credits (with their vendor), customers, a transaction open for review, an expanded journal entry, a vendor you are editing.",
          },
          {
            term: "Revenue & marketing",
            def: "Deals, accounts, contacts, partnerships, sequences, signals and campaigns.",
          },
          {
            term: "Work",
            def: "AI Employees, Skills, Routines and a Run you have open, Projects and the Todo you are peeking at, Decisions linked from elsewhere.",
          },
          {
            term: "Email & meetings",
            def: "The thread you are reading — and in the Drafts queue, the draft under your cursor — signature requests, and meetings.",
          },
          {
            term: "Knowledge",
            def: "Bases, tables and records, Pipelines, notebooks and Notes, Resources, Repositories, Charts, Dashboards and Workspace channels.",
          },
        ]}
      />
      <P>
        Each message remembers the page it was sent from, so a conversation can follow you around:
        ask about one invoice, open another, and &ldquo;what about this one?&rdquo; means the second.
        Records are read fresh every time, so a payment that just landed or a Run that just finished
        is part of the next answer. Some screens cover the top bar — a Run, a transaction under
        review, a draft opened from the Drafts queue — and carry their own{" "}
        <Strong>Ask AI</Strong> button, which hands that record to the panel.
      </P>

      <H2 id="access">Who sees what</H2>
      <P>
        Two checks apply to every record, and both must pass before an employee reads it:
      </P>
      <UL>
        <LI>
          <Strong>Yours.</Strong> A record only travels if you could open it yourself. A Member
          without finance access cannot send an invoice to anyone through Ask AI, and a private
          channel or restricted Project you are not in never resolves.
        </LI>
        <LI>
          <Strong>The employee&apos;s.</Strong> Showing a record to an AI Employee is sharing it, so
          it follows that employee&apos;s <DocLink to="/docs/integrations">Grants</DocLink>: Finance,
          Revenue, Marketing and Signing Grants, a Grant on the mailbox, Base, Note, Chart, Dashboard,
          Repository or Resource, membership of the Project or channel. An employee without the
          Grant is told that a record of that kind is open — not its name or contents — and the
          composer warns you before you send (&ldquo;Alex can&apos;t see Invoice INV-0042&rdquo;).
        </LI>
      </UL>
      <P>
        The same rule covers the conversation itself. An answer written with a record in view is
        never replayed to a later employee without that Grant, and when several employees answer
        one message, a later one only reads an earlier answer it would have been allowed to write.
        Your own words always replay. Nothing in Ask AI widens what an employee can do: its tools
        still check its Grants, and every action runs with your authority as well.
      </P>
      <Callout kind="info" title="Routines, Skills and AI Employees are open to every employee.">
        They are company configuration that employees already read through their tools, so any
        employee you tag is shown them in full — including the newest Run&apos;s log.
      </Callout>

      <H2 id="conversations">Your conversations</H2>
      <P>
        Conversations are yours alone — not even an owner can read another Member&apos;s. The panel
        reopens on the conversation you left. Click its title to switch to an earlier one or delete
        it, and press <Strong>+</Strong> for a new conversation. You can keep typing while an
        employee is answering: <Strong>Queue message</Strong> lines up follow-ups, which send one at
        a time once every answer to the message before has finished. If an answer fails, the queue
        pauses until you continue it, and the failed answer offers <Strong>Try again</Strong>, which
        asks the same employee about the same records again.
      </P>
      <P>
        A reply belongs to the server, not to your browser tab. Closing the panel, navigating, or
        reloading is safe; the panel shows <Strong>reconnecting</Strong> and follows the same reply
        to its end. Answers that genuinely could not run — Genosyn restarted mid-answer, or the
        employee stayed busy for several minutes — say so plainly.
      </P>

      <H2 id="files">Files and one-click actions</H2>
      <P>
        Attach files with the paperclip, paste a screenshot, or drag files onto the message box —
        see <DocLink to="/docs/workspace-chat#images">image formats and limits</DocLink>. Type{" "}
        <Code>#</Code> to tag another company resource. Files an employee produces, such as a filled
        PDF form, arrive as downloads on its answer. With an email open, an employee with a mailbox
        Grant can end its answer with{" "}
        <DocLink to="/docs/email#assistant">action buttons</DocLink> — send a draft, archive the
        thread, start a handover — that run with your authority when you click them.
      </P>

      <H2 id="replaced">What it replaced</H2>
      <P>
        Ask AI took over from the chats that used to live on individual pages: the Ask AI rail on a
        Routine, the chat docked beside every email and in the Drafts review drawer, a Base&apos;s AI
        assistant, a signature request&apos;s Ask AI hand-off, and the &ldquo;Why did it
        fail?&rdquo; chat inside a Run. The <Strong>Why did it fail?</Strong> buttons are still
        there; they now open Ask AI with the Run in context. Conversations from the old per-email
        and per-Routine chats are not carried over. Hand-offs that start work rather than a chat —{" "}
        <DocLink to="/docs/email#hand-to-ai">Hand to AI</DocLink> on an email, Proactive requests,
        and <DocLink to="/docs/help">Genosyn Help</DocLink> — work as before.{" "}
        <DocLink to="/docs/decisions#discussing">Discuss</DocLink> on a Decision keeps its own
        private discussion with the asking AI Employee, on the Decision itself.
      </P>
    </>
  );
}
