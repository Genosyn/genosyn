import {
  Callout,
  Code,
  DocLink,
  H2,
  KeyList,
  LI,
  OL,
  P,
  PageHeader,
  Strong,
  UL,
} from "@/docs/Prose";

export function Signatures() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Document signing"
        lead={
          <>
            Prepare a PDF, route it to customers for electronic signature, and keep the signed
            result, consent record, and customer relationship together in Genosyn. AI Employees can
            prepare and monitor requests; only the named recipients can sign them.
          </>
        }
      />

      <H2 id="send">Send a document for signature</H2>
      <OL>
        <LI>
          Open <Strong>Signatures → New request</Strong> and upload a PDF up to 25 MB and 200 pages.
          Add an optional Customer, message, expiry date, and choose parallel or ordered routing.
        </LI>
        <LI>
          Add each signer&apos;s name and email. Add copy recipients when someone should receive the
          completed document without signing it.
        </LI>
        <LI>
          Place fields on the PDF. Every signer needs at least one signature field; name, email,
          date, initials, text, and checkbox fields can be required or optional. Each signer has a
          distinct field color and their name stays on every field, so ownership remains clear. Drag
          a field to move it, or select it and drag its corner handle to resize it. The handle stays
          inside the page and may move beside fields placed at a page edge. The arrow keys move the
          selected field; the resize handle also supports arrow keys, with
          <Strong> Shift</Strong> for larger steps.
        </LI>
        <LI>
          Review the request and click <Strong>Send</Strong>. Genosyn freezes the source,
          recipients, fields, and routing so the agreement cannot change under a signer.
        </LI>
      </OL>
      <Callout kind="info" title="Configure the public URL and transactional email first">
        Signing links use the installation URL from <Strong>Admin → General</Strong>. Delivery uses
        the company&apos;s provider under <Strong>Settings → Email</Strong>, with the global SMTP
        fallback described in <DocLink to="/docs/self-hosting">Configuration</DocLink>. A local
        console-only install can create and test requests, but customers cannot reach localhost.
      </Callout>
      <P>
        Invitation and reminder emails identify the company and document, show the deadline and
        routing context, preserve the sender&apos;s message, and provide a prominent private signing
        button. Completion emails explain whether the recipient signed or received a copy and attach
        the completed PDF. Every email includes a plain-text version and guidance for recognizing
        and protecting the private signing link.
      </P>

      <H2 id="recipient">What the signer sees</H2>
      <P>
        Each recipient receives a separate high-entropy link. The link is the credential: its secret
        is never stored in the database, and sending a reminder replaces the prior link. The signer
        reviews the exact PDF, completes their assigned fields, consents to electronic records, and
        submits. They can also decline and give a reason. Signers do not need a Genosyn account.
        Date-signed fields use the signer&apos;s local calendar date; Genosyn binds the reported
        timezone and offset into the tamper-evident completion evidence.
      </P>
      <Callout kind="warn" title="Treat the link like a password">
        A signer&apos;s private link remains their read-only receipt after completion, including
        access to the final PDF. Do not forward it. Sending a reminder rotates an active link and
        makes the earlier one unusable.
      </Callout>
      <UL>
        <LI>
          <Strong>Parallel routing</Strong> sends every signer at once.
        </LI>
        <LI>
          <Strong>Ordered routing</Strong> sends only the first routing group. The next group is
          invited after every signer in the current group finishes.
        </LI>
        <LI>
          A completed request emails every signer and copy recipient the final PDF and keeps a
          download available from the request page.
        </LI>
      </UL>

      <H2 id="evidence">Completed PDF and evidence</H2>
      <P>
        Genosyn preserves the uploaded source and its SHA-256 fingerprint, stamps completed values
        into a new PDF, and appends a completion certificate. The certificate lists the document
        fingerprint, recipients, timestamps, consent, and the append-only event trail. Events form a
        hash chain, and each signer&apos;s accepted field values are bound to that chain with a
        canonical SHA-256 manifest printed on the certificate. International names and field values
        are embedded with licensed Unicode fonts; Genosyn rejects unsupported or non-fitting text
        before recording consent instead of silently changing it. A Customer-linked completion is
        also archived under <DocLink to="/docs/customers#contracts">Customers → Contracts</DocLink>.
      </P>
      <Callout kind="warn" title="Electronic evidence is not a qualified certificate signature">
        This workflow records intent, consent, identity assertions, delivery and document integrity.
        It does not issue a hardware-backed digital certificate or claim qualified electronic
        signature status. Legal requirements vary by document type and jurisdiction; use an
        appropriate trust service where certificate-backed identity is required.
      </Callout>

      <H2 id="ai">AI-native preparation and follow-through</H2>
      <P>
        Under <Strong>Signatures → AI access</Strong>, owners and admins choose one company-wide
        level per AI Employee. Start with the least access they need. Promoting an employee to Send
        shows a confirmation because that level can contact customers without another Member click.
      </P>
      <KeyList
        rows={[
          {
            term: "Read only",
            def: (
              <>
                List requests and inspect recipients, fields, delivery status, and evidence. It
                changes nothing.
              </>
            ),
          },
          {
            term: "Prepare drafts",
            def: (
              <>
                Everything in Read only, plus create a new request from a PDF Resource shared with
                that employee, configure recipients, and place fields. It cannot contact anyone.
              </>
            ),
          },
          {
            term: "Send to customers",
            def: (
              <>
                Everything in Prepare drafts, plus send invitations and reminders or void a request
                without another Member click. Every action is attributed to the AI Employee in the
                audit log and journal.
              </>
            ),
          },
        ]}
      />
      <P>
        To delegate a new setup, upload the PDF under <Strong>Resources</Strong>, open it, choose
        {""}
        <Strong>Share</Strong>, and give the employee View access. Then give that employee Prepare
        drafts access under Signatures and ask them in Chat to create the request. The result is a
        normal draft: a Member should inspect the PDF, recipients, field placement, routing,
        message, and expiry before sending it.
      </P>
      <P>
        An employee working an inbox does not have to wait for that upload. When a counterparty
        emails a contract, it can open the attachment with <Code>read_mail_attachment</Code>, turn a
        Word file into a PDF with <Code>convert_to_pdf</Code>, file the result as a PDF Resource
        with <Code>create_resource</Code> (<Code>sourceKind: &quot;file&quot;</Code>), and prepare
        the request from it — see <DocLink to="/docs/word-documents">Word documents</DocLink>. It
        authors that Resource, so it holds full control of that row and teammates start at View; the
        row records the employee as its author, and both the filing and the draft are written to the
        audit log and the employee&apos;s journal. What does not change is the gate that matters:
        preparing a draft emails nobody, and sending still needs Send to customers access and, in
        the ordinary setup, a Member who has read the document.
      </P>
      <P>
        <Strong>Ask AI</Strong> on a request saves valid unsaved changes, lets you choose among
        eligible AI Employees, and opens Chat with a draft readiness or status question. Nothing
        runs until you send that chat message. The employee can inspect the saved request
        configuration and evidence, but its signing tools cannot read the source PDF or edit an
        existing draft, so the Member remains responsible for checking document meaning and field
        placement.
      </P>
      <P>
        AI Employees can never call the recipient completion endpoint, see private signing links or
        accepted signature values, or supply a recipient&apos;s signature. They can summarize
        status, prepare a new request from a PDF Resource — one shared with them, or one they filed
        themselves from an email attachment — or, only with Send to customers access, send, remind,
        and void. The recipient&apos;s act always remains human.
      </P>

      <H2 id="control">Control the lifecycle</H2>
      <P>
        Senders can resend an individual recipient&apos;s link, void an active request with a
        reason, duplicate an existing request into a fresh draft, or download the original and
        completed PDFs. An expiry stops every outstanding link. Declined, voided, expired,
        failed-delivery, and completed states remain visible instead of disappearing, and every
        transition is evidence in the request timeline.
      </P>
      <P>
        Delivery attempts also appear under <Code>Settings → Email Logs</Code>. Backups include the
        database metadata and both PDFs under the company&apos;s data directory.
      </P>
    </>
  );
}
