import { Callout, Code, DocLink, H2, KeyList, PageHeader, Strong } from "@/docs/Prose";

export function Vocabulary() {
  return (
    <>
      <PageHeader
        eyebrow="Reference"
        title="Vocabulary"
        lead={
          <>
            Genosyn uses a deliberate vocabulary. These words show up in the UI, the API, and the
            database — using the right one keeps the mental model crisp.
          </>
        }
      />

      <Callout kind="info" title='Don&apos;t say "task."'>
        <Strong>Task</Strong> is reserved for the future human-style project and todo manager.
        Scheduled AI work is a <DocLink to="/docs/routines">Routine</DocLink>, never a task.
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
                <Code>AIEmployee.soulBody</Code>. See <DocLink to="/docs/soul">Soul</DocLink>.
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
                One execution of a Routine. The agent transcript is captured on{" "}
                <Code>Run.logContent</Code> (256 KB cap).
              </>
            ),
          },
          {
            term: "Trigger",
            def: (
              <>
                An event subscription that fires a Routine when a resource family changes — id-only
                frames, so an event routes work but never carries content. Never
                &quot;Subscription,&quot; &quot;Listener,&quot; or &quot;Hook&quot; — and a Revenue{" "}
                <DocLink to="/docs/signals">Signal</DocLink> stays a cron-evaluated query, never a
                Trigger. See <DocLink to="/docs/reactivity">Reactivity</DocLink>.
              </>
            ),
          },
          {
            term: "Wakeup",
            def: (
              <>
                A timed follow-up session an AI employee schedules for itself, with a note its
                future self reads — at most 20 pending, at most 90 days out. Never
                &quot;Reminder,&quot; &quot;Timer,&quot; or &quot;Snooze.&quot; See{" "}
                <DocLink to="/docs/reactivity">Reactivity</DocLink>.
              </>
            ),
          },
          {
            term: "Workstream",
            def: (
              <>
                A persistent state document for work spanning many Runs, maintained by the
                employee and opened into every Run brief of the Routine it binds. Never
                &quot;Thread&quot; or &quot;Epic&quot; — and &quot;Project&quot; stays reserved
                for the humans&apos; task manager. See{" "}
                <DocLink to="/docs/reactivity">Reactivity</DocLink>.
              </>
            ),
          },
          {
            term: "Initiative",
            def: (
              <>
                Standing work an AI employee proposes — evidence, case, and the exact Routine it
                wants — that exists only once a human accepts it. Never &quot;Suggestion&quot; or
                &quot;Idea&quot; — and &quot;Proposal&quot; belongs to Revision proposals. See{" "}
                <DocLink to="/docs/reactivity">Reactivity</DocLink>.
              </>
            ),
          },
          {
            term: "AI Model",
            def: (
              <>
                A brain an AI employee runs on — an Anthropic or OpenAI API connection, a custom
                OpenAI-compatible endpoint, or a trusted single-tenant OpenAI subscription
                connection through the official Codex app-server. An employee can hold several and
                keep one active. See <DocLink to="/docs/models">AI Models</DocLink>.
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
            def: "A gate that blocks an action until a human ✓. Kinds include routine, browser_action, mcp_tool, and ad_spend.",
          },
          {
            term: "Budget",
            def: (
              <>
                A monthly envelope over authorized ad-spend increases, scoped to the company, one
                Connection, or one AI Employee — every applicable envelope must have headroom, and
                the tightest binds. Enforced on every spend-increasing path, approval replays
                included; never blocks a spend decrease. See{" "}
                <DocLink to="/docs/policies#ad-spend-budgets">Company policies</DocLink>.
              </>
            ),
          },
          {
            term: "Check",
            def: (
              <>
                A machine-verifiable assertion a Run must pass before it finalizes green — a
                predicate over the effects the server recorded, or a command that must exit 0 in
                the sandbox. Written by an operator, evaluated by the server, and unreachable from
                every MCP tool. Never a &quot;test,&quot; an &quot;assertion,&quot; or a
                &quot;gate&quot; — System Health keeps &quot;probe&quot; for its own diagnostics.
                See <DocLink to="/docs/verification">What proves a Run worked</DocLink>.
              </>
            ),
          },
          {
            term: "Decision",
            def: (
              <>
                A question an AI employee stopped to ask, with the options it will act on. The
                employee raises it and a Member answers; unlike an Approval, nothing is executed on
                your behalf. See <DocLink to="/docs/decisions">Decision stack</DocLink>.
              </>
            ),
          },
          {
            term: "Goal",
            def: (
              <>
                A measurable objective — target value, direction, optional deadline, optional owning
                AI Employee — cascading company → employee. Humans set Goals; employees read them in
                every prompt and report progress. Never &quot;OKR,&quot; &quot;KPI,&quot; or
                &quot;Target.&quot; See <DocLink to="/docs/goals">Goals</DocLink>.
              </>
            ),
          },
          {
            term: "Lesson",
            def: (
              <>
                What a failed, timed-out, <Code>off goal</Code>, or Check-failing Run teaches the
                next one: a cause and an advice, written by a restricted retrospective turn,
                opening the
                Routine&apos;s future Run briefs until dismissed. Never &quot;Learning,&quot;
                &quot;Insight,&quot; or &quot;Retro.&quot; See{" "}
                <DocLink to="/docs/improvement">The improvement loop</DocLink>.
              </>
            ),
          },
          {
            term: "Policy",
            def: (
              <>
                A company-wide rule binding every AI Employee at once: prose injected above every
                Soul, blocked recipient domains refused at the mail-send choke point, and forbidden
                tools refused at dispatch — each refusal a <Code>policy.violation</Code> audit
                event. See <DocLink to="/docs/policies">Company policies</DocLink>.
              </>
            ),
          },
          {
            term: "Revision proposal",
            def: (
              <>
                A complete replacement body an AI Employee stages for its own Soul, a Skill, or a
                Routine&apos;s brief or acceptance criteria, with a rationale and evidence Runs.
                Nothing changes until an owner/admin applies it from the Revisions page. See{" "}
                <DocLink to="/docs/improvement">The improvement loop</DocLink>.
              </>
            ),
          },
          {
            term: "Standdown",
            def: (
              <>
                A revocable stop on all AI work at company, employee, or Routine scope, placed by
                an admin or by the consecutive-failure breaker. The exact inverse of a Waiver —
                imposed rather than earned, broad rather than narrow — and distinct from{" "}
                <Code>Routine.enabled</Code>, which stays the ordinary switch. Never
                &quot;pause,&quot; &quot;hold,&quot; &quot;suspend,&quot; or &quot;freeze.&quot;
                See <DocLink to="/docs/standdowns">Standdowns</DocLink>.
              </>
            ),
          },
          {
            term: "Waiver",
            def: (
              <>
                One approval gate switched off for an AI Employee that earned it — browser submits
                for the employee, or gated ticks for one Routine. Proposed by the eligibility sweep
                through the Approvals inbox; revoked automatically by any Run that failed, timed
                out, graded off goal, or failed a required Check. Never &quot;trust score,&quot; &quot;tier,&quot; or &quot;level.&quot;
                See <DocLink to="/docs/autonomy">Earned autonomy</DocLink>.
              </>
            ),
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
