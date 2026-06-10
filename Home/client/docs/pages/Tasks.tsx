import {
  Callout,
  Code,
  DocLink,
  H2,
  KeyList,
  LI,
  P,
  PageHeader,
  Strong,
  UL,
} from "@/docs/Prose";

export function Tasks() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Tasks"
        lead={
          <>
            A Linear-style task manager built in: organize work into{" "}
            <Strong>Projects</Strong>, break it into <Strong>todos</Strong> and{" "}
            <Strong>subtasks</Strong>, and assign any of it to humans or AI
            employees. Find it under <Strong>Tasks</Strong> in the section
            menu.
          </>
        }
      />

      <H2 id="projects">Projects &amp; todos</H2>
      <P>
        A <Strong>Project</Strong> groups related work and mints short ids like{" "}
        <Code>ENG-42</Code> from its key. Inside a project, todos move through
        six statuses — <Code>backlog</Code>, <Code>todo</Code>,{" "}
        <Code>in_progress</Code>, <Code>in_review</Code>, <Code>done</Code>,{" "}
        <Code>cancelled</Code> — in either a <Strong>list</Strong> or a
        drag-and-drop <Strong>board</Strong> view. Each todo carries:
      </P>
      <KeyList
        rows={[
          {
            term: "Assignee",
            def: "A human member or an AI employee. New todos default to whoever created them — explicitly clear the picker to leave one unassigned.",
          },
          {
            term: "Reviewer",
            def: "Who signs the work off. Moving a todo to in_review notifies the reviewer; the cross-project Review queue collects everything waiting on you.",
          },
          {
            term: "Priority & due date",
            def: "Five priority levels and an optional due date, both visible on cards and rows.",
          },
          {
            term: "Repeat",
            def: "Daily through yearly cadences. Completing a recurring todo schedules the next occurrence automatically.",
          },
          {
            term: "Discussion",
            def: "A comment thread on every todo. Mention an AI employee and it reads the todo plus the thread and replies inline.",
          },
        ]}
      />

      <H2 id="subtasks">Subtasks</H2>
      <P>
        Open any todo and use <Strong>Add a subtask</Strong> in its panel to
        break the work into steps. Subtasks are real todos — their own status,
        assignee, and discussion — nested one level under a parent:
      </P>
      <UL>
        <LI>
          The parent shows a progress bar and a <Code>2/5</Code> chip wherever
          it appears; subtask rows carry a <Code>↳ ENG-42</Code> chip that
          jumps back to the parent.
        </LI>
        <LI>
          One level deep by design — a subtask can&apos;t have subtasks of its
          own, which keeps boards and review flows legible.
        </LI>
        <LI>Deleting a parent deletes its subtasks with it.</LI>
      </UL>

      <H2 id="ai">How AI employees use it</H2>
      <P>
        Every AI employee can manage tasks through the built-in{" "}
        <Code>genosyn</Code> MCP server: <Code>list_projects</Code>,{" "}
        <Code>create_project</Code>, <Code>list_todos</Code>,{" "}
        <Code>create_todo</Code>, and <Code>update_todo</Code>. When an
        employee creates a todo it assigns itself by default, and it can pass{" "}
        <Code>parentTodoId</Code> to decompose a big item into subtasks — so
        &quot;plan the launch&quot; in chat turns into a tracked checklist you
        can watch from the <DocLink to="/docs">Home page</DocLink>.
      </P>

      <Callout kind="info" title="Reviews close the loop.">
        Ask an employee to mark its work <Code>in_review</Code> with you as the
        reviewer instead of <Code>done</Code>. You&apos;ll get a notification
        (and a push notification on your phone, if enabled — see{" "}
        <DocLink to="/docs/mobile">Install on your phone</DocLink>), and the
        todo waits in your Review queue until you sign it off.
      </Callout>
    </>
  );
}
