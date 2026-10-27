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
            Self-serve BI over the database integrations your company already connects and over
            your own <DocLink to="/docs/bases">Bases</DocLink>. Save a query as a{" "}
            <Strong>Chart</Strong>, pick a visualization, pin charts onto a{" "}
            <Strong>Dashboard</Strong> the team reads at a glance.
          </>
        }
      />

      <H2 id="what-it-is">What ships</H2>
      <UL>
        <LI>
          <Strong>Chart</Strong> — a saved SQL query against one database Connection, or a question
          about one table in a Base, plus a visualization choice (table, scalar, bar, line, area,
          pie).
        </LI>
        <LI>
          <Strong>Dashboard</Strong> — a grid of Charts and formula widgets, each with its own
          size and position. Formula widgets combine the numbers shown by other widgets.
        </LI>
        <LI>
          <Strong>Run</Strong> — every SQL execution (ad-hoc from the editor or from a saved Chart)
          goes through the same executor with a 30s wall-clock timeout and a 5,000-row cap. A Base
          Chart is answered from the Base&apos;s own rows under the same row cap.
        </LI>
        <LI>
          <Strong>Data browser</Strong> — the Chart editor reads the tables, views, columns, and
          data types visible to the selected Connection. Search it, expand a table, insert a quoted
          column name, or preview a table without writing the starter query yourself.
        </LI>
        <LI>
          <Strong>AI-native workflow</Strong> — grant an AI Employee a database Connection or a
          Base, then ask them to inspect it, check each query, save Charts, and assemble a
          Dashboard that appears in the same Explore UI Members use.
        </LI>
      </UL>

      <H2 id="what-you-need">What you need first</H2>
      <P>
        Explore reads from <DocLink to="/docs/integrations">Integrations</DocLink> — specifically
        Connections of provider <Code>postgres</Code>, <Code>mysql</Code>, or{" "}
        <Code>clickhouse</Code>. Set one up under <Code>Explore → Integrations</Code>, then it shows
        up in the Data source picker inside Explore. Bases need nothing connected: every Base in the
        company is already a data source. To delegate analytics, click{" "}
        <Code>Build with AI</Code>, choose a Connection or a Base and an AI Employee, and Genosyn
        can create the Connection or Base Grant before opening Chat.
      </P>
      <Callout kind="warn" title="Connect with a least-privileged role.">
        Read-only enforcement is <em>not</em> baked into the executor — if you give Explore a
        Connection that can <Code>UPDATE</Code> or <Code>DELETE</Code>, an AI Employee with a
        Connection Grant could too. Create a separate database user with <Code>SELECT</Code>-only
        privileges and connect with that.
      </Callout>

      <H2 id="build-with-ai">Building with an AI Employee</H2>
      <OL>
        <LI>
          Open <Code>Explore</Code> and click <Code>Build with AI</Code>.
        </LI>
        <LI>
          Under <Code>Data source</Code>, choose a connected database or a Base with at least one
          active table, then choose an AI Employee. If they do not already hold that
          Connection&apos;s or Base&apos;s Grant, the action is labelled{" "}
          <Code>Grant &amp; open chat</Code> and creates it before continuing. A Base Grant is the
          same one <Strong>Base settings → AI access</Strong> gives, so the employee can also read
          and edit that Base&apos;s records and fields.
        </LI>
        <LI>
          Review or edit the starter request. Chat opens with the request as a draft; no model runs
          and no data is queried until you send it.
        </LI>
        <LI>
          For a database, the employee lists its granted Explore Connections, inspects the selected
          schema, and validates each SQL query. For a Base, the request has it read the table and
          field ids with <Code>get_base</Code>, build each Chart&apos;s <Code>baseQuery</Code> from
          them for <Code>create_chart</Code>, and check the Chart with <Code>run_chart</Code>.
          Either way it saves reusable Charts, creates a Dashboard, and pins the Charts in a
          readable order. The results appear immediately in Explore and every write carries the AI
          employee in its audit trail.
        </LI>
      </OL>

      <H2 id="charts">Authoring a Chart</H2>
      <OL>
        <LI>
          Open <Code>Explore</Code> from the sidebar, click <Code>New chart</Code>.
        </LI>
        <LI>Pick the Connection that holds the data.</LI>
        <LI>
          Use the <Code>Data</Code> browser to search the Connection&apos;s visible tables and
          columns. Expand a table to inspect its data types. Click a column to insert its safely
          quoted name at the SQL cursor, or click the eye beside a table to build and immediately
          run a <Code>SELECT * … LIMIT 100</Code> preview.
        </LI>
        <LI>
          Write or refine the SQL, then click <Code>Run</Code>. <Code>Cmd/Ctrl + Enter</Code> runs
          from the editor; <Code>Cmd/Ctrl + S</Code> saves from anywhere on the page, the title and
          description included. Query errors and the elapsed time stay inline so you can iterate
          without leaving the page.
        </LI>
        <LI>
          After a successful Run, Explore may suggest a Number, Line, or Bar visualization from the
          result shape. Accept it in one click or choose any visualization yourself; nothing changes
          automatically behind your back.
        </LI>
        <LI>
          Configure the visualization (dimension column, measure column(s), stacking, prefix or
          suffix), then <Code>Save</Code>. Explore warns before a link takes you away from unsaved
          edits.
        </LI>
      </OL>

      <H2 id="bases">Charting a Base</H2>
      <P>
        Any table in a <DocLink to="/docs/bases">Base</DocLink> can feed a Chart without SQL. Click{" "}
        <Code>Chart</Code> at the top of a Base, pick the Base under <Code>Data source</Code> in the
        Chart editor, or start from its card under Data sources on the Explore page. The preview
        updates as you choose — there is no Run step.
      </P>
      <OL>
        <LI>
          Choose the <Code>Table</Code>, then <Code>Filter</Code> its rows with the same rules a
          Base view uses. The filters are saved with the Chart, not shared with a view.
        </LI>
        <LI>
          <Code>Summarize</Code> to count rows, or sum, average, min, or max a number field — up to
          five measures. <Code>Group by</Code> any field but long text: a date groups by day, week,
          month, quarter, or year; a multiple select or link puts a row in each of its values; blank
          cells form an <Code>(empty)</Code> group.
        </LI>
        <LI>
          Or <Code>List rows</Code> to show the matching rows as the grid shows them, sorted by any
          field. Sort groups by their own order or by size, and set a <Code>Limit</Code> for a top
          ten.
        </LI>
      </OL>
      <P>
        Base Charts pin to Dashboards, feed formulas, and supply Goals like any other Chart. A date
        typed in the grid is charted on the day it shows; a time stamped through the API is placed
        on the company&apos;s calendar.
      </P>

      <H3 id="viz-types">The six visualization types</H3>
      <KeyList
        rows={[
          {
            term: "table",
            def: "Raw rows. Good fallback when the data doesn't have an obvious shape — and useful as a sanity check before picking a richer viz.",
          },
          {
            term: "scalar",
            def: "A single big number. Reads the selected measure from the first row, or the first numeric column when no measure is selected. Use for KPIs: MRR, weekly signups, p99 latency.",
          },
          {
            term: "bar",
            def: "Categories along the bottom, measure up the side. With several measure columns the bars stand side by side, or stack into one column per category when stacking is on — positive values above zero, negative ones below.",
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
      <P>
        Bar, line, area, and pie charts redraw to fit the box they are in, from the editor&apos;s
        preview to the smallest dashboard card, and a chart with more than one measure shows a
        legend. Point at or tap a category, or focus the chart and use the arrow keys, to read every
        measure&apos;s value there; a stacked bar adds the column&apos;s total.
      </P>

      <H2 id="dashboards">Building a Dashboard</H2>
      <OL>
        <LI>
          From <Code>Explore</Code>, click <Code>New dashboard</Code>. Add a title and an optional
          description, then create it.
        </LI>
        <LI>
          Click <Code>Add chart</Code> and choose a saved Chart — no need to enter{" "}
          <Code>Edit</Code> first. Charts already on the Dashboard are marked and cannot be added
          twice. If none exists yet, jump straight to the Chart editor from the picker.
        </LI>
        <LI>
          In <Code>Edit</Code> mode, use the arrow controls to move a card and the named size menus
          to resize it. Edit the title in place when the Dashboard needs a shorter label than the
          saved Chart. Cards collapse into a readable single column on smaller screens.
        </LI>
        <LI>
          Hit <Code>Done</Code>. <Code>Refresh</Code> reloads every card, while the refresh button
          on an individual card reloads just that Chart — both use the same 30s / 5,000-row envelope
          as the editor.
        </LI>
      </OL>

      <H3 id="formula-widgets">Combining widgets with a formula</H3>
      <OL>
        <LI>
          Add the Charts you want to combine and choose the <Code>Number</Code> visualization for
          each. Open the Dashboard, click <Code>Edit</Code>, then <Code>Add formula</Code>.
        </LI>
        <LI>
          Give the widget a title. Choose a Number or formula widget from this Dashboard for each
          input, such as <Code>A</Code> and <Code>B</Code>.
        </LI>
        <LI>
          Write the formula, check its preview, and save. Use <Code>A + B</Code> or{" "}
          <Code>SUM(A, B)</Code> for a total, <Code>A - B</Code> for a difference, or{" "}
          <Code>(A / B) * 100</Code> for a percentage. Optional prefix and suffix fields can add a
          currency symbol or <Code>%</Code>.
        </LI>
      </OL>
      <P>
        Formulas support numbers, parentheses, <Code>+</Code>, <Code>-</Code>, <Code>*</Code>,{" "}
        <Code>/</Code>, and the functions <Code>SUM</Code>, <Code>AVG</Code>, <Code>MIN</Code>, and{" "}
        <Code>MAX</Code>. Each Number input uses the same first-row measure displayed on its card.
        Formula widgets can use other formula widgets as inputs. Source Charts may use different
        Connections as long as their cards are on the same Dashboard.
      </P>
      <P>
        Refreshing a source Chart recalculates formulas that use it. <Code>Refresh</Code> at the top
        reloads the Dashboard&apos;s Charts and updates all formulas. A formula card&apos;s own
        refresh button reloads the Charts behind its inputs, including inputs reached through
        other formulas. In <Code>Edit</Code> mode, use a formula card&apos;s edit control to change
        its inputs or expression. Missing or
        nonnumeric inputs, division by zero, and circular references show an inline error instead
        of a misleading number.
      </P>

      <H2 id="grants">Sharing with AI Employees</H2>
      <P>
        Explore has two grant boundaries. A <Strong>Connection Grant</Strong> lets an AI Employee
        inspect that database, run ad-hoc SQL, create a Chart against it, and change that
        Chart&apos;s SQL. A <Strong>Base Grant</Strong> does the same for Charts over that Base. A{" "}
        <Strong>Chart or Dashboard Grant</Strong> controls access to the saved Explore row. Charts
        and Dashboards default to <Code>read</Code> for every employee in the company; their AI
        author receives <Code>write</Code>. A Chart over an archived Base table never runs for an AI
        Employee.
      </P>
      <P>
        Open the <Code>Share</Code> menu on any Chart or Dashboard to change a teammate&apos;s
        level, revoke a grant, or invite an employee who didn&apos;t default to access. Manage a
        database Connection Grant from <Code>Build with AI</Code>, the Connection&apos;s{" "}
        <Code>Manage access</Code> view, or the employee&apos;s{" "}
        <Strong>Settings → Connections</Strong>. Give a Base Grant from <Code>Build with AI</Code>{" "}
        or <Strong>Base settings → AI access</Strong>, where it is also revoked.
      </P>

      <H3 id="mcp-tools">MCP tools</H3>
      <P>
        Every employee gets these via the built-in <Code>genosyn</Code> MCP server (subject to the
        grants above):
      </P>
      <UL>
        <LI>
          <Code>list_explore_connections</Code>, <Code>get_explore_schema</Code>, and{" "}
          <Code>run_explore_query</Code> — the discovery and validation loop over database
          Connections explicitly granted to that employee. Credentials are never returned.
        </LI>
        <LI>
          <Code>list_charts</Code>, <Code>get_chart</Code>, <Code>run_chart</Code> — read paths. The
          {" "}
          <Code>run_chart</Code> tool is the one most teams hit: a teammate asks &quot;what was MRR
          last month?&quot;, the employee finds the right Chart and runs it.
        </LI>
        <LI>
          <Code>create_chart</Code>, <Code>update_chart</Code>, <Code>delete_chart</Code> — write
          paths. Create requires a Grant on the bound Connection, or on the Base for a Chart that
          passes <Code>baseSlug</Code> and a <Code>baseQuery</Code> built from <Code>get_base</Code>.
          Changing SQL or a Base query requires that Grant and <Code>write</Code> on the Chart. Other edits and deletion require{" "}
          <Code>write</Code> on the Chart. A Chart a <DocLink to="/docs/goals">Goal</DocLink> reads
          refuses an AI Employee&apos;s SQL change and deletion outright — only a person can make
          them. Deleting it here turns that Goal into a manual Goal that keeps its last value.
        </LI>
        <LI>
          <Code>list_dashboards</Code>, <Code>get_dashboard</Code>, <Code>create_dashboard</Code>,
          {" "}
          <Code>add_dashboard_card</Code>, <Code>update_dashboard_card</Code> (move, resize,
          retitle), and <Code>remove_dashboard_card</Code> — dashboard authoring, with{" "}
          <Code>write</Code> on the Dashboard.
        </LI>
      </UL>
      <P>
        Formula widgets are currently managed by Members in the Dashboard UI. The AI dashboard
        tools omit formula cards and continue to work with Chart cards; adding a formula does not
        change access to its source Charts.
      </P>

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
        Viz: <Code>scalar</Code>. Pin to a dashboard alongside other finance KPIs.
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
        Viz: <Code>bar</Code> with dimension <Code>week</Code>, measure <Code>signups</Code>. Switch
        to <Code>line</Code> to see the trend without the buckets.
      </P>

      <H3 id="recipe-pie">Plan mix, pie</H3>
      <Pre lang="sql">{`SELECT plan, COUNT(*) AS customers
FROM subscriptions
WHERE status = 'active'
GROUP BY plan;`}</Pre>
      <P>
        Viz: <Code>pie</Code>, dimension <Code>plan</Code>, measure <Code>customers</Code>.
      </P>

      <H2 id="whats-next">What&apos;s deferred</H2>
      <P>These are on the roadmap but not in v1 — call them out in an issue if you need one:</P>
      <UL>
        <LI>
          <Strong>Parameters / filters</Strong> (date range, dropdown bound to a column).
        </LI>
        <LI>
          <Strong>Scheduled deliveries</Strong> — email a dashboard PNG at 9am.
        </LI>
        <LI>
          <Strong>Embedded views</Strong> — public read-only links, signed.
        </LI>
        <LI>
          <Strong>Snowflake / BigQuery / Redshift</Strong> connectors.
        </LI>
        <LI>
          <Strong>Native (no-SQL) query builder</Strong> over a database Connection — Bases already
          have one.
        </LI>
        <LI>
          <Strong>AI-suggested charts</Strong> on a freshly-added connection.
        </LI>
      </UL>
    </>
  );
}
