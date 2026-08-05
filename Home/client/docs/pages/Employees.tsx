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
            An AI Employee is a persistent persona attached to a company. They have a name, a role,
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
                Flips on the built-in <Code>browser</Code> MCP server that drives a headless
                Chromium. Off by default. See <DocLink to="/docs/browser">Browser</DocLink>.
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
          <Strong>Create.</Strong> Pick a template (a starter Soul + Skill set) or start blank. The
          slug freezes; you can rename freely afterward.
        </LI>
        <LI>
          <Strong>Write the Soul.</Strong> The app drops you into the Soul editor with a seeded
          constitution. Rewrite it to fit your team.
        </LI>
        <LI>
          <Strong>Attach a model.</Strong> Pick a provider and authentication method. Anthropic
          takes an API key; OpenAI takes an API key or, on self-hosted Genosyn, eligible ChatGPT
          subscription access; Custom takes an OpenAI-compatible endpoint.
        </LI>
        <LI>
          <Strong>Add skills + routines.</Strong> Skills describe what they know; Routines describe
          when they work.
        </LI>
        <LI>
          <Strong>Fire.</Strong> Deleting an employee removes their DB rows, including the encrypted
          credential row for every model they held. There&apos;s no shared key to revoke.
        </LI>
      </OL>

      <H2 id="working-directory">Working directory</H2>
      <P>Each employee gets their own folder on disk under the company:</P>
      <pre className="mt-4 overflow-x-auto rounded-xl border border-slate-200 bg-slate-50 px-5 py-4 font-mono text-[12.5px] leading-[1.7] text-slate-700">
        {`data/companies/<co-slug>/employees/<emp-slug>/
└── ...   # files the employee's coding tools read and write`}
      </pre>
      <P>
        The runner starts the selected agent runtime with this directory as <Code>cwd</Code> for the
        built-in coding tools (<Code>bash</Code>, <Code>read_file</Code>, <Code>write_file</Code>,{" "}
        <Code>edit_file</Code>, <Code>glob</Code>, <Code>grep</Code>), and captures the agent
        transcript into a Run log. API-key and custom models use Genosyn&apos;s in-process loop;
        OpenAI subscription models use the official Codex app-server. A Routine does not make its AI
        employee unavailable: Members can keep chatting with that employee and start independent
        Routines in parallel, up to the company workload limit. Concurrent work shares this
        directory, so give overlapping Runs distinct output files and avoid simultaneous edits to
        the same git working tree. Model credentials stay encrypted in the database. They never
        enter the employee working directory. For an OpenAI subscription login or Run, Genosyn gives
        the official app-server a locked temporary <Code>CODEX_HOME</Code>. Managed ChatGPT sessions
        are materialized there; access tokens enter only the child process environment. Genosyn
        removes the directory afterward. Subscription auth is unavailable while coding tools use
        host mode, because a concurrent AI Employee&apos;s same-user shell could inspect that
        sibling process. Use working Linux bubblewrap mode. In that mode every AI Model turn uses
        sandboxed <Code>bash</Code> for file work, and repository synchronization stays inside the
        same namespace; Genosyn omits its host-process file helpers install-wide so concurrent turns
        cannot race them across the boundary.
      </P>

      <H3 id="org-chart">Org chart</H3>
      <P>
        Set <Code>reportsTo</Code> on an employee to give them a manager. Genosyn renders this as an
        org chart and surfaces it to the runner — useful when you want a <Strong>Handoff</Strong>{" "}
        from one employee to another to follow the reporting line.
      </P>

      <H2 id="surfaces">Surfaces inside the app</H2>
      <UL>
        <LI>
          <Strong>Chat.</Strong> Free-form conversations with the employee. Messages persist; action
          pills surface tool calls inline. Type <Code>/new</Code> to open a fresh context, or{" "}
          <Code>#</Code> and a name to tag any company resource you can see. Attach files with the
          paperclip, or paste a screenshot and drag files onto the composer. When the employee
          creates a file for you, it appears beneath their reply; select the attachment chip to
          download it. During substantial multi-step work, the employee can replace the typing dots
          with a live, labelled progress bar and update it at meaningful milestones. The fill keeps
          moving between milestone updates so you can distinguish active work from a stalled
          connection without inflating the reported percentage. As soon as the reply begins, the
          progress bar gives way to the response. Long turns can run for up to six hours. If the
          live connection drops, you reload the page, or the Genosyn server restarts, Genosyn
          follows the persisted turn automatically instead of marking it failed. After a server
          restart, a short renewable database lease lets one replacement worker resume the request
          safely from its saved context and latest milestone; it checks current state before
          continuing so completed side effects are not repeated. The final reply reappears in the
          same thread. You can keep writing while the employee works — follow-ups queue and send in
          order. Chat stays available while that employee&apos;s Routines run.
        </LI>
        <LI>
          <Strong>Workspace.</Strong> File editor scoped to the employee&apos;s directory — read
          what they wrote, edit it, drop in fixtures.
        </LI>
        <LI>
          <Strong>Soul.</Strong> The employee&apos;s constitution, under Settings. Markdown, ⌘S to
          save.
        </LI>
        <LI>
          <Strong>Skills / Routines.</Strong> Not employee tabs anymore — they live in the top-level
          AI → <DocLink to="/docs/skills">Skills</DocLink> and AI →{" "}
          <DocLink to="/docs/routines">Routines</DocLink> sections. Each sidebar link opens that
          list filtered to this employee.
        </LI>
        <LI>
          <Strong>Connections.</Strong> The list of{" "}
          <DocLink to="/docs/integrations">Grants</DocLink> this employee holds.
        </LI>
        <LI>
          <Strong>Journal.</Strong> Append-only diary the employee writes about their own work via
          the built-in MCP server.
        </LI>
      </UL>

      <Callout kind="info" title="Models are employee-owned, on purpose.">
        Each employee owns their own provider credentials, stored encrypted (AES-256-GCM) in the
        database — even when they register several models, every API key, endpoint credential, or
        OpenAI subscription credential belongs to that one employee. There&apos;s no shared
        company-wide model credential. Firing an employee deletes all of their encrypted credential
        rows; you don&apos;t have to rotate anything for the rest of the team.
      </Callout>
    </>
  );
}
