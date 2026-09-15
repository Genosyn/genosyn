import {
  Callout,
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

export function Forms() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Forms"
        lead={
          <>
            Turn an active <DocLink to="/docs/bases">Base</DocLink> table into a polished public
            form. Each question writes to one field, and each accepted submission becomes one
            ordinary row in that table.
          </>
        }
      />

      <H2 id="gallery">Start in the Forms gallery</H2>
      <P>
        Open the Base table that should receive the responses and choose <Strong>Forms</Strong> in
        its header. The gallery shows that table&apos;s Draft, Live, and Closed forms, response
        counts, and the latest response date. To collect into another table, open that table first.
      </P>
      <P>
        Choose <Strong>New form</Strong>, enter a form title, then choose{" "}
        <Strong>Create form</Strong>. A form does not create a second response store: its table
        remains the source of truth, so saved views, filters, automations, and granted AI Employees
        can work with a submission as soon as it arrives.
      </P>
      <Callout kind="tip" title="Design the table first">
        Create the fields you want to collect before opening the editor. A short, purpose-built
        intake table is easier to explain to respondents than a large operating table.
      </Callout>

      <H2 id="questions">Map questions to Base fields</H2>
      <P>
        In the editor, set the form title and description, then choose{" "}
        <Strong>Add question → Create a table field</Strong>. Each question stays mapped to that Base
        field even when you give it friendlier public wording. You can change its{" "}
        <Strong>Question</Strong> label, add <Strong>Help text</Strong>, make it{" "}
        <Strong>Required</Strong>, or remove it without renaming or deleting the field.
      </P>
      <KeyList
        rows={[
          {
            term: "Text and long text",
            def: "Short answers and paragraphs.",
          },
          {
            term: "Email and URL",
            def: "Address-shaped answers with format checks.",
          },
          {
            term: "Number",
            def: "A numeric answer, checked before the row is created.",
          },
          {
            term: "Checkbox",
            def: "A true / false answer.",
          },
          {
            term: "Date and datetime",
            def: "A calendar date, with an optional time when the Base field includes one.",
          },
          {
            term: "Select and multiselect",
            def: "One or several choices drawn from the field's current options.",
          },
        ]}
      />
      <P>
        Table-to-table <Strong>link</Strong> fields and fields that link to Genosyn resources —
        Customers, Invoices, Projects, AI Employees, Members, Notes, and Pipelines — are deliberately
        unavailable as public questions. Their pickers could reveal private company records, and an
        anonymous respondent has no authority to choose those relationships. Add or review those
        links inside the Base after submission instead.
      </P>

      <H2 id="validation">What the form checks</H2>
      <P>
        Use <Strong>Preview</Strong> before publishing. The same checks run on the public page and
        again when Genosyn receives a submission, so changing what is sent from a browser cannot
        bypass the table&apos;s rules.
      </P>
      <UL>
        <LI>Every required question must have an answer.</LI>
        <LI>Numbers, dates, email addresses, and URLs must match their field type.</LI>
        <LI>Select answers must still be options on the destination field.</LI>
        <LI>
          Only questions configured on the form are accepted; hidden or stale field values cannot
          be added to the row.
        </LI>
      </UL>
      <P>
        A submission either passes every check and creates its row, or creates nothing. If a field
        changed after publishing, Genosyn rejects the stale response instead of writing a partly
        valid row.
      </P>
      <P>
        The <Strong>Submission</Strong> settings also control the submit button, success title and
        message, and whether the success screen offers <Strong>Submit another response</Strong>.
        These change the respondent&apos;s experience, not the destination table.
      </P>

      <H2 id="publish">Publish and share</H2>
      <OL>
        <LI>Use <Strong>Preview</Strong> to read the form as a respondent will see it.</LI>
        <LI>
          Open <Strong>Share</Strong> and choose <Strong>Publish form</Strong> when at least one
          current question is ready. A Draft&apos;s link does not open a public form.
        </LI>
        <LI>
          Choose <Strong>Copy link</Strong> and send it to anyone who should fill the form. They do
          not need a Genosyn account.
        </LI>
        <LI>
          Choose <Strong>Close form</Strong> to stop new submissions without removing earlier rows.
          The link stays open and explains that the form is not accepting responses.{" "}
          <Strong>Reopen form</Strong> starts collection again.
        </LI>
        <LI>
          If the link reaches the wrong audience, choose <Strong>Reset public link</Strong> and
          confirm <Strong>Create new link</Strong>. This rotates the link: the old one stops working
          immediately, while the form and rows already collected stay in place.
        </LI>
      </OL>
      <Callout kind="info" title="Use a real public URL">
        Share links use the address set under <Strong>Admin → General → Public URL</Strong>. A
        localhost address works only on the machine running Genosyn. Before sharing outside your
        network, give a self-hosted install a reachable HTTPS address and update that setting.
      </Callout>

      <H2 id="responses">Find responses in the Base</H2>
      <P>
        A successful submission appears immediately as a new row in the destination table, with
        each answer in its mapped field. Choose <Strong>Back to table</Strong>, or open the table
        from <Strong>Bases</Strong>; from there it behaves like any other record and can be filtered,
        commented on, shown in a view, or handled by an automation.
      </P>
      <P>
        Retries are safe. If a connection drops after Genosyn saves the row and the browser retries
        that same send, Genosyn returns the original success instead of adding a duplicate row. A
        newly completed form is a new submission and creates a new row.
      </P>

      <H2 id="destination-changes">When the destination changes</H2>
      <UL>
        <LI>
          <Strong>Archived table:</Strong> the public form becomes unavailable and accepts no
          submissions. Restore the table and review the form before sharing again.
        </LI>
        <LI>
          <Strong>Field used by a form:</Strong> remove the question in the Form editor before
          deleting its destination field. Genosyn blocks the deletion while that mapping exists.
        </LI>
        <LI>
          <Strong>Permanently deleted table or Base:</Strong> the public link stops working, and the
          destination rows are removed as part of that permanent deletion. This cannot be undone.
        </LI>
      </UL>

      <H2 id="privacy">Privacy and spam</H2>
      <P>
        Treat the public link like an unlisted invitation: anyone who has it can submit, and someone
        can forward it. Respondents cannot browse the Base, see other responses, or discover the
        company records excluded from public questions. Reset the link whenever its audience is no
        longer the one you intended.
      </P>
      <UL>
        <LI>
          Public forms do not prove who submitted an answer. Ask for a name or email when identity
          matters, and verify important requests separately.
        </LI>
        <LI>
          Genosyn rejects oversized or malformed submissions and limits abusive bursts, but a public
          link can still attract spam. Close it when collection ends and review incoming rows before
          triggering sensitive work.
        </LI>
        <LI>
          Collect only the information you need. Your hosting, backups, Member access, and retention
          choices still determine how submitted personal data is protected.
        </LI>
      </UL>
    </>
  );
}
