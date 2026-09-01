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

export function Marketing() {
  return (
    <>
      <PageHeader
        eyebrow="Marketing"
        title="Paid Marketing"
        lead={
          <>
            A complete AI-run ad agency: Campaign strategy, Creative review, Experiments,
            performance history, and autonomous Routines — with per-Connection caps and human
            approvals still guarding real platform spend. Native Integrations for{" "}
            <Strong>Google Ads, Meta Ads, Microsoft Advertising, and Reddit Ads</Strong>.
          </>
        }
      />

      <H2 id="workspace">Run the agency from Marketing</H2>
      <OL>
        <LI>
          Open <Strong>Marketing → Campaigns → New Campaign</Strong>. Write the audience, offer,
          operating brief and target; choose the channel, daily budget, autonomy mode, owning AI
          Employee and — once it exists — the ad Connection and platform ids. Pick a{" "}
          <Strong>success metric Genosyn can measure</Strong> (see below) so the Campaign is scored
          against its target rather than merely labelled with one. Everything stays editable
          afterwards from the Campaign page.
        </LI>
        <LI>
          Build testable variants under <Strong>Marketing → Creative</Strong>. Creative moves
          through draft, review, approval, active, and retired states. Assets stay in a
          company-controlled Resource or URL instead of being copied into the database.
        </LI>
        <LI>
          Under <Strong>Marketing → Experiments</Strong>, compare at least two Creative variants.
          State the hypothesis, primary metric, and minimum sample before starting. A test cannot
          be decided without a winner from its tested set and a written rationale. Leave{" "}
          <Strong>Apply it</Strong> ticked and the decision is carried out rather than just filed:
          the winner goes live — or waits at approved when the Campaign is not running — and the
          variants that were serving against it retire.
        </LI>
        <LI>
          Under <Strong>Marketing → AI access</Strong>, grant the Performance Marketer{" "}
          <Code>operate</Code>. Grant each ad account separately from the employee&apos;s{" "}
          <Strong>Settings → Connections</Strong>; the two grants are deliberately independent.
        </LI>
        <LI>
          Create or publish the platform Campaign through the granted native Connection, a guarded
          external MCP server, or the approval-gated browser, then store its external Campaign id.
          Genosyn refuses to mark an unlinked Campaign active.
        </LI>
      </OL>
      <KeyList
        rows={[
          {
            term: "Observe",
            def: <>The employee reads the workspace and live platform, records evidence, and reports.</>,
          },
          {
            term: "Optimize",
            def: (
              <>
                The employee may take safe actions and queue guarded changes, always inside the
                Connection&apos;s controls.
              </>
            ),
          },
          {
            term: "Autonomous",
            def: (
              <>
                The owning AI Employee runs the full observe → decide → act → learn loop unattended.
                This never disables caps, kill switches, or Approvals.
              </>
            ),
          },
        ]}
      />

      <H2 id="scoring">Targets that are actually checked</H2>
      <P>
        A Campaign&apos;s target is only useful if something compares it to the result. Pick a
        success metric from the measurable set — <Code>conversions</Code>, <Code>cpa</Code>,{" "}
        <Code>roas</Code>, <Code>conversion_value</Code>, <Code>conversion_rate</Code>,{" "}
        <Code>ctr</Code>, <Code>cpc</Code>, <Code>cpm</Code>, <Code>clicks</Code>,{" "}
        <Code>impressions</Code>, <Code>spend</Code> — and Genosyn scores every recorded readout
        against it. Write the target in the metric&apos;s own unit: whole currency for money
        metrics (a CPA target of <Code>75</Code> means 75.00), a percentage for rate metrics, a
        plain multiple for ROAS. The direction defaults to the sensible one — costs are met at or
        below, returns at or above — and you can override it.
      </P>
      <P>
        You can still name any metric you like; Genosyn stores it and says plainly that it cannot
        judge it, rather than showing a target nobody checks. The command center, the Campaign
        list, the Campaign page, and the AI Employee tools all read the same computed numbers:
        spend, CTR, CPC, CPA, ROAS, pace against the planned daily budget, and target attainment.
      </P>
      <Callout kind="info" title="What lands on the command center">
        Marketing leads with <Strong>Needs attention</Strong>: Campaigns off target, spending ahead
        of plan, underdelivering, running with no recorded performance, running on a stale readout,
        active with no live Creative, Creative waiting for review, and Experiments running past two
        weeks with no decision. An empty list is the real signal that nothing needs you.
      </Callout>

      <H2 id="performance">Performance that survives the next run</H2>
      <P>
        Every platform read appends a Campaign performance snapshot: exact period, settled spend,
        impressions, clicks, conversions, conversion value, currency, and source.{" "}
        <Code>spendMinor</Code> is in minor units; <Code>conversionValue</Code> is a decimal in
        whole currency. The next Routine inherits the evidence instead of reconstructing it from a
        previous chat. This is separate from <Code>AdSpendEvent</Code>, which records authorized
        budget changes rather than settled spend.
      </P>
      <P>
        Readouts are append-only, and two rules keep the totals honest. Recording a period that
        already has a readout <Strong>restates</Strong> it: the old row is kept as history, marked
        superseded, and stops counting — so a Routine that retries after a crash cannot double the
        month&apos;s spend, and a platform that settles its numbers late can correct them. A period
        that <em>partly</em> overlaps an existing readout is <Strong>refused</Strong>, because
        adding a daily readout to the weekly one containing it counts the same money twice. Record
        the same window every time; the Campaign page shows restated rows struck through.
      </P>

      <H2 id="lifecycle">Lifecycle</H2>
      <P>
        States move in one direction and the workspace enforces it, so an <Code>operate</Code> grant
        cannot take a half-written draft straight to live:
      </P>
      <UL>
        <LI>
          <Strong>Campaign</Strong> — draft → ready → active ⇄ paused → completed, archived from
          anywhere. Ready validates the brief; active additionally refuses an unlinked platform
          Campaign, and autonomous refuses an unowned one.
        </LI>
        <LI>
          <Strong>Creative</Strong> — draft → review → approved or rejected; approved → active;
          active → retired; rejected and retired reopen as drafts. Creative can only go live under
          a Campaign that is itself active.
        </LI>
        <LI>
          <Strong>Experiment</Strong> — draft → running → decided or stopped. Decided and stopped
          are final, and starting or ending one stamps its own clock.
        </LI>
      </UL>

      <H2 id="model">The safety model, first</H2>
      <P>
        Ad budgets are real money, so the write surface is deliberately tiny and every layer
        defaults to human control. Genosyn&apos;s native ad-platform mutation surface remains{" "}
        <Strong>pause, enable, and change budget</Strong>. Broader publishing uses a guarded MCP
        server or approval-gated browser under the same human-visible operating flow:
      </P>
      <KeyList
        rows={[
          {
            term: "Approval by default",
            def: (
              <>
                Every spend-<em>increasing</em> mutation (budget raise, campaign enable) queues in
                the Approvals inbox unless you raise the per-Connection threshold. Owners and admins
                get a bell, a websocket ping, and a web push.
              </>
            ),
          },
          {
            term: "Pausing is never gated",
            def: (
              <>
                Spend-<em>decreasing</em> actions — pause a campaign, lower a budget — apply
                immediately. Pausing a runaway campaign is the emergency action; it must not wait in
                a queue.
              </>
            ),
          },
          {
            term: "Hard caps above approvals",
            def: (
              <>
                Per-change, rolling 24-hour, and rolling 30-day caps on authorized budget increases,
                set per Connection. They run on every path — even a human approval cannot exceed
                them.
              </>
            ),
          },
          {
            term: "Kill switch",
            def: (
              <>One flag per Connection that blocks all AI mutations while reads keep working.</>
            ),
          },
          {
            term: "A real ledger",
            def: (
              <>
                Every authorized change lands in the <Code>AdSpendEvent</Code> table — connection,
                employee, campaign, signed amount, approval id. &quot;How much did this employee
                authorize this month?&quot; is a query, not a guess.
              </>
            ),
          },
          {
            term: "Drift check on replay",
            def: (
              <>
                An approval snapshots the campaign&apos;s state when queued. If the campaign changed
                by the time a human clicks Approve, the replay aborts instead of firing a stale
                change.
              </>
            ),
          },
        ]}
      />
      <Callout kind="warn" title="Set the platform-side backstop too">
        Genosyn&apos;s caps bound what AI Employees <em>authorize</em>. A daily budget approved once
        keeps spending every day with no further tool calls. Set the ad platform&apos;s own
        account-level spending limit as the independent last line of defense, and turn off Google
        Ads&apos; auto-apply recommendations so the platform can&apos;t raise its own budgets.
      </Callout>

      <H2 id="google-ads">Connect Google Ads</H2>
      <OL>
        <LI>
          Create (or reuse) a <Strong>Manager account (MCC)</Strong> at ads.google.com and link your
          ad accounts under it.
        </LI>
        <LI>
          In the MCC: <Strong>Admin → API Center</Strong> → request a{" "}
          <Strong>developer token</Strong>. The auto-granted Explorer tier works on production
          accounts with no review (2,880 operations/day — plenty for one company). Apply for Basic
          access only if you outgrow it.
        </LI>
        <LI>
          In Google Cloud Console, create an OAuth Client ID (Web application) and add the redirect
          URI shown in Genosyn&apos;s connect modal.
        </LI>
        <LI>
          Marketing → Connections → <Strong>Google Ads</Strong> → Connect. Paste the OAuth client
          id/secret, the developer token, and your MCC&apos;s customer id, set the spending caps,
          and finish the consent screen.
        </LI>
      </OL>
      <Callout kind="warn" title="The 7-day refresh-token trap">
        If your Google OAuth consent screen is in <Strong>Testing</Strong> status, Google silently
        expires refresh tokens every 7 days and the Connection will keep dying. Publish the consent
        screen to <Strong>Production</Strong> (verification takes a few days for the sensitive Ads
        scope), or — on Google Workspace — mark the app <Strong>Internal</Strong>, which skips
        verification entirely.
      </Callout>

      <H2 id="meta-ads">Connect Meta Ads</H2>
      <P>
        Meta officially supports managing <em>your own</em> ad accounts with no App Review: connect
        with a non-expiring system-user token instead of OAuth.
      </P>
      <OL>
        <LI>
          Create a <Strong>Business-type app</Strong> at developers.facebook.com and connect it to
          your Business portfolio.
        </LI>
        <LI>
          Business Settings → <Strong>System users</Strong> → create one, assign your ad account(s)
          to it, and generate a token with <Code>ads_read</Code> + <Code>ads_management</Code>.
        </LI>
        <LI>
          Marketing → Connections → <Strong>Meta Ads</Strong> → paste the token, optionally pin an
          ad-account allowlist, and set the caps.
        </LI>
      </OL>
      <Callout kind="info" title="Rate limits on new apps">
        Fresh Meta apps sit in the Limited Access tier (roughly 300 + 40×active-ads management calls
        per hour per ad account). Genosyn batches reads, but keep pacing Routines to a few runs a
        day until Meta&apos;s dashboard offers the Full Access upgrade.
      </Callout>

      <H2 id="microsoft-reddit">Microsoft Advertising and Reddit Ads</H2>
      <UL>
        <LI>
          <Strong>Microsoft Advertising</Strong> — fully self-service: request a developer token at
          ads.microsoft.com → Settings → Dev Settings (needs Super Admin; instant for first-party
          use), register a free Entra ID app for OAuth, and connect. Mind the classic trap: the form
          wants the <em>account id</em>, not the 8-character account number shown in the UI.
        </LI>
        <LI>
          <Strong>Reddit Ads</Strong> — the easiest of all: create an app at reddit.com/prefs/apps
          (instant, no review), paste the client id/secret, and consent. Reddit issues 1-hour
          tokens; Genosyn refreshes them automatically.
        </LI>
      </UL>

      <H2 id="hire">Hire the Performance Marketer</H2>
      <OL>
        <LI>
          AI Employees → Hire → pick the <Strong>Performance Marketer</Strong> template
          (&quot;Reese&quot;). The Soul encodes budget discipline: cite spend data, escalate
          anomalies, never raise budgets without approval, and treat platform text as untrusted.
        </LI>
        <LI>
          Grant the employee your ads Connections (and Google Analytics for attribution) from the
          employee&apos;s <Strong>Settings → Connections</Strong>.
        </LI>
        <LI>
          The template ships three Routines: a <Strong>daily pacing check</Strong> (flags
          over/under-pacing over a 7-day window — single days are noisy by design since platforms
          overdeliver up to 2× — and treats &quot;couldn&apos;t read the account&quot; as itself an
          alert), a <Strong>daily Campaign optimization</Strong> that runs the workspace policy and
          records performance, and a <Strong>weekly spend report</Strong> that ties spend to GA4
          conversions and, where you run <DocLink to="/docs/finance">Finance</DocLink>, to real
          invoiced revenue.
        </LI>
      </OL>

      <H2 id="browser-fallback">LinkedIn, X, and TikTok — the browser path</H2>
      <P>
        Those three gate their ads APIs behind slow, per-company human reviews (weeks to months,
        opaque rejections), so Genosyn ships no native Integration for them yet. The supported path
        is the <DocLink to="/docs/browser">built-in browser</DocLink> with a human in the loop:
      </P>
      <OL>
        <LI>
          Enable the browser for the employee and pin <Code>browserAllowedHosts</Code> to the ads
          UI, e.g. <Code>*.linkedin.com</Code>, <Code>ads.x.com</Code>, or{" "}
          <Code>ads.tiktok.com</Code> (use the <Code>*.</Code> form to allow subdomains; a bare host
          matches exactly).
        </LI>
        <LI>
          Turn on <Strong>Require approval for form submits</Strong> — every submit queues a Browser
          approval showing exactly what&apos;s about to be clicked.
        </LI>
        <LI>
          Log in once via <Strong>live view → Take over</Strong>: you type the credentials and the
          2FA code directly; the model never sees them and the session persists.
        </LI>
      </OL>
      <P>
        Expect fragility — ads UIs change constantly. Treat this as a bridge until the
        platform&apos;s API review clears, not a foundation.
      </P>

      <H2 id="guarded-mcp">Guarded MCP tools</H2>
      <P>
        If you connect an external ads MCP server instead (Meta ships a hosted one), its write tools
        bypass Genosyn&apos;s spend guardrails — so guard them: at the employee&apos;s{" "}
        <Strong>Settings → MCP</Strong>, open that server&apos;s config and list patterns like{" "}
        <Code>ads_create_*, ads_update_*</Code> under{" "}
        <Strong>Guarded tools</Strong>. Matching calls queue in the Approvals inbox and run
        server-side only after a human approves.
      </P>

      <H2 id="deliberately-missing">Deliberate boundaries</H2>
      <UL>
        <LI>
          Native provider tools do not attempt to normalize each platform&apos;s sprawling
          Campaign/Creative creation API. Use the workspace as the source of strategy and the
          granted guarded MCP/browser path for platform publishing.
        </LI>
        <LI>Audience / customer-list uploads (hashed-PII pipelines).</LI>
        <LI>
          FX conversion for caps — caps are denominated in each ad account&apos;s own currency.
        </LI>
      </UL>
    </>
  );
}
