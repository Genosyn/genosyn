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
          Select a step on the canvas to open its settings. Complete the required fields marked with{" "}
          <Strong>*</Strong>.
        </LI>
        <LI>
          Use <Strong>Next step</Strong> in the Flow section to make or change a connection. For an
          If / else step, choose separate <Strong>If true</Strong> and <Strong>If false</Strong>{" "}
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
        Channels, Projects, Bases, tables, AI employees, and Connections appear as pickers in step
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
            def: "Send a channel message, add a task, create a Project, add a Base record, ask an AI employee, or write a journal note.",
          },
          {
            term: "Transform or decide",
            def: "Make an HTTP request, set named values, branch with If / else, or pause for up to 60 seconds.",
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
        reference id is <Code>n_abc123</Code>, a later step can read one of its output fields with{" "}
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
          Branch paths are labelled <Code>true</Code> and <Code>false</Code> on the canvas and in
          Flow settings.
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
            def: "Starts for genuinely new inbound messages in a connected Gmail inbox. Filter by sender, subject, or whether the message has attachments. Connecting an inbox does not replay historical mail into Pipelines.",
          },
          {
            term: "Task created",
            def: "Starts when a task is added by a Member, AI employee, recurrence, or another Pipeline. Filter by Project, priority, or words in the title.",
          },
        ]}
      />
      <P>
        Email data is available under <Code>trigger.payload.message</Code>, including{" "}
        <Code>from</Code>, <Code>subject</Code>, <Code>bodyText</Code>,{" "}
        <Code>hasAttachments</Code>, and <Code>receivedAt</Code>. Task data is available under{" "}
        <Code>trigger.payload.task</Code>, with its Project under{" "}
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
        normally starts from a schedule, webhook, or company event. Automatic Runs are labelled
        with the schedule, webhook, or event that started them.
      </P>

      <H2 id="pipeline-or-routine">Pipeline or Routine?</H2>
      <P>
        Use a Pipeline when the path should be deterministic: same input, same connected steps. Use
        a <DocLink to="/docs/routines">Routine</DocLink> when an{" "}
        <DocLink to="/docs/employees">AI employee</DocLink> should interpret a brief, choose tools,
        and decide how to complete the work. A Pipeline can still use AI for one specific decision
        by adding an <Strong>Ask AI employee</Strong> step.
      </P>
    </>
  );
}
