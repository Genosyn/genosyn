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
            An AI Employee is a persistent persona attached to a company. They
            have a name, a role, a model, a sandboxed working directory, and
            three editable pieces of prose that define who they are and how
            they work.
          </>
        }
      />

      <H2 id="anatomy">Anatomy</H2>
      <P>
        Every AI Employee row carries the fields you can configure from the UI
        plus a few the runner needs at spawn time:
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
                Markdown stored on the row. The employee&apos;s constitution —
                see <DocLink to="/docs/soul">Soul</DocLink>.
              </>
            ),
          },
          {
            term: "skills[]",
            def: (
              <>
                One-to-many <Code>Skill</Code> rows. See{" "}
                <DocLink to="/docs/skills">Skills</DocLink>.
              </>
            ),
          },
          {
            term: "routines[]",
            def: (
              <>
                One-to-many <Code>Routine</Code> rows, managed from the
                top-level AI → Routines section. See{" "}
                <DocLink to="/docs/routines">Routines</DocLink>.
              </>
            ),
          },
          {
            term: "model",
            def: (
              <>
                One or more <Code>AIModel</Code> brains, one active at a time.
                See <DocLink to="/docs/models">AI Models</DocLink>.
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
                Flips on the built-in <Code>browser</Code> MCP server that
                drives a headless Chromium. Off by default. See{" "}
                <DocLink to="/docs/browser">Browser</DocLink>.
              </>
            ),
          },
          {
            term: "browserAllowedHosts",
            def: (
              <>
                Newline-separated host patterns limiting where the browser may
                navigate — <Code>github.com</Code> covers the domain and its
                subdomains. Blank means unrestricted.
              </>
            ),
          },
          {
            term: "browserApprovalRequired",
            def: (
              <>
                When on, form submits queue an Approval a human must grant
                before the browser fires them. See{" "}
                <DocLink to="/docs/browser">Browser</DocLink>.
              </>
            ),
          },
        ]}
      />

      <H2 id="lifecycle">Lifecycle</H2>
      <OL>
        <LI>
          <Strong>Create.</Strong> Pick a template (a starter Soul + Skill set)
          or start blank. The slug freezes; you can rename freely afterward.
        </LI>
        <LI>
          <Strong>Write the Soul.</Strong> The app drops you into the Soul
          editor with a seeded constitution. Rewrite it to fit your team.
        </LI>
        <LI>
          <Strong>Attach a model.</Strong> Pick a provider, add an API key or
          custom endpoint, and the runner takes over from there.
        </LI>
        <LI>
          <Strong>Add skills + routines.</Strong> Skills describe what they
          know; Routines describe when they work.
        </LI>
        <LI>
          <Strong>Fire.</Strong> Deleting an employee removes their DB rows,
          including the encrypted credential row for every model they held.
          There&apos;s no shared key to revoke.
        </LI>
      </OL>

      <H2 id="working-directory">Working directory</H2>
      <P>
        Each employee gets their own folder on disk under the company:
      </P>
      <pre className="mt-4 overflow-x-auto rounded-xl border border-zinc-200 bg-zinc-50 px-5 py-4 font-mono text-[12.5px] leading-[1.7] text-zinc-700">
        {`data/companies/<co-slug>/employees/<emp-slug>/
└── ...   # files the employee's coding tools read and write`}
      </pre>
      <P>
        The runner starts an in-process agent loop with this directory as{" "}
        <Code>cwd</Code> for the built-in coding tools (<Code>bash</Code>,{" "}
        <Code>read_file</Code>, <Code>write_file</Code>, <Code>edit_file</Code>,{" "}
        <Code>glob</Code>, <Code>grep</Code>), and captures the agent transcript
        into a Run log. Two employees can run different models in parallel; their
        provider credentials are stored encrypted in the database, never on disk.
      </P>

      <H3 id="org-chart">Org chart</H3>
      <P>
        Set <Code>reportsTo</Code> on an employee to give them a manager. Genosyn
        renders this as an org chart and surfaces it to the runner — useful when
        you want a <Strong>Handoff</Strong> from one employee to another to
        follow the reporting line.
      </P>

      <H2 id="surfaces">Surfaces inside the app</H2>
      <UL>
        <LI>
          <Strong>Chat.</Strong> Free-form conversations with the employee.
          Messages persist; action pills surface tool calls inline.
        </LI>
        <LI>
          <Strong>Workspace.</Strong> File editor scoped to the employee&apos;s
          directory — read what they wrote, edit it, drop in fixtures.
        </LI>
        <LI>
          <Strong>Soul.</Strong> The employee&apos;s constitution, under
          Settings. Markdown, ⌘S to save.
        </LI>
        <LI>
          <Strong>Skills / Routines.</Strong> Not employee tabs anymore — they
          live in the top-level AI →{" "}
          <DocLink to="/docs/skills">Skills</DocLink> and AI →{" "}
          <DocLink to="/docs/routines">Routines</DocLink> sections. Each
          sidebar link opens that list filtered to this employee.
        </LI>
        <LI>
          <Strong>Connections.</Strong> The list of{" "}
          <DocLink to="/docs/integrations">Grants</DocLink> this employee
          holds.
        </LI>
        <LI>
          <Strong>Journal.</Strong> Append-only diary the employee writes about
          their own work via the built-in MCP server.
        </LI>
      </UL>

      <Callout kind="info" title="Models are employee-owned, on purpose.">
        Each employee owns their own provider credentials, stored encrypted
        (AES-256-GCM) in the database — even when they register several models,
        every key belongs to that one employee. There&apos;s no shared
        company-wide API key. Firing an employee deletes all of their encrypted
        credential rows; you don&apos;t have to rotate anything for the rest of
        the team.
      </Callout>
    </>
  );
}
