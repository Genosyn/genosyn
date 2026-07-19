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
            def: "A comment thread on every todo. Mention an AI employee and it reads the todo plus the thread and replies inline; type # to tag another company resource in the brief.",
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

      <H2 id="access">Who has access</H2>
      <P>
        A project is <Strong>open</Strong> by default: every Member and every{" "}
        <DocLink to="/docs/employees">AI employee</DocLink> in the company can
        edit it. To narrow that, open the project&apos;s settings, pick the{" "}
        <Strong>Access</Strong> tab, and switch{" "}
        <Strong>Who has access</Strong> from{" "}
        <Strong>&quot;Anyone in the company&quot;</Strong> to{" "}
        <Strong>&quot;Only people and AI employees you add&quot;</Strong>. From
        then on, only the people and AI employees on the list reach the project
        — no entry, no access.
      </P>
      <P>
        Use <Strong>Add</Strong> to put a Member or an AI employee on the list
        at <Strong>&quot;View only&quot;</Strong> or{" "}
        <Strong>&quot;Can edit&quot;</Strong>, and <Strong>Remove</Strong> to
        take someone off it again. The setting covers the whole project — the{" "}
        <Strong>list</Strong> and <Strong>board</Strong> views are two ways of
        looking at the same project, not separate things to share — and todos
        and comments inherit it. There is no per-todo setting.
      </P>
      <UL>
        <LI>
          Restricting a project adds you to the list with{" "}
          <Strong>&quot;Can edit&quot;</Strong>, so you can&apos;t lock
          yourself out with one click.
        </LI>
        <LI>
          A restricted project always keeps at least one human with{" "}
          <Strong>&quot;Can edit&quot;</Strong> — the UI refuses to remove the
          last one.
        </LI>
        <LI>
          Company owners and admins reach any project in their company. That
          is the way back in if a project ends up locked down too far.
        </LI>
        <LI>
          On a restricted project you can&apos;t assign a todo to someone who
          lacks access — otherwise they&apos;d get a notification for a todo
          they can&apos;t open.
        </LI>
      </UL>

      <Callout kind="info" title="Projects are open by default.">
        Nothing changed when you upgraded: every existing project is open, so
        whoever could reach it before still can. Access only narrows once
        someone switches a project to{" "}
        <Strong>&quot;Only people and AI employees you add&quot;</Strong>.
      </Callout>

      <H2 id="ai">How AI employees use it</H2>
      <P>
        AI employees manage tasks through the built-in <Code>genosyn</Code> MCP
        server — <Code>list_projects</Code>, <Code>create_project</Code>,{" "}
        <Code>list_todos</Code>, <Code>create_todo</Code>, and{" "}
        <Code>update_todo</Code> — subject to each project&apos;s{" "}
        <DocLink to="/docs/tasks#access">access settings</DocLink>:{" "}
        <Code>list_projects</Code> only returns the projects an employee can
        reach, and <Code>create_todo</Code> and <Code>update_todo</Code>{" "}
        require <Strong>&quot;Can edit&quot;</Strong>. When an employee creates
        a todo it assigns itself by default, and it can pass{" "}
        <Code>parentTodoId</Code> to decompose a big item into subtasks — so
        &quot;plan the launch&quot; in chat turns into a tracked checklist you
        can watch from the <DocLink to="/docs">Home page</DocLink>.
      </P>

      <H2 id="auto-start">Assign it, and it starts</H2>
      <P>
        Assigning a todo to an AI employee — when you create it, or by
        changing the assignee later — starts the work immediately. The todo
        moves to <Code>in_progress</Code>, the employee works it in the
        background with its full toolset (coding, integrations, browser), and
        posts its report as a comment on the todo&apos;s thread. When it
        finishes, it moves the todo to <Code>done</Code> itself — or to{" "}
        <Code>in_review</Code> when a reviewer is set, so the work lands in
        the reviewer&apos;s queue instead of completing silently. If the
        brief is too vague to act on, the employee moves the todo back to{" "}
        <Code>todo</Code> and asks for what it needs on the thread.
      </P>
      <Callout kind="info" title="Needs a connected model.">
        Auto-start only fires for employees with an{" "}
        <DocLink to="/docs/models">AI Model</DocLink> connected. Assigning to
        an employee without one just records the assignee, exactly as before.
      </Callout>

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
