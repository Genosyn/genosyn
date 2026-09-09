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

export function Employees() {
  return (
    <>
      <PageHeader
        eyebrow="Core concepts"
        title="AI Employees"
        lead={
          <>
            An AI Employee is a persistent teammate attached to a company. They have a name, a role,
            a model, a sandboxed working directory, and three editable pieces of prose that define
            who they are and how they work.
          </>
        }
      />

      <H2 id="anatomy">Anatomy</H2>
      <P>
        Every AI Employee row carries the fields you can configure from the UI plus a few the runner
        needs at spawn time:
      </P>
      <KeyList
        rows={[
          {
            term: "name + slug",
            def: "Display name (you can rename) and slug (frozen at create-time so URLs and directory paths stay stable).",
          },
          {
            term: "role",
            def: "A short role string — Brand writer, Bookkeeper, On-call SRE.",
          },
          {
            term: "soulBody",
            def: (
              <>
                Markdown stored on the row. The employee&apos;s constitution — see{" "}
                <DocLink to="/docs/soul">Soul</DocLink>.
              </>
            ),
          },
          {
            term: "skills[]",
            def: (
              <>
                One-to-many <Code>Skill</Code> rows. See <DocLink to="/docs/skills">Skills</DocLink>
                .
              </>
            ),
          },
          {
            term: "routines[]",
            def: (
              <>
                One-to-many <Code>Routine</Code> rows, managed from the top-level AI → Routines
                section. See <DocLink to="/docs/routines">Routines</DocLink>.
              </>
            ),
          },
          {
            term: "model",
            def: (
              <>
                One or more <Code>AIModel</Code> brains, one active at a time. See{" "}
                <DocLink to="/docs/models">AI Models</DocLink>.
              </>
            ),
          },
          {
            term: "reportsTo",
            def: "Optional pointer to another employee for an org chart. Used for handoffs.",
          },
          {
            term: "browserEnabled",
            def: (
              <>
                Flips on the built-in <Code>browser</Code> MCP server that drives real Google
                Chrome. Off by default. See <DocLink to="/docs/browser">Browser</DocLink>.
              </>
            ),
          },
          {
            term: "browserAllowedHosts",
            def: (
              <>
                Newline-separated host patterns limiting where the browser may navigate —{" "}
                <Code>github.com</Code> covers the domain and its subdomains. Blank means
                unrestricted.
              </>
            ),
          },
          {
            term: "browserApprovalRequired",
            def: (
              <>
                When on, form submits queue an Approval a human must grant before the browser fires
                them. See <DocLink to="/docs/browser">Browser</DocLink>.
              </>
            ),
          },
        ]}
      />

      <H2 id="lifecycle">Lifecycle</H2>
      <OL>
        <LI>
          <Strong>Create.</Strong> Set the company mission and vision first, then pick a template (a
          starter Soul and Skill set) or start blank. Hiring does not schedule Routines. The slug
          freezes; you can rename freely afterward.
        </LI>
        <LI>
          <Strong>Attach a model.</Strong> Pick a provider and authentication method. Anthropic
          takes an API key; OpenAI takes an API key or, on trusted single-tenant Genosyn, eligible
          ChatGPT subscription access; Custom takes an OpenAI-compatible endpoint. You can skip this
          and connect one later.
        </LI>
        <LI>
          <Strong>Write the Soul.</Strong> Answer the short About questions, then review the seeded
          constitution and rewrite it to fit your team.
        </LI>
        <LI>
          <Strong>Choose Routines.</Strong> Genosyn selects responsibilities that fit the saved role
          and uses company mission and vision to rank them and write their instructions. An edited
          role takes precedence over the starting template. Suggestions remain opt-in until you
          select them and choose the primary <Strong>Schedule N Routines and continue</Strong>,
          which creates them and advances in one press.
        </LI>
        <LI>
          <Strong>Connect the work.</Strong> Integration cards distinguish between Connect, Grant
          needed, Attention, and Ready. A Connection alone does not give the AI Employee access; it
          still needs an explicit Grant.
        </LI>
        <LI>
          <Strong>Fire.</Strong> Deleting an employee removes their DB rows, including the encrypted
          credential row for every model they held. There&apos;s no shared key to revoke.
        </LI>
      </OL>

      <Callout kind="tip" title="Routine suggestions appear after every hire.">
        The first-company guide opens them between the AI Employee and Email steps. The regular{" "}
        <Strong>AI → Employees → Hire AI Employee</Strong> flow opens it after the Soul review. Both
        use the same recommendation rules, and both can be skipped — in the guide with{" "}
        <Strong>Continue without adding them</Strong>. Suggestions never overwrite an existing
        Routine or create a duplicate; skipping creates no Routines, Connections, or Grants.
        Anything you do add starts running on its own schedule straight away. See{" "}
        <DocLink to="/docs/getting-started">Getting started</DocLink> for the full flow.
      </Callout>

      <H2 id="working-directory">Working directory</H2>
      <P>Each employee gets their own folder on disk under the company:</P>
      <pre className="mt-4 overflow-x-auto border border-hairline bg-ground px-5 py-4 font-mono text-[12.5px] leading-[1.7] text-ink2">
        {`data/companies/<co-slug>/employees/<emp-slug>/
└── ...   # files enabled coding tools read and write`}
      </pre>
      <P>
        Coding access depends on the installation mode. The default bubblewrap mode provides
        sandboxed <Code>bash</Code> and materializes repositories; where its Linux namespaces are
        unavailable, boot falls back to disabled, which exposes no coding tools and materializes no
        repositories. Separately acknowledged host mode provides path-confined file and search tools
        rooted in this directory (<Code>read_file</Code>, <Code>write_file</Code>,{" "}
        <Code>edit_file</Code>, <Code>list_dir</Code>, <Code>glob</Code>, and <Code>grep</Code>) but
        never exposes <Code>bash</Code>, because a working directory is not a security boundary for
        an unrestricted same-user shell. The runner captures the agent transcript into a Run log.
        API-key and custom models use Genosyn&apos;s in-process loop; OpenAI subscription models use
        the official Codex app-server. A Routine does not make its AI Employee unavailable: Members
        can keep chatting with that employee and start independent Routines in parallel without a
        per-company application cap. Several conversations with the same AI Employee also reply in
        parallel; only two turns in one thread are serialized. Concurrent work shares this directory
        when coding is enabled, so give overlapping Runs distinct output files and avoid
        simultaneous edits to the same git working tree. Model credentials stay encrypted in the
        database. They never enter the employee working directory. For an OpenAI subscription login
        or Run, Genosyn gives the official app-server a locked temporary <Code>CODEX_HOME</Code>.
        Managed ChatGPT sessions are materialized there; access tokens enter only the child process
        environment. Genosyn removes the directory afterward. Trusted single-tenant installs support
        subscription auth in the bubblewrap default, including standard Docker, alongside isolated
        coding and repository synchronization — and in the disabled fallback, with no coding tools
        or repository materialization. Host mode rejects subscription auth.
      </P>

      <H3 id="org-chart">Org chart</H3>
      <P>
        Set <Code>reportsTo</Code> on an employee to give them a manager. Genosyn renders this as an
        org chart and surfaces it to the runner — useful when you want a <Strong>Handoff</Strong>{" "}
        from one employee to another to follow the reporting line.
      </P>

      <H2 id="surfaces">Surfaces inside the app</H2>
      <P>
        An AI Employee is two places: <Strong>Chat</Strong> and <Strong>Settings</Strong>. The
        switch between them sits at the top right of the employee&apos;s header, next to their name.
        Everything you configure or inspect about an employee lives under Settings, grouped as{" "}
        <Strong>Employee</Strong> (General, Soul, Model, Memory), <Strong>Work</Strong> (Skills,
        Routines, Journal, Handoffs), and <Strong>Access</Strong> (Connections, MCP, Browser,
        Integrations).
      </P>
      <UL>
        <LI>
          <Strong>Chat.</Strong> Free-form conversations with the employee. Messages persist; action
          pills surface tool calls inline. Type <Code>/new</Code> to open a fresh context, or{" "}
          <Code>#</Code> and a name to tag a product area or any company resource you can see. Use
          <Code>@</Code> for people and AI Employees; <Code>#</Code> tells the employee what product
          or record to work on, and you can add several tags to one instruction. Attach files with
          the paperclip, or paste a screenshot and drag files onto the composer. When the employee
          creates a file for you, it appears beneath their reply; select the attachment chip to
          download it. During substantial multi-step work, the employee can replace the typing dots
          with a live activity card and update it at meaningful milestones. A new live turn keeps
          the quiet typing indicator until the employee reports real progress; after that, the card
          shows its current step and percentage. A restored turn stays indeterminate until its next
          real milestone, and the card distinguishes live updates from saved updates or a
          reconnecting browser. As soon as the reply begins, the progress card gives way to the
          response. Long turns can run for up to six hours. If the live connection drops, you reload
          the page, or the Genosyn server restarts, Genosyn follows the persisted turn automatically
          instead of marking it failed. After a server restart, a short renewable database lease
          lets one replacement worker resume the request safely from its saved context and latest
          milestone; it checks current state before continuing so completed side effects are not
          repeated. The final reply reappears in the same thread. You can keep writing while the
          employee works — follow-ups queue and send in order within that thread, while your other
          conversations with the same employee carry on answering in parallel. When the answer in
          flight has stopped being the one you want, choose <Strong>Interrupt &amp; send</Strong> on
          the queued message (or press <Code>⌘/Ctrl+Enter</Code> in the composer) and the employee
          puts down what it is doing so that message goes next. Whatever it had already written
          stays in the thread, marked <Strong>interrupted</Strong>, and the next turn can see it. A
          stop lands as soon as the step already running hands back, so a long tool call can take a
          moment. Chat stays available while that employee&apos;s Routines run.
          <br />
          <br />
          Under the composer, next to the model picker, Genosyn shows{" "}
          <Strong>how full the model&apos;s context window is</Strong> — the share of it the last
          turn&apos;s prompt occupied. The number comes from the provider&apos;s own token count for
          that turn, never a local estimate, and it updates as the employee works. Hover it for the
          exact figures. Past 80% it turns amber: the employee is close to the point where Genosyn
          starts dropping the oldest tool results to make room, which is the moment to finish the
          thread or type <Code>/new</Code> for a fresh context. If the AI Model has no known context
          window the badge shows the token count alone and links to the model settings, because
          there is no ceiling to measure against — see{" "}
          <DocLink to="/docs/models">AI Models</DocLink>.
        </LI>
        <LI>
          <Strong>Settings → Soul.</Strong> The employee&apos;s constitution. Markdown, ⌘S to save.
        </LI>
        <LI>
          <Strong>Settings → Model.</Strong> The AI Model this employee thinks with — see{" "}
          <DocLink to="/docs/models">AI Models</DocLink>.
        </LI>
        <LI>
          <Strong>Settings → Memory.</Strong> Durable facts and preferences injected into every
          conversation and routine run. Unlike the free-form Soul, each item is one short fact you
          can add, edit, or delete on its own.
        </LI>
        <LI>
          <Strong>Settings → Skills / Routines.</Strong> These are company-wide sections, not
          per-employee ones: they live at AI → <DocLink to="/docs/skills">Skills</DocLink> and AI →{" "}
          <DocLink to="/docs/routines">Routines</DocLink>. The two entries under Settings open those
          lists filtered to this employee, and are marked with a corner arrow to say so.
        </LI>
        <LI>
          <Strong>Settings → Journal.</Strong> Append-only diary the employee writes about their own
          work via the built-in MCP server. Routine runs land here automatically, and the last seven
          days are injected into every chat and routine run. For the server&apos;s own account of
          the same work, rather than the employee&apos;s, see{" "}
          <DocLink to="/docs/employees#work-timeline">the work timeline</DocLink> below.
        </LI>
        <LI>
          <Strong>Settings → Handoffs.</Strong> Work this employee has delegated to another, and
          work delegated to them. Creating a Handoff starts the receiver working immediately in a
          background session (when they have a connected model) — delegation is a &quot;go&quot;
          signal, not a note on a desk. A pending Handoff past its due date escalates: the
          receiver&apos;s manager and the company&apos;s admins get a bell, once.
        </LI>
        <LI>
          <Strong>Settings → Connections.</Strong> The list of{" "}
          <DocLink to="/docs/integrations">Grants</DocLink> this employee holds.
        </LI>
        <LI>
          <Strong>Settings → MCP.</Strong> Extra Model Context Protocol servers this employee can
          use, plus the external endpoint that lets another MCP client reach Genosyn as this
          employee.
        </LI>
        <LI>
          <Strong>Settings → Browser.</Strong> Whether this employee may drive a browser — see{" "}
          <DocLink to="/docs/browser">Browser</DocLink>.
        </LI>
        <LI>
          <Strong>Settings → General.</Strong> Name, role, slug, profile picture, org chart — and,
          at the bottom, deleting the employee.
        </LI>
      </UL>

      <Callout kind="info" title="Models are employee-owned, on purpose.">
        Each employee owns their own provider credentials, stored encrypted (AES-256-GCM) in the
        database — even when they register several models, every API key, endpoint credential, or
        OpenAI subscription credential belongs to that one employee. There&apos;s no shared
        company-wide model credential. Firing an employee deletes all of their encrypted credential
        rows; you don&apos;t have to rotate anything for the rest of the team.
      </Callout>

      <H2 id="work-timeline">The work timeline</H2>
      <P>
        Your <DocLink to="/docs">Home page</DocLink> keeps a compact{" "}
        <Strong>bubble for each AI Employee</Strong> to the right of your greeting. The bubbles form
        a small horizontal row in the header, leaving the cards below the full width of the page. On
        a narrow screen, they stay beside the greeting. Scroll the row sideways when the whole team
        does not fit. Their status distinguishes
        <Strong> Working now</Strong>, <Strong>Waiting for input</Strong>, recent work, and a quiet
        day. Work details stay hidden until you choose an employee.
      </P>
      <P>
        Choose a bubble to open the employee&apos;s <Strong>work timeline</Strong> in a popup. It
        opens on today, with the clock down the left and work arranged through the day, like a
        calendar&apos;s day view. Each entry says what happened and shows its result, and work
        happening in the same hour stays readable as separate entries. Use{" "}
        <Strong>Previous day</Strong> and <Strong>Next day</Strong>, or choose a date with{" "}
        <Strong>Work day</Strong>, to browse today and the previous six days. Choose{" "}
        <Strong>Today</Strong> to return to the current day. Dates and times follow your
        browser&apos;s local time, with the timezone shown above the calendar.
      </P>
      <P>Everything you need to follow up stays close to the work:</P>
      <UL>
        <LI>
          <Strong>Read a Routine Run&apos;s summary</Strong> beside its time, such as &quot;Created
          five overdue invoices and sent three payment reminders. Two invoices need your
          review.&quot; Its status, outcome and Check badges remain visible. Tool calls, Connection
          counts and individual changes stay in the run log.
        </LI>
        <LI>
          <Strong>Check in</Strong> opens the employee&apos;s Chat, and{" "}
          <Strong>Employee details</Strong> opens their Settings. Close the popup to return to Home.
        </LI>
      </UL>
      <P>Seven kinds of work land on it:</P>
      <UL>
        <LI>
          <Strong>Routine runs</Strong> show a concise outcome in the employee&apos;s day. If no
          outcome summary was recorded, the entry says so; an active Run says it is still working.
          The status, outcome and checks badges from <DocLink to="/docs/routines">Routines</DocLink>{" "}
          remain visible. Choose <Strong>Open the run log</Strong> for the full report, tool calls
          and <DocLink to="/docs/verification#effects">Effects</DocLink>, without leaving Home.
        </LI>
        <LI>
          <Strong>Conversations.</Strong> One line per thread, saying how many times the employee
          replied. A reply still in flight is shown as current work, including its latest progress
          label and percentage for the Member who started it. A thread you did not start is reported
          without its subject or progress — transcripts stay private to the Member who asked for
          them.
        </LI>
        <LI>
          <Strong>Repository work</Strong>, with the files, insertions and deletions each turn
          produced — see <DocLink to="/docs/repositories">Repositories</DocLink>.
        </LI>
        <LI>
          <Strong>Approvals required by actions they attempted</Strong>, so an employee waiting at a
          system gate is visible rather than only as a queue entry.
        </LI>
        <LI>
          <Strong>Wakeups</Strong> that fired and <Strong>Lessons</Strong> taken from a graded run —
          see <DocLink to="/docs/reactivity">Reactivity</DocLink> and{" "}
          <DocLink to="/docs/improvement">Improvement</DocLink>.
        </LI>
        <LI>
          <Strong>Changes</Strong> — the individual records an employee created, edited or sent.
          Changes made inside a Run stay with its run log. Conversation changes appear under their
          conversation; changes with no parent stand on their own.
        </LI>
      </UL>
      <P>
        The roster stays visible even when the whole team is quiet, because it is also the quickest
        way to reach an employee and check in, and an employee&apos;s own day says plainly when
        there is nothing recorded for the selected date. A busy employee cannot crowd another
        employee&apos;s status out of the roster: the circles use a per-employee summary the server
        calculates before any display limit is applied, and opening one employee&apos;s day asks for
        that employee and date alone. Work still running — and an unresolved Approval still waiting
        — remains in the current status even when it began before the recent-work window. The day
        view stays bounded to the selected date and says when there is more recorded work than it
        can display.
      </P>
      <Callout kind="info" title="An outcome summary is a report; Checks and verdicts assess it.">
        A Run&apos;s summary comes from its recorded final report, or the outcome assessment when a
        final report is unavailable. The employee&apos;s report does not prove the work succeeded:
        read the independent <DocLink to="/docs/verification">Checks and verdicts</DocLink> beside
        it, and open the run log for evidence. Timeline entries still come from recorded work;
        writing a Journal entry does not create one. The work timeline is available on every plan to
        every Member. The <DocLink to="/docs/plans-billing">audit log</DocLink> is the separate
        admin tool for investigating every actor across all of history.
      </Callout>
    </>
  );
}
