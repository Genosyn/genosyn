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

export function Tasks() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Tasks"
        lead={
          <>
            A Linear-style task manager built in: organize work into <Strong>Projects</Strong>,
            break it into <Strong>todos</Strong> and <Strong>subtasks</Strong>, and assign any of it
            to humans or AI Employees. Find it under <Strong>Tasks</Strong> in the section menu.
          </>
        }
      />

      <H2 id="projects">Projects &amp; todos</H2>
      <P>
        A <Strong>Project</Strong> groups related work and mints short ids like <Code>ENG-42</Code>{" "}
        from its key. Inside a project, todos move through six statuses — <Code>backlog</Code>,{" "}
        <Code>todo</Code>, <Code>in_progress</Code>, <Code>in_review</Code>, <Code>done</Code>,{" "}
        <Code>cancelled</Code> — in either a <Strong>list</Strong> or a drag-and-drop{" "}
        <Strong>board</Strong> view. The view you pick is remembered for next time (a phone always
        starts on the list). A new project opens with the cursor in <Strong>Add a todo</Strong>, so
        its first todos are just typing and Enter; on any project, <Code>c</Code> jumps there too,
        and <Code>Esc</Code> closes an open todo. Once you have a few projects, type in{" "}
        <Strong>Filter projects</Strong> and press Enter to open the top match. Each todo carries:
      </P>
      <KeyList
        rows={[
          {
            term: "Assignee",
            def: "A human member or an AI Employee. New todos default to whoever created them — explicitly clear the picker to leave one unassigned.",
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
            def: "A comment thread on every todo. Mention an AI Employee and it reads the todo plus the thread and replies inline; type # to tag another company resource in the brief.",
          },
        ]}
      />

      <P>
        Clicking a todo opens it beside the board. <Strong>Open full page</Strong> gives it a page of
        its own, with an address you can share and room for a long thread.
      </P>

      <H2 id="create-anywhere">Create a task from anywhere</H2>
      <P>
        Press <Code>⌥T</Code> on a Mac or <Code>Alt T</Code> on Windows and Linux on any page, even
        in the middle of typing in a field, an open form or an email. <Strong>Create a task</Strong>{" "}
        opens over what you were doing. Write a title and press Enter, and you&apos;re back where
        you left off with your cursor where it was. On a phone, or if you forget the keys, open the
        section pill in the top nav (<Code>⌘K</Code>, or <Code>Ctrl K</Code> on Windows and Linux)
        and choose <Strong>Create a task</Strong>.
      </P>
      <UL>
        <LI>
          <Strong>Project</Strong> starts on the Project you have open, or else the last one you
          filed a task in. It lists only Projects you can edit.
        </LI>
        <LI>
          <Strong>Assign to</Strong> starts on you. Choose an AI Employee and it starts as soon as
          you create the task, within your access and its Grants.
        </LI>
        <LI>
          <Strong>Advanced</Strong> holds status, priority, due date, reviewer and repeat. Its line
          says what you changed, so nothing you set is hidden when it&apos;s closed.
        </LI>
        <LI>
          <Code>⌘Enter</Code> (<Code>Ctrl Enter</Code>) creates the task from inside{" "}
          <Strong>What needs doing</Strong>, and <Code>Esc</Code> closes the modal without creating
          anything.
        </LI>
      </UL>

      <H2 id="subtasks">Subtasks</H2>
      <P>
        Open any todo and use <Strong>Add a subtask</Strong> in its panel to break the work into
        steps. Subtasks are real todos — their own status, assignee, and discussion — nested one
        level under a parent:
      </P>
      <UL>
        <LI>
          The parent shows a progress bar and a <Code>2/5</Code> chip wherever it appears; subtask
          rows carry a <Code>↳ ENG-42</Code> chip that jumps back to the parent.
        </LI>
        <LI>
          One level deep by design — a subtask can&apos;t have subtasks of its own, which keeps
          boards and review flows legible.
        </LI>
        <LI>Deleting a parent deletes its subtasks with it.</LI>
      </UL>

      <H2 id="home">What&apos;s happening</H2>
      <P>
        <Strong>Tasks</Strong> opens on what&apos;s happening across every Project you can open, so
        you can tell at a glance without going into one:
      </P>
      <KeyList
        rows={[
          {
            term: "Needs you",
            def: "Todos in review with you as reviewer, waiting on a person, or waiting on an approval or a Decision.",
          },
          {
            term: "AI working now",
            def: "Sessions running at this moment, who is on them and since when, and how many more are queued.",
          },
          {
            term: "Waiting",
            def: "Todos waiting on a customer, a work session or a date, and when they check back.",
          },
          {
            term: "Done in the last day",
            def: "What finished, with the first line of its report.",
          },
        ]}
      />
      <P>
        To hand something over, type it in <Strong>What needs doing?</Strong> at the top, choose who
        does it and where it goes, and press enter. It files the todo and starts them on it, and the
        details can go on the todo afterwards. It remembers who and where you chose last.
      </P>
      <P>
        A todo opens with one sentence saying where it stands, such as who is working on it or what
        it&apos;s waiting on. Rows on a board say <Strong>Working</Strong> or{" "}
        <Strong>Queued</Strong> next to the assignee.
      </P>

      <H2 id="links">Where a todo came from</H2>
      <P>
        A todo can be linked to the record it came from or is about: an email thread, a{" "}
        <DocLink to="/docs/customers">Customer</DocLink>, a Contact or Deal in{" "}
        <DocLink to="/docs/revenue">Revenue</DocLink>, a{" "}
        <DocLink to="/docs/decisions">Decision</DocLink>, a Meeting, a Routine Run, a{" "}
        <DocLink to="/docs/repositories#work-sessions">work session</DocLink>, an estimate, an
        invoice, a bill, or a Support ticket. It reads both
        ways: the todo&apos;s panel says <Strong>From email</Strong> with a link to the thread, and
        the thread lists the todo under <Strong>Tasks</Strong>. Customer, Contact, Deal, estimate,
        invoice, bill and ticket pages show the same <Strong>Tasks</Strong> card when something is
        linked to them.
      </P>
      <P>
        To make one from an email, open the thread and choose <Strong>Create task</Strong>. The
        title starts as the subject, and you pick the Project and who it goes to. See{" "}
        <DocLink to="/docs/email#create-task">Email</DocLink>.
      </P>
      <UL>
        <LI>
          A link grants nothing. On a todo, a link to a record you can&apos;t open shows only that
          one exists, and a record lists only the todos in Projects you can open.
        </LI>
        <LI>
          A todo keeps the name of what it was linked to, so it still says which email it came from
          after that thread is gone from Genosyn. The name just stops being a link.
        </LI>
        <LI>
          Hover a link in the panel and press its <Strong>×</Strong> to remove it.
        </LI>
      </UL>

      <H2 id="access">Who has access</H2>
      <P>
        A project is <Strong>open</Strong> by default: every Member and every{" "}
        <DocLink to="/docs/employees">AI Employee</DocLink> in the company can edit it. To narrow
        that, open the project&apos;s settings, pick the <Strong>Access</Strong> tab, and switch{" "}
        <Strong>Who has access</Strong> from <Strong>&quot;Anyone in the company&quot;</Strong> to{" "}
        <Strong>&quot;Only people and AI Employees you add&quot;</Strong>. From then on, only the
        people and AI Employees on the list reach the project — no entry, no access.
      </P>
      <P>
        Use <Strong>Add</Strong> to put a Member or an AI Employee on the list at{" "}
        <Strong>&quot;View only&quot;</Strong> or <Strong>&quot;Can edit&quot;</Strong>, and{" "}
        <Strong>Remove</Strong> to take someone off it again. The setting covers the whole project —
        the <Strong>list</Strong> and <Strong>board</Strong> views are two ways of looking at the
        same project, not separate things to share — and todos and comments inherit it. There is no
        per-todo setting.
      </P>
      <UL>
        <LI>
          Restricting a project adds you to the list with <Strong>&quot;Can edit&quot;</Strong>, so
          you can&apos;t lock yourself out with one click.
        </LI>
        <LI>
          A restricted project always keeps at least one human with{" "}
          <Strong>&quot;Can edit&quot;</Strong> — the UI refuses to remove the last one.
        </LI>
        <LI>
          Company owners and admins reach any project in their company. That is the way back in if a
          project ends up locked down too far.
        </LI>
        <LI>
          On a restricted project you can&apos;t assign a todo to someone who lacks access —
          otherwise they&apos;d get a notification for a todo they can&apos;t open.
        </LI>
      </UL>

      <Callout kind="info" title="Projects are open by default.">
        Nothing changed when you upgraded: every existing project is open, so whoever could reach it
        before still can. Access only narrows once someone switches a project to{" "}
        <Strong>&quot;Only people and AI Employees you add&quot;</Strong>.
      </Callout>

      <H2 id="ai">How AI Employees use it</H2>
      <P>
        In a Todo&apos;s discussion, paste a screenshot, drag files onto the message box, or use the
        paperclip. Choose an AI Employee when you want an answer about the image. Sent images stay
        in the discussion and are available when the employee replies or works on the Todo. See{" "}
        <DocLink to="/docs/workspace-chat#images">image formats and limits</DocLink>.
      </P>
      <P>
        AI Employees manage tasks through the built-in <Code>genosyn</Code> MCP server —{" "}
        <Code>list_projects</Code>, <Code>create_project</Code>, <Code>list_todos</Code>,{" "}
        <Code>create_todo</Code>, <Code>update_todo</Code>, <Code>add_todo_comment</Code>,{" "}
        <Code>start_todo</Code>, <Code>wait_on_todo</Code>, <Code>link_todo</Code>, and{" "}
        <Code>unlink_todo</Code> — subject to each project&apos;s{" "}
        <DocLink to="/docs/tasks#access">access settings</DocLink>: <Code>list_projects</Code> only
        returns the projects an employee can reach, and the writes require{" "}
        <Strong>&quot;Can edit&quot;</Strong>. <Code>list_todos</Code> reads a project a page at a
        time in the board&apos;s order, with description previews (<Code>get_todo</Code> reads one
        in full), and narrows to open work or to the employee&apos;s own Todos. A todo an employee
        creates while working an email links that thread by itself, and <Code>get_mail_thread</Code>{" "}
        shows the work a thread already started, so it isn&apos;t started twice;{" "}
        <Code>link_todo</Code> and <Code>unlink_todo</Code> manage the rest, for records its own
        Grants let it read. An employee can hand a todo to a person as well as to a teammate —{" "}
        <Code>list_members</Code> gives it each Member&apos;s user id — and that person must be able
        to open the project. When an employee creates a todo it assigns itself by default, and it
        can pass <Code>parentTodoId</Code> to decompose a big item into subtasks — so &quot;plan the
        launch&quot; in chat turns into a tracked checklist you can watch from the{" "}
        <DocLink to="/docs">Home page</DocLink>.
      </P>

      <H2 id="auto-start">Assign it, and it starts</H2>
      <P>
        Assigning a todo to an AI Employee, when you create it or by changing the assignee later,
        puts it on that employee&apos;s work queue. Each employee works one todo at a time, highest
        priority first, so a busy morning is a queue and not twenty sessions at once. The todo moves
        to <Code>in_progress</Code>, the panel shows the employee working step by step with a{" "}
        <Strong>Stop</Strong> button, and its report lands as a comment on the thread, with the
        steps behind a <Strong>Worked for…</Strong> line. If it used the browser, the{" "}
        <DocLink to="/docs/browser#live-view">recording</DocLink> is under its report. When it finishes, it moves the todo to{" "}
        <Code>done</Code> itself, or to <Code>in_review</Code> when a reviewer is set, so the work
        lands in the reviewer&apos;s queue instead of completing silently. If the brief is too vague
        to act on, it moves the todo back to <Code>todo</Code> and asks for what it needs.
      </P>
      <UL>
        <LI>
          <Strong>Who it works for.</Strong> When you assign it, the employee works within both your
          current access and its Grants. Coding, browser, Connections, and configured MCP servers
          remain owner/admin-only on an interactive assignment.
        </LI>
        <LI>
          <Strong>AI Employees hand work to each other.</Strong> A todo one employee assigns to
          another starts by itself, with what the first one&apos;s turn was allowed. If that turn
          could only prepare, or read a web page, the colleague&apos;s session is held to the same
          limit, so handing work over can&apos;t shed one. A todo an employee puts on its own list
          doesn&apos;t start a separate session unless it asks with <Code>start_todo</Code>.
        </LI>
        <LI>
          <Strong>It waits rather than fails.</Strong> During a{" "}
          <DocLink to="/docs/standdowns">Standdown</DocLink> or while its{" "}
          <DocLink to="/docs/models">AI Model</DocLink> is unavailable, the todo stays queued, says
          why in its panel, and starts by itself afterwards. A restart hands the work to the next
          worker, told what the first attempt already changed. A real error tries again after 5
          minutes, 30 minutes and 2 hours, then says so on the thread and tells a person.
        </LI>
        <LI>
          <Strong>It can&apos;t loop.</Strong> A session that ends with the todo still open gets one
          more try, then a person is asked to look. A todo gets at most 10 automatic sessions in a
          day, and work passing through more than 5 AI hand-offs waits for a Member.
        </LI>
        <LI>
          <Strong>Start now</Strong> in the panel sends the assignee back to a todo that sat, under
          your access, within any limits the todo is held to. Nothing already assigned starts by itself when you upgrade; only a new
          assignment or Start now does.
        </LI>
      </UL>
      <H2 id="finance">Todos and Finance</H2>
      <P>
        An AI Employee can file a todo, create the estimate and mark the todo done, and the two link
        by themselves, without anyone naming the link. Whatever it creates while working a todo goes
        on that todo: an estimate, an invoice, a bill, a Customer, a Contact or a Deal, and any
        ticket it works. Filing, creating and sending stay under their own Grants, Policies and
        Approvals, and a session held to limits still can&apos;t create an estimate.
      </P>
      <P>
        You can work from either side. <Strong>Create task</Strong> on an estimate, invoice, bill or
        ticket files a todo linked to it. On a todo, <Strong>Create</Strong> opens the usual estimate
        or invoice form, and what you save links to the todo. Reading a Finance link takes Finance
        access: without it you see that a link exists, and not what it&apos;s called.
      </P>

      <H2 id="code">Todos and code</H2>
      <P>
        When an AI Employee working a todo starts a{" "}
        <DocLink to="/docs/repositories#work-sessions">Repository work session</DocLink>, the todo
        links to it by itself. You can go from the todo to the session, and the session&apos;s page
        has a <Strong>Tasks</Strong> card that comes back. When the session opens a pull request, a
        line with the link goes on the todo&apos;s thread.
      </P>
      <P>
        You can do the same by hand. On a todo assigned to an AI Employee with access to a
        Repository, <Strong>Start work session</Strong> starts one with the todo&apos;s text as its
        instruction, under your access. <Strong>Create task</Strong> on a session&apos;s page goes the
        other way. A todo with outside words on it can&apos;t start a session, because a session runs commands
        and those words came from outside. Create a task in your own words instead.
      </P>
      <H2 id="waiting">Waiting on someone</H2>
      <P>
        When an AI Employee can&apos;t finish without an answer, it asks and then says what it is
        waiting on. The todo stays <Code>in_progress</Code> with a{" "}
        <Strong>Waiting on customer</Strong> chip on its card, and a banner in its panel gives the
        reason, since when, and when it checks back. The session ends, so waiting costs nothing, and
        the same todo picks up when the answer arrives:
      </P>
      <KeyList
        rows={[
          {
            term: "A customer replies",
            def: "A new email on the linked thread wakes the todo at once, with the reply as data. It can prepare and put an exact reply in the Decision stack; it doesn't get more than that from an email, whoever started the work. An out-of-office or a bounce doesn't count as a reply.",
          },
          {
            term: "Nobody replies",
            def: "It checks back when it said it would, at most 30 days out. After three checks with no reply it must close the todo or ask a person.",
          },
          {
            term: "A person answers",
            def: "If it asked on the thread, your comment wakes it, working under your access unless the todo is held to limits.",
          },
          {
            term: "A work session ends",
            def: "If it started a Repository work session and is waiting on that, the todo picks up when the session's turn ends, told how it went and about any pull request. A session that failed wakes it too.",
          },
          {
            term: "A Decision or a review",
            def: "Raising a Decision, or proposing an email or work for review, makes the todo wait on it. When you answer, send, discard or decline, the same todo carries on and reports on its own thread. A sent email moves it on to waiting for the reply.",
          },
        ]}
      />
      <P>
        Press <Strong>Stop waiting</Strong> in the panel to send the employee back now, within any
        limits the todo is held to. A finished todo stays finished when mail arrives on its thread, so a
        &quot;thanks!&quot; doesn&apos;t reopen it, and a Member assigned to a todo hears about new
        mail on its thread in their bell.
      </P>

      <H2 id="email-intake">Email that becomes work</H2>
      <P>
        A Project can take incoming email by itself: the AI Employee reading each mailbox files what
        belongs there as a todo, linked to the email, and whoever works these starts on it. It is
        off until an owner or admin turns it on under{" "}
        <Strong>Project settings → Email intake</Strong>. Say which email belongs there, who works
        it, and how to work it. Anyone can email you, so nothing in an email can grant anything.
        What it can do is what you set here ahead of time:
      </P>
      <KeyList
        rows={[
          {
            term: "On, as it starts",
            def: "It can research and prepare, keep its own todos, and propose replies and bigger work. A person sends each reply from the Decision stack and approves the rest, then it carries on.",
          },
          {
            term: "Send replies without review",
            def: "It may also answer without anyone reading first, on the email's own thread, to the people already on it, without attachments, at most 3 times a thread in 24 hours. It needs Send access to the mailbox. Everything else stays preparation.",
          },
          {
            term: "Trusted senders",
            def: "Mail from an address or @domain you list, which the receiving mail server verifies, can also use this employee's browser and the Vault logins it's granted, with no one approving first. Everything else stays preparation, and replies still follow the setting above. The mail server vouches for the domain rather than the address, so only list domains where you trust everyone who can send. A thread someone else has also written on doesn't count, because a reply carries what it quotes. Gmail mailboxes only for now, because an IMAP mailbox can't show who verified what.",
          },
        ]}
      />
      <P>
        For a customer support desk with a queue, response targets and replies quoted from your
        Articles, use <DocLink to="/docs/support">Support</DocLink> instead. Mail a Support inbox
        takes goes there and is not filed here.
      </P>
      <P>
        For the admin job this was built for, a store emailing that an agreement needs accepting:
        put the store&apos;s address under Trusted senders, assign someone with the login in{" "}
        <DocLink to="/docs/vault">Vault</DocLink> and the site on their browser host list, and write
        how to do it in the instruction. It files the todo, signs in from the saved login rather
        than any link in the email, and reports on the thread. Leave browser approval on for an act
        that binds the company: each submit waits for a person, the todo says{" "}
        <Strong>Waiting on browser approval</Strong>, and your decision starts it again.
      </P>
      <P>
        It also needs <DocLink to="/docs/email#analysis">AI analysis</DocLink> on for the mailbox, and
        whoever works these needs Mail access to it. If they don&apos;t have it the todo is filed
        unassigned and owners hear why. It reads each email once, as it arrives, and nothing else
        files one: reading an email again, a mailbox&apos;s instructions, and older mail don&apos;t.
        Spam, marketing, auto-replies, blocked senders and a thread with open work are never filed,
        filing starts no Pipelines, and a Project takes at most 100 emails a day. A reply on a thread
        with open work wakes that work instead, under these same limits.
      </P>
      <P>
        Limits only tighten for a todo. Once a stranger&apos;s email has touched one, it stays
        preparation-only for every session on it, even if a trusted sender writes on the thread
        later. A session held to preparing can only change its own todo and that thread. Mentioning
        the employee, answering it, reassigning the todo and Stop waiting all stay within those
        limits, because none of them says the email&apos;s words are safe.
      </P>
      <P>
        To take it further yourself, press <Strong>Use my access</Strong> in the panel. That one
        session can do what you can, with the email&apos;s words still on its thread, so anything it
        sends waits for approval. It goes back to its limits afterwards. New mail on the thread before that session starts ends it, and it stays within the limits.
        Limits also follow the work: a todo held to them starts no Pipeline, its next occurrence
        inherits them, and a todo an employee comments on while it&apos;s working from an email is
        held from then on. A Routine posting a status on your todo doesn&apos;t hold it.
      </P>

      <H2 id="email-to-done">From email to done</H2>
      <P>
        <Strong>An admin job.</Strong> A store emails that an agreement needs accepting, and you
        want an AI Employee to deal with it.
      </P>
      <OL>
        <LI>
          Make a Compliance Project. Under <Strong>Project settings → Email intake</Strong>, turn on{" "}
          <Strong>Take email into this Project</Strong>, say which email belongs there, choose who
          works it, and write how to do it. Under <Strong>Advanced</Strong>, add the store&apos;s
          address to <Strong>Trusted senders</Strong>.
        </LI>
        <LI>
          Give that employee what the job needs:{" "}
          <DocLink to="/docs/email#access">Mail access</DocLink> to the mailbox, the login in the{" "}
          <DocLink to="/docs/vault">Vault</DocLink>, and the site on its{" "}
          <DocLink to="/docs/browser#allow-list">browser allow list</DocLink>. Leave{" "}
          <DocLink to="/docs/browser#approvals">approval-gated submits</DocLink> on for anything
          that binds the company.
        </LI>
        <LI>
          The email arrives. The <DocLink to="/docs/email#analysis">analysis</DocLink> on it says{" "}
          <Strong>Filed to COMP-12</Strong>, and the todo says <Strong>From email</Strong>. The
          employee starts by itself, signs in from the saved login, and waits for you to approve the
          submit if approval is on.
        </LI>
        <LI>Its report lands on the todo, which moves to done or to your review.</LI>
      </OL>
      <P>
        <Strong>A customer request.</Strong> A customer emails your support address with a question
        it can&apos;t answer yet.
      </P>
      <OL>
        <LI>
          Make a Support Project with Email intake on. To let it answer by itself, set{" "}
          <Strong>Replies</Strong> to <Strong>Send replies without review</Strong> and give the
          employee Send access to the mailbox. Otherwise each reply waits for you in the{" "}
          <DocLink to="/docs/decisions">Decision stack</DocLink>.
        </LI>
        <LI>
          The todo is filed and started. The employee asks the customer what it needs and marks the
          todo <Strong>Waiting on customer</Strong>, and the session ends.
        </LI>
        <LI>
          The customer replies. The same todo starts again with the reply, and the employee carries
          on and reports. If nobody replies, it checks back when it said it would.
        </LI>
      </OL>
      <P>
        To see where it all stands, an employee&apos;s <Strong>Work queue</Strong> under its
        settings lists what it&apos;s working on, what&apos;s queued and why, and what&apos;s
        waiting. Choose <Strong>Assigned to AI</Strong> in a Project&apos;s filter to see the same
        on its board. The heartbeat that starts queued work is a database query, so a day with
        nothing to do uses no AI Model.
      </P>

      <Callout kind="warn" title="AI assignment requires a browser session.">
        Starting an AI Employee is an interactive delegation, so creating or changing an AI assignee
        requires a logged-in browser session. Personal API keys can still automate ordinary todo
        fields and can press Stop, but cannot launch an AI Employee by assigning one.
      </Callout>
      <Callout kind="info" title="Needs a connected model.">
        Assigning to an employee without a connected <DocLink to="/docs/models">AI Model</DocLink>{" "}
        just records the assignee, exactly as before. Connecting a model later doesn&apos;t start a
        backlog of old assignments; press Start now on the ones you want.
      </Callout>
      <Callout kind="info" title="A todo no Member wrote is a request, not an instruction.">
        A todo an AI Employee or a Pipeline wrote reaches the session that works it as data. It says
        what was asked for and can&apos;t change that employee&apos;s Soul, Grants or limits.
      </Callout>

      <Callout kind="info" title="Reviews close the loop.">
        Ask an employee to mark its work <Code>in_review</Code> with you as the reviewer instead of{" "}
        <Code>done</Code>. You&apos;ll get a notification (and a push notification on your phone, if
        enabled — see <DocLink to="/docs/mobile">Install on your phone</DocLink>) that opens the
        todo itself, ready to approve or push back, and the todo waits in your Review queue until
        you sign it off. <Strong>Open in project</Strong> there (and <Strong>Open the board</Strong>{" "}
        from Home) opens that todo beside its board. In the todo&apos;s panel,{" "}
        <Strong>Approve &amp; mark done</Strong> closes the panel and returns you to the row, while{" "}
        <Strong>Push back</Strong> leaves the cursor in the comment box for your reason.
      </Callout>
      <P>
        The reviewer can be an AI Employee too. A todo entering <Code>in_review</Code> with an AI
        reviewer queues a review session instead of ringing a bell, which starts once the
        assignee&apos;s report is written: the reviewer reads the thread, verifies what the report
        claims with its own tools, and moves the card itself — <Code>done</Code> when the work holds
        up, back to <Code>in_progress</Code> with what&apos;s missing when it doesn&apos;t. When the
        assignee is also an AI Employee, rework goes back as a Handoff, which starts them on the fix
        immediately. After three review passes the card stays in review for a human to break the
        tie, so two AI teammates can&apos;t ping-pong a card forever.
      </P>
    </>
  );
}
