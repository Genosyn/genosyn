import {
  Callout,
  Code,
  DocLink,
  H2,
  H3,
  KeyList,
  LI,
  OL,
  P,
  PageHeader,
  Pre,
  Strong,
  UL,
} from "@/docs/Prose";

export function Pipelines() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Pipelines"
        lead={
          <>
            Pipelines connect a <Strong>trigger</Strong> to predictable, repeatable{" "}
            <Strong>steps</Strong>. The same input follows the same connected path every time, and
            every Run records what happened.
          </>
        }
      />

      <Callout kind="info" title="Start → steps → result">
        That is the whole mental model. Something starts the pipeline, each connected step runs in
        order, and Run history keeps the result and step log.
      </Callout>

      <H2 id="create">Create a Pipeline</H2>
      <P>
        Open <Strong>Pipelines</Strong> from the section menu and choose{" "}
        <Strong>Create pipeline</Strong>. Name the outcome in plain language, add an optional
        purpose, then choose how the pipeline starts:
      </P>
      <KeyList
        rows={[
          {
            term: "Manual",
            def: "A Member starts it with Run now. Use this for one-off work, internal tools, and testing.",
          },
          {
            term: "Schedule",
            def: "Genosyn starts it automatically from a standard five-field cron schedule.",
          },
          {
            term: "Webhook",
            def: "Another system starts it by sending JSON to a private URL.",
          },
          {
            term: "Email received",
            def: "A genuinely new inbound email in a connected Gmail inbox starts it.",
          },
          {
            term: "Task created",
            def: "A new task in Projects + Todos starts it.",
          },
        ]}
      />
      <P>
        Choose <Strong>Open builder</Strong>. The trigger is already on the canvas; add what should
        happen next from the Step library.
      </P>

      <H2 id="builder">Use the builder</H2>
      <OL>
        <LI>
          Select the trigger or an existing step. Choosing another item from the{" "}
          <Strong>Step library</Strong> places it after the selected step and connects it when there
          is one unambiguous path.
        </LI>
        <LI>
          Select a step on the canvas to open its settings. Complete the required fields marked with
          {" "}
          <Strong>*</Strong>.
        </LI>
        <LI>
          Use <Strong>Next step</Strong> in the Flow section to make or change a connection. For an
          If / else step, choose separate <Strong>If true</Strong> and <Strong>If false</Strong>
          {" "}
          destinations. You can also drag the dot on the right of one step to the left dot on
          another.
        </LI>
        <LI>
          Choose <Strong>Arrange</Strong> to lay connected steps out from left to right. This
          changes only their positions, not what runs.
        </LI>
        <LI>
          Follow the setup bar above the canvas. <Strong>Run now</Strong> stays unavailable until
          every required field and connection is ready.
        </LI>
      </OL>

      <Callout kind="tip" title="Pick company objects instead of copying ids.">
        Channels, Projects, Bases, tables, AI Employees, and Connections appear as pickers in step
        settings. If the list is empty, use the link below the picker to create or connect the thing
        you need.
      </Callout>

      <H3 id="step-types">Step library</H3>
      <KeyList
        rows={[
          {
            term: "Start the pipeline",
            def: "Manual, Schedule, Webhook, Email received, and Task created triggers. A Pipeline needs at least one trigger.",
          },
          {
            term: "Work in Genosyn",
            def: "Send a channel message, add a task, create a Project, add a Base record, ask an AI Employee, or write a journal note.",
          },
          {
            term: "Transform or decide",
            def: "Run JavaScript, make an HTTP request, set named values, branch with If / else, or pause for up to 60 seconds.",
          },
          {
            term: "Use a Connection",
            def: "Choose a Connection and one of the actions its Integration exposes, then supply the action arguments as JSON.",
          },
        ]}
      />

      <H2 id="data">Pass data between steps</H2>
      <P>
        Text and JSON fields can insert values with double-brace references. Data that started the
        Run lives under <Code>trigger.payload</Code>. For example, a webhook body like{" "}
        <Code>{'{"name":"Ada"}'}</Code> can be inserted with{" "}
        <Code>{"{{trigger.payload.name}}"}</Code>.
      </P>
      <P>
        Each step also shows an <Strong>Output reference</Strong> in its settings. If a step&apos;s
        reference id is <Code>n_abc123</Code>, a later step can read one of its output fields with
        {" "}
        <Code>{"{{n_abc123.field}}"}</Code>. The Run&apos;s Step outputs section shows the exact
        object produced under each reference id.
      </P>
      <UL>
        <LI>
          A reference that fills the whole field preserves numbers, booleans, arrays, and objects. A
          reference inside a longer sentence becomes text.
        </LI>
        <LI>
          JSON setup fields must contain an object. The builder checks syntax before enabling Run
          now.
        </LI>
        <LI>
          <Strong>Add record (Base)</Strong> keys its JSON by field name — for example{" "}
          <Code>{'{"Email": "{{trigger.payload.email}}"}'}</Code>. The step lists the table&apos;s
          field names as you type, and a name that matches no field fails the Run rather than
          writing a cell nobody can read. Pipelines saved before this keep working: field ids are
          still accepted.
        </LI>
        <LI>
          Branch paths are labelled <Code>true</Code> and <Code>false</Code> on the canvas and in
          Flow settings.
        </LI>
      </UL>

      <H2 id="code">Run JavaScript</H2>
      <P>
        The <Strong>Run JavaScript</Strong> step runs the code you write, exactly as written, with a
        chosen timeout (1–60 seconds, 10 by default). Whatever the code returns becomes the
        step&apos;s output: return an object to give later steps named fields, and read it like any
        other step with <Code>{"{{<reference-id>.field}}"}</Code>. A thrown error fails the Run with
        that message in the log. Because the code carries company-wide authority, only a human can
        add or edit this step — an AI Employee authoring a Pipeline is refused it.
      </P>
      <Callout kind="warn" title="Self-hosted installs only.">
        The <Strong>Run JavaScript</Strong> step is unavailable on Genosyn Cloud and on any install
        running in shared SaaS mode. The step isolates code well enough to keep an honest program
        honest — fresh globals, no dynamic code generation, hard time and memory bounds — but it is
        not a boundary against someone deliberately trying to break out of it, and on shared
        infrastructure that boundary has to hold against every other tenant. The step is not offered
        in the palette, a Pipeline containing one reports an error, and a Run refuses it. Use{" "}
        <Strong>Make an HTTP request</Strong>, the <Strong>Base</Strong> steps, or{" "}
        <Strong>Call an integration</Strong> instead. See{" "}
        <DocLink to="/docs/saas-hosting">Shared SaaS mode</DocLink>.
      </Callout>
      <Pre lang="javascript">{`// Look up a lead, call an external API, and keep a score in a Base.
const [lead] = await genosyn.base.queryRecords("crm", "leads", {
  where: { Email: input.email },
});
const res = await axios.get("https://api.example.com/score", {
  params: { email: input.email },
});
if (lead) {
  await genosyn.base.updateRecord("crm", "leads", lead.id, { Score: res.data.score });
} else {
  await genosyn.base.createRecord("crm", "leads", {
    Email: input.email,
    Score: res.data.score,
  });
}
return { score: res.data.score };`}</Pre>
      <P>The code sees a small, fixed set of globals:</P>
      <KeyList
        rows={[
          {
            term: "input",
            def: (
              <>
                The trigger payload — a copy of the same data as <Code>trigger.payload</Code>.
                Double-brace references are not rewritten inside code; read data from these globals
                instead.
              </>
            ),
          },
          {
            term: "steps",
            def: (
              <>
                Outputs of earlier steps, keyed by reference id: <Code>steps.n_abc123.field</Code>.
              </>
            ),
          },
          {
            term: "genosyn.base",
            def: (
              <>
                <DocLink to="/docs/bases">Base</DocLink> records: <Code>listBases()</Code>,{" "}
                <Code>listTables(base)</Code>, <Code>getTable(base, table)</Code>,{" "}
                <Code>createRecord(base, table, values)</Code>,{" "}
                <Code>getRecord(base, table, id)</Code>,{" "}
                <Code>{"queryRecords(base, table, { where, limit, offset, order })"}</Code>,{" "}
                <Code>countRecords(base, table)</Code>,{" "}
                <Code>updateRecord(base, table, id, values)</Code>, and{" "}
                <Code>deleteRecord(base, table, id)</Code>. Bases and tables are addressed by slug;
                cells accept the column name or field id. Setting a cell to <Code>null</Code> clears
                it.
              </>
            ),
          },
          {
            term: "axios",
            def: (
              <>
                An axios-style HTTP client: <Code>axios.get(url, config)</Code>,{" "}
                <Code>axios.post(url, data)</Code>, <Code>put</Code>, <Code>patch</Code>,{" "}
                <Code>delete</Code>. Responses come back as{" "}
                <Code>{"{ status, headers, data }"}</Code> with JSON parsed automatically, and
                non-2xx statuses throw with <Code>error.response</Code> attached.
              </>
            ),
          },
          {
            term: "console + sleep",
            def: (
              <>
                <Code>console.log(…)</Code> writes to the Run log; <Code>sleep(ms)</Code> pauses
                within the step&apos;s time budget.
              </>
            ),
          },
        ]}
      />
      <UL>
        <LI>
          Everything is scoped to your company, and requests follow the same private-network
          protections as the HTTP request step.
        </LI>
        <LI>
          Limits per step: 50 HTTP requests with responses up to 2&nbsp;MB, 200 Base operations with
          up to 500 records per query, and a returned value up to 256&nbsp;KB of JSON.
        </LI>
      </UL>

      <H2 id="events">Company event triggers</H2>
      <P>
        Event triggers start a Run when something changes inside the company. Add one from the{" "}
        <Strong>Start the pipeline</Strong> section of the Step library, then use its optional
        filters to decide which events should match.
      </P>
      <KeyList
        rows={[
          {
            term: "Email received",
            def: "Starts for genuinely new inbound messages in a connected Gmail inbox. Name the mailboxes to watch, or leave that empty for all of them, and filter by sender, subject, or whether the message has attachments. Connecting an inbox does not replay historical mail into Pipelines.",
          },
          {
            term: "Task created",
            def: "Starts when a task is added by a Member, AI Employee, recurrence, or another Pipeline. Filter by Project, priority, or words in the title.",
          },
        ]}
      />
      <P>
        Email data is available under <Code>trigger.payload.message</Code>, including{" "}
        <Code>from</Code>, <Code>subject</Code>, <Code>bodyText</Code>, <Code>hasAttachments</Code>,
        {" "}
        <Code>accountAddress</Code> (the mailbox it arrived in), and <Code>receivedAt</Code>. Task
        data is available under <Code>trigger.payload.task</Code>, with its Project under{" "}
        <Code>trigger.payload.project</Code>. For example, use{" "}
        <Code>{"{{trigger.payload.task.title}}"}</Code> in a later message or task title.
      </P>
      <Callout kind="tip" title="Run now still works for event Pipelines.">
        Use Run now to check the connected steps without waiting for a real email or task. The test
        uses an empty payload, so fields that reference event data may be blank until a real event
        starts the Pipeline.
      </Callout>

      <H2 id="webhooks">Webhook Pipelines</H2>
      <P>
        Select a Webhook trigger to copy its private URL. Send a POST request with a JSON body; that
        body becomes <Code>trigger.payload</Code> for the Run. The Pipeline must be turned on for
        the URL to accept a Run.
      </P>
      <Callout kind="warn" title="Treat the URL like a password.">
        Anyone with the full webhook URL can start the Pipeline. Replacing it invalidates the old
        URL immediately, so update the sending system at the same time.
      </Callout>

      <H2 id="runs">Test and inspect Runs</H2>
      <P>
        Save the Pipeline and choose <Strong>Run now</Strong>. Genosyn starts a manual test with an
        empty payload, then opens <Strong>Run history</Strong>. Each Run shows:
      </P>
      <UL>
        <LI>whether it succeeded, failed, is still running, or was skipped;</LI>
        <LI>what started it, when it started, and how long it took;</LI>
        <LI>the step-by-step log and a plain error when a step failed;</LI>
        <LI>the starting payload and the final output from every reached step.</LI>
      </UL>
      <P>
        Run now is always recorded as <Strong>Started by a Member</Strong>, even when the Pipeline
        normally starts from a schedule, webhook, or company event. Automatic Runs are labelled with
        the schedule, webhook, or event that started them.
      </P>

      <H2 id="ai">How AI Employees use it</H2>
      <P>
        AI Employees build and maintain Pipelines through the built-in <Code>genosyn</Code> MCP
        server, not just run inside them. <Code>list_pipeline_node_types</Code> returns the step
        library with every config key; <Code>create_pipeline</Code> and <Code>update_pipeline</Code>
        {" "}
        write the steps and the connections between them; <Code>run_pipeline</Code> fires a test and
        hands back the log so the employee can fix what broke; <Code>list_pipeline_runs</Code> and
        {" "}
        <Code>get_pipeline_run</Code> answer &quot;did it work&quot; afterwards.{" "}
        <Code>rotate_pipeline_webhook_token</Code> issues a fresh webhook URL. Ask one to
        &quot;stand up a receiver for our marketing events&quot; and it can build the whole thing,
        test it, and hand you the URL.
      </P>
      <P>
        Every step an employee writes is checked against <Strong>its own</Strong> access before the
        Pipeline is saved. A Pipeline runs as the company, so this is what keeps that from becoming
        a way around <DocLink to="/docs/employees">the Grants you gave the employee</DocLink>: it
        can only wire up work it could already carry out itself. A step writing into a Base it holds
        no Grant on, posting into a private channel it was never added to, adding tasks to a
        restricted Project, or calling a Connection it was not granted is refused, and the employee
        is told which step and why. The <Strong>Run JavaScript</Strong> step is refused outright:
        its code runs with company-wide authority that no Grant can bound, so only a human can add
        or edit one.
      </P>
      <P>
        The check covers the <Strong>whole</Strong> Pipeline, not just the step being edited — a
        step reads <Code>{"{{other-step.field}}"}</Code> when it runs, so changing the step feeding
        a Connection changes what that Connection does. The practical consequence: once you add a
        step in the builder that an employee could not have written, that Pipeline&apos;s steps
        become yours. The employee can still see what it does and whether its Runs are passing, but
        it cannot change it, run it, delete it, read a Run&apos;s payload and outputs, or be handed
        its webhook URL.
      </P>
      <P>
        Two triggers need more than the usual, because left unscoped both of them watch things the
        employee may not be allowed to see. <Strong>Email received</Strong> must name the mailboxes,
        and the employee needs read access on each — empty means every mailbox, including ones
        connected months later. <Strong>Task created</Strong> must name a Project the employee can
        read. In both cases a human can still leave the scope empty in the builder; the Pipeline
        then runs exactly as it always has.
      </P>
      <Callout kind="info" title="Grants are checked when the Pipeline is written.">
        Like a Member who builds one and later loses access, an employee&apos;s Pipeline keeps
        running after a Grant is withdrawn — the Run has no principal to re-check. Open the Pipeline
        and pause or delete it if that is not what you want. The company audit log records which
        employee wrote it, and when. A webhook URL it was given also stays valid — if you add a step
        beyond its reach, rotate the URL from the trigger&apos;s panel.
      </Callout>
      <P>
        A Member chatting with an employee delegates their own authority, so the same owner-or-admin
        rule as the Pipelines page applies: anyone can ask an employee to read Pipelines and Runs,
        but creating, editing, deleting, running, or rotating a webhook needs an owner or admin
        driving the conversation. An employee working on its own — a{" "}
        <DocLink to="/docs/routines">Routine</DocLink> Run — is bound by its Grants instead.
      </P>

      <H2 id="pipeline-or-routine">Pipeline or Routine?</H2>
      <P>
        Use a Pipeline when the path should be deterministic: same input, same connected steps. Use
        a <DocLink to="/docs/routines">Routine</DocLink> when an{" "}
        <DocLink to="/docs/employees">AI Employee</DocLink> should interpret a brief, choose tools,
        and decide how to complete the work. A Pipeline can still use AI for one specific decision
        by adding an <Strong>Ask AI Employee</Strong> step.
      </P>
    </>
  );
}
