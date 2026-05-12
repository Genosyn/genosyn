import {
  Callout,
  Code,
  DocLink,
  H2,
  KeyList,
  PageHeader,
  Strong,
} from "@/docs/Prose";

export function Vocabulary() {
  return (
    <>
      <PageHeader
        eyebrow="Reference"
        title="Vocabulary"
        lead={
          <>
            Genosyn uses a deliberate vocabulary. These words show up in the
            UI, the API, and the database — using the right one keeps the
            mental model crisp.
          </>
        }
      />

      <Callout kind="info" title="Don't say &quot;task.&quot;">
        <Strong>Task</Strong> is reserved for the future human-style project
        and todo manager. Scheduled AI work is a{" "}
        <DocLink to="/docs/routines">Routine</DocLink>, never a task.
      </Callout>

      <H2 id="company-and-team">Company & team</H2>
      <KeyList
        rows={[
          {
            term: "Company",
            def: "A tenant. The unit that owns AI Employees, Connections, Channels, Notes, Bases, and so on. One Genosyn install can host many.",
          },
          {
            term: "Member",
            def: "A human user inside a company. Roles: owner, admin, member. Don't say 'User' in product copy — that's reserved for the DB entity name.",
          },
          {
            term: "Team",
            def: "A subgroup of members for routing and notifications.",
          },
        ]}
      />

      <H2 id="ai-substrate">AI substrate</H2>
      <KeyList
        rows={[
          {
            term: "AI Employee",
            def: (
              <>
                A persistent AI persona attached to a company. See{" "}
                <DocLink to="/docs/employees">AI Employees</DocLink>.
              </>
            ),
          },
          {
            term: "Soul",
            def: (
              <>
                The employee&apos;s written constitution. Markdown on{" "}
                <Code>AIEmployee.soulBody</Code>. See{" "}
                <DocLink to="/docs/soul">Soul</DocLink>.
              </>
            ),
          },
          {
            term: "Skill",
            def: (
              <>
                A reusable playbook. Markdown on <Code>Skill.body</Code>. See{" "}
                <DocLink to="/docs/skills">Skills</DocLink>.
              </>
            ),
          },
          {
            term: "Routine",
            def: (
              <>
                A scheduled, recurring piece of work. Cron-triggered. See{" "}
                <DocLink to="/docs/routines">Routines</DocLink>.
              </>
            ),
          },
          {
            term: "Run",
            def: (
              <>
                One execution of a Routine. Stdout + stderr captured on{" "}
                <Code>Run.logContent</Code> (256 KB cap).
              </>
            ),
          },
          {
            term: "AI Model",
            def: (
              <>
                The brain of one AI employee. One-to-one. See{" "}
                <DocLink to="/docs/models">AI Models</DocLink>.
              </>
            ),
          },
          {
            term: "Handoff",
            def: "A formal AI→AI delegation with a status workflow — open, accepted, completed, cancelled.",
          },
        ]}
      />

      <H2 id="integration-words">Integration words</H2>
      <KeyList
        rows={[
          {
            term: "Integration",
            def: "A connector type. Static catalog defined in code under server/integrations/providers/.",
          },
          {
            term: "Connection",
            def: "One authenticated account inside an Integration. DB row, per-company.",
          },
          {
            term: "Grant",
            def: "An AI employee's access to a specific Connection.",
          },
          {
            term: "MCP server",
            def: "A Model Context Protocol server. Genosyn ships two built-ins (genosyn, browser) and any number of user-registered ones via the McpServer entity.",
          },
        ]}
      />

      <H2 id="workspace-surfaces">Workspace surfaces</H2>
      <KeyList
        rows={[
          {
            term: "Channel / DM",
            def: "Slack-style workspace chat between humans and AI. WebSocket-backed, mentions auto-invite the employee.",
          },
          {
            term: "Notebook / Note",
            def: "Notion-style company-wide markdown knowledge base. Tree-structured, soft-deletable.",
          },
          {
            term: "Base",
            def: "Airtable-style multi-table workspace with views, comments, attachments.",
          },
          {
            term: "Pipeline",
            def: "DAG of typed nodes for deterministic glue. Distinct from a Routine — Routines are AI-driven, Pipelines are wire-driven.",
          },
          {
            term: "Project / Todo",
            def: "Tasks (the human kind). Projects hold Todos; Todos have comments. Distinct from Routines.",
          },
          {
            term: "Resource",
            def: "External material an employee studies — articles, ebooks, transcripts. Distinct from Notes (team-authored) and Memory (atomic facts).",
          },
          {
            term: "Chart / Dashboard",
            def: "Explore — Metabase-style BI over database integrations. Save SQL as a Chart, pin Charts onto a Dashboard.",
          },
        ]}
      />

      <H2 id="control-surfaces">Control surfaces</H2>
      <KeyList
        rows={[
          {
            term: "Approval",
            def: "A gate that blocks an action until a human ✓. Kinds include routine and lightning_payment.",
          },
          {
            term: "Audit event",
            def: "Append-only log of every consequential action. Used for after-the-fact review and the activity feed.",
          },
          {
            term: "Journal",
            def: "Append-only diary an employee writes about their own work. AI-only writes; humans read.",
          },
          {
            term: "Notification",
            def: "An item in the inbox — mention, approval needed, run failed, etc.",
          },
        ]}
      />
    </>
  );
}
