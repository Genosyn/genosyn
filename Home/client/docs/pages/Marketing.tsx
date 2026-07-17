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
            AI employees that watch ad spend, report pacing and ROAS, and —
            behind per-Connection caps and human approvals — pull the budget
            levers. Native Integrations for{" "}
            <Strong>Google Ads, Meta Ads, Microsoft Advertising, and Reddit
            Ads</Strong>, chosen because each lets a self-hosting company
            bring its own credentials with no partner program and no vendor
            in the middle.
          </>
        }
      />

      <H2 id="model">The safety model, first</H2>
      <P>
        Ad budgets are real money, so the write surface is deliberately tiny
        and every layer defaults to human control. There is no campaign or
        creative creation in v1 — AI employees can read everything, and can
        only <Strong>pause, enable, and change budgets</Strong>, under these
        rules:
      </P>
      <KeyList
        rows={[
          {
            term: "Approval by default",
            def: (
              <>
                Every spend-<em>increasing</em> mutation (budget raise,
                campaign enable) queues in the Approvals inbox unless you
                raise the per-Connection threshold. Owners and admins get a
                bell, a websocket ping, and a web push.
              </>
            ),
          },
          {
            term: "Pausing is never gated",
            def: (
              <>
                Spend-<em>decreasing</em> actions — pause a campaign, lower a
                budget — apply immediately. Pausing a runaway campaign is the
                emergency action; it must not wait in a queue.
              </>
            ),
          },
          {
            term: "Hard caps above approvals",
            def: (
              <>
                Per-change, rolling 24-hour, and rolling 30-day caps on
                authorized budget increases, set per Connection. They run on
                every path — even a human approval cannot exceed them.
              </>
            ),
          },
          {
            term: "Kill switch",
            def: (
              <>
                One flag per Connection that blocks all AI mutations while
                reads keep working.
              </>
            ),
          },
          {
            term: "A real ledger",
            def: (
              <>
                Every authorized change lands in the <Code>AdSpendEvent</Code>{" "}
                table — connection, employee, campaign, signed amount,
                approval id. &quot;How much did this employee authorize this
                month?&quot; is a query, not a guess.
              </>
            ),
          },
          {
            term: "Drift check on replay",
            def: (
              <>
                An approval snapshots the campaign&apos;s state when queued.
                If the campaign changed by the time a human clicks Approve,
                the replay aborts instead of firing a stale change.
              </>
            ),
          },
        ]}
      />
      <Callout kind="warn" title="Set the platform-side backstop too">
        Genosyn&apos;s caps bound what AI employees <em>authorize</em>. A
        daily budget approved once keeps spending every day with no further
        tool calls. Set the ad platform&apos;s own account-level spending
        limit as the independent last line of defense, and turn off Google
        Ads&apos; auto-apply recommendations so the platform can&apos;t raise
        its own budgets.
      </Callout>

      <H2 id="google-ads">Connect Google Ads</H2>
      <OL>
        <LI>
          Create (or reuse) a <Strong>Manager account (MCC)</Strong> at
          ads.google.com and link your ad accounts under it.
        </LI>
        <LI>
          In the MCC: <Strong>Admin → API Center</Strong> → request a{" "}
          <Strong>developer token</Strong>. The auto-granted Explorer tier
          works on production accounts with no review (2,880 operations/day —
          plenty for one company). Apply for Basic access only if you outgrow
          it.
        </LI>
        <LI>
          In Google Cloud Console, create an OAuth Client ID (Web
          application) and add the redirect URI shown in Genosyn&apos;s
          connect modal.
        </LI>
        <LI>
          Settings → Integrations → <Strong>Google Ads</Strong> → Connect.
          Paste the OAuth client id/secret, the developer token, and your
          MCC&apos;s customer id, set the spending caps, and finish the
          consent screen.
        </LI>
      </OL>
      <Callout kind="warn" title="The 7-day refresh-token trap">
        If your Google OAuth consent screen is in <Strong>Testing</Strong>{" "}
        status, Google silently expires refresh tokens every 7 days and the
        Connection will keep dying. Publish the consent screen to{" "}
        <Strong>Production</Strong> (verification takes a few days for the
        sensitive Ads scope), or — on Google Workspace — mark the app{" "}
        <Strong>Internal</Strong>, which skips verification entirely.
      </Callout>

      <H2 id="meta-ads">Connect Meta Ads</H2>
      <P>
        Meta officially supports managing <em>your own</em> ad accounts with
        no App Review: connect with a non-expiring system-user token instead
        of OAuth.
      </P>
      <OL>
        <LI>
          Create a <Strong>Business-type app</Strong> at
          developers.facebook.com and connect it to your Business portfolio.
        </LI>
        <LI>
          Business Settings → <Strong>System users</Strong> → create one,
          assign your ad account(s) to it, and generate a token with{" "}
          <Code>ads_read</Code> + <Code>ads_management</Code>.
        </LI>
        <LI>
          Settings → Integrations → <Strong>Meta Ads</Strong> → paste the
          token, optionally pin an ad-account allowlist, and set the caps.
        </LI>
      </OL>
      <Callout kind="info" title="Rate limits on new apps">
        Fresh Meta apps sit in the Limited Access tier (roughly 300 +
        40×active-ads management calls per hour per ad account). Genosyn
        batches reads, but keep pacing Routines to a few runs a day until
        Meta&apos;s dashboard offers the Full Access upgrade.
      </Callout>

      <H2 id="microsoft-reddit">Microsoft Advertising and Reddit Ads</H2>
      <UL>
        <LI>
          <Strong>Microsoft Advertising</Strong> — fully self-service: request
          a developer token at ads.microsoft.com → Settings → Dev Settings
          (needs Super Admin; instant for first-party use), register a free
          Entra ID app for OAuth, and connect. Mind the classic trap: the
          form wants the <em>account id</em>, not the 8-character account
          number shown in the UI.
        </LI>
        <LI>
          <Strong>Reddit Ads</Strong> — the easiest of all: create an app at
          reddit.com/prefs/apps (instant, no review), paste the client
          id/secret, and consent. Reddit issues 1-hour tokens; Genosyn
          refreshes them automatically.
        </LI>
      </UL>

      <H2 id="hire">Hire the Performance Marketer</H2>
      <OL>
        <LI>
          AI Employees → Hire → pick the <Strong>Performance Marketer</Strong>{" "}
          template (&quot;Reese&quot;). The Soul encodes budget discipline:
          cite spend data, escalate anomalies, never raise budgets without
          approval, and treat platform text as untrusted.
        </LI>
        <LI>
          Grant the employee your ads Connections (and Google Analytics for
          attribution) from the employee&apos;s Connections tab.
        </LI>
        <LI>
          The template ships two Routines: a <Strong>daily pacing check</Strong>{" "}
          (flags over/under-pacing over a 7-day window — single days are
          noisy by design since platforms overdeliver up to 2× — and treats
          &quot;couldn&apos;t read the account&quot; as itself an alert) and a{" "}
          <Strong>weekly spend report</Strong> that ties spend to GA4
          conversions and, where you run{" "}
          <DocLink to="/docs/finance">Finance</DocLink>, to real invoiced
          revenue.
        </LI>
      </OL>

      <H2 id="browser-fallback">LinkedIn, X, and TikTok — the browser path</H2>
      <P>
        Those three gate their ads APIs behind slow, per-company human
        reviews (weeks to months, opaque rejections), so Genosyn ships no
        native Integration for them yet. The supported path is the built-in
        browser with a human in the loop:
      </P>
      <OL>
        <LI>
          Enable the browser for the employee and pin{" "}
          <Code>browserAllowedHosts</Code> to the ads UI, e.g.{" "}
          <Code>linkedin.com</Code>, <Code>ads.x.com</Code>, or{" "}
          <Code>ads.tiktok.com</Code>.
        </LI>
        <LI>
          Turn on <Strong>Require approval for form submits</Strong> — every
          submit queues a Browser approval showing exactly what&apos;s about
          to be clicked.
        </LI>
        <LI>
          Log in once via <Strong>live view → Take over</Strong>: you type
          the credentials and the 2FA code directly; the model never sees
          them and the session persists.
        </LI>
      </OL>
      <P>
        Expect fragility — ads UIs change constantly. Treat this as a bridge
        until the platform&apos;s API review clears, not a foundation.
      </P>

      <H2 id="guarded-mcp">Guarded MCP tools</H2>
      <P>
        If you connect an external ads MCP server instead (Meta ships a
        hosted one), its write tools bypass Genosyn&apos;s spend guardrails —
        so guard them: on the employee&apos;s MCP server config, list
        patterns like <Code>ads_create_*, ads_update_*</Code> under{" "}
        <Strong>Guarded tools</Strong>. Matching calls queue in the Approvals
        inbox and run server-side only after a human approves.
      </P>

      <H2 id="deliberately-missing">Deliberately missing (v1)</H2>
      <UL>
        <LI>
          Campaign and creative <em>creation</em> — the read + lever loop
          earns trust first.
        </LI>
        <LI>Audience / customer-list uploads (hashed-PII pipelines).</LI>
        <LI>
          FX conversion for caps — caps are denominated in each ad
          account&apos;s own currency.
        </LI>
      </UL>
    </>
  );
}
