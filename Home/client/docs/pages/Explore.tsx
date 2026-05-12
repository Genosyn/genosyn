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

export function Explore() {
  return (
    <>
      <PageHeader
        eyebrow="Analytics"
        title="Explore"
        lead={
          <>
            Self-serve BI over the database integrations your company already
            connects. Save a SQL query as a <Strong>Chart</Strong>, pick a
            visualization, pin charts onto a <Strong>Dashboard</Strong> the
            team reads at a glance. Distinct from{" "}
            <DocLink to="/docs/vocabulary">Bases</DocLink> (the team writes
            into those) and from running queries inside an Integration tool
            by hand.
          </>
        }
      />

      <H2 id="what-it-is">What ships</H2>
      <UL>
        <LI>
          <Strong>Chart</Strong> — a saved SQL query against one database
          Connection plus a visualization choice (table, scalar, bar, line,
          area, pie).
        </LI>
        <LI>
          <Strong>Dashboard</Strong> — a grid of Charts, each one a{" "}
          <Code>DashboardCard</Code> with its own size and position.
        </LI>
        <LI>
          <Strong>Run</Strong> — every execution (ad-hoc from the editor or
          from a saved Chart) goes through the same executor with a 30s
          wall-clock timeout and a 5,000-row cap.
        </LI>
        <LI>
          <Strong>Grants</Strong> — give AI Employees{" "}
          <Code>read</Code> or <Code>write</Code> access to a specific Chart
          or Dashboard so they can author and run analytics alongside
          humans.
        </LI>
      </UL>

      <H2 id="what-you-need">What you need first</H2>
      <P>
        Explore reads from{" "}
        <DocLink to="/docs/integrations">Integrations</DocLink> — specifically
        Connections of provider <Code>postgres</Code>, <Code>mysql</Code>, or{" "}
        <Code>clickhouse</Code>. Set one up under{" "}
        <Code>Settings → Integrations</Code>, then it shows up in the
        Connection picker inside Explore.
      </P>
      <Callout kind="warn" title="Connect with a least-privileged role.">
        Read-only enforcement is <em>not</em> baked into the executor — if
        you give Explore a Connection that can <Code>UPDATE</Code> or{" "}
        <Code>DELETE</Code>, an AI Employee with <Code>write</Code> grant
        could too. Create a separate database user with{" "}
        <Code>SELECT</Code>-only privileges and connect with that.
      </Callout>

      <H2 id="charts">Authoring a Chart</H2>
      <OL>
        <LI>
          Open <Code>Explore</Code> from the sidebar, click{" "}
          <Code>New chart</Code>.
        </LI>
        <LI>
          Pick the Connection that holds the data.
        </LI>
        <LI>
          Write SQL in the editor. <Code>Run</Code> previews the result
          table. Errors come back inline so you can iterate without leaving
          the page.
        </LI>
        <LI>
          Pick a visualization. The picker shows a live preview of every
          viz type against your current result set — switch between them in
          one click until the shape fits.
        </LI>
        <LI>
          Configure the viz in the side panel (dimension column, measure
          column(s), bar orientation + stacking, pie slice column …).{" "}
          <Code>Save</Code>.
        </LI>
      </OL>

      <H3 id="viz-types">The six visualization types</H3>
      <KeyList
        rows={[
          {
            term: "table",
            def: "Raw rows. Good fallback when the data doesn't have an obvious shape — and useful as a sanity check before picking a richer viz.",
          },
          {
            term: "scalar",
            def: "A single big number. Reads the first cell of the first row. Use for KPIs: MRR, weekly signups, p99 latency.",
          },
          {
            term: "bar",
            def: "Categories on one axis, measure on the other. Configurable orientation (vertical / horizontal) and stacking when there are multiple measure columns.",
          },
          {
            term: "line",
            def: "Time on the x-axis, measure on the y-axis. Best for any series indexed by a date or timestamp.",
          },
          {
            term: "area",
            def: "Like line, but filled. Better for cumulative or volume-style series where you want the whole shape to feel weighty.",
          },
          {
            term: "pie",
            def: "Share of total across a single dimension. Don't reach for it when bar would do — pie is rarely the right call for more than four or five slices.",
          },
        ]}
      />

      <H2 id="dashboards">Building a Dashboard</H2>
      <OL>
        <LI>
          From <Code>Explore</Code>, click <Code>New dashboard</Code>. Title
          + description, save.
        </LI>
        <LI>
          Open the dashboard in <Code>Edit</Code> mode. Drag any Chart from
          the side panel onto the grid — drop it where you want it. Resize
          by dragging the bottom-right corner.
        </LI>
        <LI>
          Each <Code>DashboardCard</Code> can override the Chart&apos;s
          title for the context it&apos;s pinned in (you might call the
          same Chart &quot;MRR&quot; on the finance dashboard and &quot;Revenue
          (MTD)&quot; on the home dashboard).
        </LI>
        <LI>
          Hit <Code>Done editing</Code>. The view mode reloads each
          card&apos;s data — same 30s / 5,000-row envelope as the editor.
        </LI>
      </OL>

      <H2 id="grants">Sharing with AI Employees</H2>
      <P>
        Charts and Dashboards default to <Code>read</Code> for every employee
        in the company. Bump an employee up to <Code>write</Code> on a
        specific Chart and they can edit + delete it through the MCP tools
        below; bump them up on a Dashboard and they can add or move cards.
      </P>
      <P>
        Open the <Code>Share</Code> menu on any Chart or Dashboard to
        change a teammate&apos;s level, revoke a grant, or invite an
        employee who didn&apos;t default to access.
      </P>

      <H3 id="mcp-tools">MCP tools</H3>
      <P>
        Every employee gets these via the built-in <Code>genosyn</Code> MCP
        server (subject to the grants above):
      </P>
      <UL>
        <LI>
          <Code>list_charts</Code>, <Code>get_chart</Code>,{" "}
          <Code>run_chart</Code> — read paths. The <Code>run_chart</Code>{" "}
          tool is the one most teams hit: a teammate asks &quot;what was
          MRR last month?&quot;, the employee finds the right Chart and runs
          it.
        </LI>
        <LI>
          <Code>create_chart</Code>, <Code>update_chart</Code>,{" "}
          <Code>delete_chart</Code> — write paths. Require <Code>write</Code>{" "}
          on the row (create requires <Code>write</Code> on the parent
          Connection&apos;s Grant).
        </LI>
        <LI>
          <Code>list_dashboards</Code>, <Code>get_dashboard</Code>,{" "}
          <Code>create_dashboard</Code>, <Code>add_dashboard_card</Code> —
          dashboard authoring.
        </LI>
      </UL>

      <H2 id="limits">Limits</H2>
      <KeyList
        rows={[
          {
            term: "Query timeout",
            def: "30 seconds, wall-clock. Long-running analytical scans should hit a precomputed table, not the live OLTP db.",
          },
          {
            term: "Row cap",
            def: "5,000 rows per query. Larger result sets are truncated server-side. Aggregate before you return, or paginate via SQL OFFSET.",
          },
          {
            term: "Connectors",
            def: "Postgres, MySQL, ClickHouse. Snowflake / BigQuery / Redshift are on the roadmap.",
          },
          {
            term: "No parameters yet",
            def: "Charts run their SQL verbatim — no :start_date / :customer_id placeholders. Use a SQL view that joins against a date table if you need parameterization today.",
          },
        ]}
      />

      <H2 id="quick-recipes">Quick recipes</H2>

      <H3 id="recipe-mrr">Recurring revenue scalar</H3>
      <Pre lang="sql">{`SELECT
  ROUND(SUM(amount_cents) / 100.0, 0) AS mrr_usd
FROM subscriptions
WHERE status = 'active'
  AND interval = 'monthly';`}</Pre>
      <P>
        Viz: <Code>scalar</Code>. Pin to a dashboard alongside other
        finance KPIs.
      </P>

      <H3 id="recipe-signups">Weekly signups, bar</H3>
      <Pre lang="sql">{`SELECT
  date_trunc('week', created_at) AS week,
  COUNT(*) AS signups
FROM users
WHERE created_at >= NOW() - INTERVAL '12 weeks'
GROUP BY 1
ORDER BY 1;`}</Pre>
      <P>
        Viz: <Code>bar</Code> with dimension <Code>week</Code>, measure{" "}
        <Code>signups</Code>. Switch to <Code>line</Code> to see the
        trend without the buckets.
      </P>

      <H3 id="recipe-pie">Plan mix, pie</H3>
      <Pre lang="sql">{`SELECT plan, COUNT(*) AS customers
FROM subscriptions
WHERE status = 'active'
GROUP BY plan;`}</Pre>
      <P>
        Viz: <Code>pie</Code>, dimension <Code>plan</Code>, measure{" "}
        <Code>customers</Code>.
      </P>

      <H2 id="whats-next">What&apos;s deferred</H2>
      <P>
        These are on the roadmap but not in v1 — call them out in an issue
        if you need one:
      </P>
      <UL>
        <LI>
          <Strong>Parameters / filters</Strong> (date range, dropdown bound
          to a column).
        </LI>
        <LI>
          <Strong>Scheduled deliveries</Strong> — email a dashboard PNG at
          9am.
        </LI>
        <LI>
          <Strong>Embedded views</Strong> — public read-only links, signed.
        </LI>
        <LI>
          <Strong>Snowflake / BigQuery / Redshift</Strong> connectors.
        </LI>
        <LI>
          <Strong>Native (no-SQL) query builder</Strong> over a column
          picker — for teammates who don&apos;t write SQL.
        </LI>
        <LI>
          <Strong>AI-suggested charts</Strong> on a freshly-added connection.
        </LI>
      </UL>
    </>
  );
}
