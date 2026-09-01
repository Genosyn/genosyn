import { Callout, Code, DocLink, H2, KeyList, LI, P, PageHeader, Strong, UL } from "@/docs/Prose";

export function Policies() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Company policies"
        lead={
          <>
            The company&apos;s standing rails. A <Strong>Policy</Strong> is a rule that binds every
            employee at once — written into every prompt, and where it names something mechanical,
            enforced by the platform whether or not the model remembers it. This page also covers
            the other two rails that work the same way: monthly ad-spend <Strong>Budgets</Strong>,
            and the taint policy that holds risky calls after an employee reads the open web.
          </>
        }
      />

      <H2 id="what-a-policy-is">What a policy is</H2>
      <P>
        A policy has three parts, each optional — a policy can be pure prose, pure enforcement, or
        both:
      </P>
      <KeyList
        rows={[
          {
            term: "Prose",
            def: (
              <>
                Markdown injected into every employee&apos;s system prompt, in a{""}
                <Code>## Company policies</Code> section. &quot;Never discuss pricing over
                email,&quot; &quot;always disclose that you are an AI&quot; — the rules a human
                handbook would carry.
              </>
            ),
          },
          {
            term: "Blocked domains",
            def: (
              <>
                Recipient domains no email may go to — a competitor, a regulator, a litigation
                counterparty. Enforced at the same mail-send choke point as the{""}
                <DocLink to="/docs/deliverability#suppression">suppression list</DocLink>, for every
                sender, human or AI. Subdomains are covered; lookalike domains (
                <Code>notacme.com</Code> for <Code>acme.com</Code>) are not false-matched. The error
                names the policy that blocked the send.
              </>
            ),
          },
          {
            term: "Forbidden tools",
            def: (
              <>
                Genosyn catalogue tool names no employee may call — refused at AI tool dispatch with
                a <Code>policy.violation</Code> audit event. <Code>find_tools</Code> and{""}
                <Code>call_tool</Code> cannot be forbidden, so an employee can always discover that
                a refusal came from policy rather than a broken tool.
              </>
            ),
          },
        ]}
      />

      <H2 id="above-the-soul">Policies frame the Soul</H2>
      <P>
        The <Code>## Company policies</Code> section sits <Strong>above</Strong> the{""}
        <DocLink to="/docs/soul">Soul</DocLink> in every employee&apos;s prompt, and that ordering
        is the point: policies bind the whole company, and each employee&apos;s Soul is read inside
        their frame — never the reverse. A Soul describes one employee&apos;s character and
        judgement; a policy is the boundary that judgement operates within. The injected section
        says so explicitly: the rules bind every employee, and the mechanical clauses are enforced
        by the platform either way.
      </P>

      <H2 id="managing">Managing policies</H2>
      <UL>
        <LI>
          Open <Strong>Settings → Policies</Strong>. Creating, editing, disabling, and deleting a
          policy is admin-only; <Strong>reading is member-level</Strong>, because everyone in the
          company — human and AI — is bound by them.
        </LI>
        <LI>
          Each policy has a title, optional prose, and the two optional mechanical lists — blocked
          recipient domains and forbidden tools, one entry per line.
        </LI>
        <LI>
          A disabled policy stops binding immediately — it is neither injected nor enforced until
          re-enabled.
        </LI>
      </UL>
      <P>
        Every enforcement is on the record. A blocked send or a refused tool call writes a{""}
        <Code>policy.violation</Code> audit event naming the policy, the actor, and what was refused
        — so drift between what the rules say and what employees attempt is legible in the audit
        log, not silent.
      </P>

      <H2 id="ad-spend-budgets">Ad-spend budgets</H2>
      <P>
        A <Strong>Budget</Strong> is a monthly envelope over authorized ad-spend increases — the
        company-wide layer above the per-Connection{""}
        <DocLink to="/docs/marketing#model">caps</DocLink>. Where a cap says &quot;no single change,
        day, or rolling month may exceed this on this Connection,&quot; a Budget says &quot;this
        scope authorizes at most this much this calendar month,&quot; measured over the UTC calendar
        month and reset when it rolls over.
      </P>
      <P>
        A Budget scopes to the <Strong>whole company</Strong>, one <Strong>Connection</Strong>, or
        one <Strong>AI Employee</Strong>, and a spend increase must fit inside{""}
        <Strong>every</Strong> applicable envelope — the tightest binds. Enforcement runs at the
        same seam as the caps, on every spend-increasing mutation on every path, including approval
        replays: an envelope that ran dry between an Approval queueing and a human&apos;s ✓ still
        binds when the replay fires.
      </P>
      <UL>
        <LI>
          <Strong>Exhaustion refuses, names, and redirects.</Strong> The mutation fails with the
          budget named and its remaining headroom, and the employee is told to raise a{""}
          <DocLink to="/docs/decisions">Decision</DocLink> or wait for the month — not to retry.
        </LI>
        <LI>
          <Strong>Owners and admins are paged once</Strong> per budget per month on first exhaustion
          — a retrying employee cannot ring the bell on every attempt.
        </LI>
        <LI>
          <Strong>Spend-decreasing actions are never blocked.</Strong> Pausing a runaway campaign or
          lowering a budget is the emergency action; an exhausted envelope must never delay it.
        </LI>
      </UL>
      <P>
        Budgets are managed from the <Strong>Budgets</Strong> page — writes admin-only, reads
        member-level, since an envelope is spend authority. Each row shows the month&apos;s
        authorized spend against the envelope, so headroom is visible at a glance.
      </P>
      <Callout kind="warn" title="Budgets are currency-blind, like the caps.">
        Sums add minor units across ad accounts without FX conversion — deliberately deferred rather
        than silently wrong. If you run accounts in multiple currencies, scope a Budget per
        Connection so each envelope stays in one currency.
      </Callout>

      <H2 id="taint-policy">The taint policy</H2>
      <P>
        The open web is where hostile content meets side effects: a page an employee fetched can
        address the model directly, and what an injected instruction most wants is an outbound email
        or a persistent foothold. So Genosyn tracks <Strong>taint</Strong> per turn, on by default.
        A turn that uses the <DocLink to="/docs/browser#web-tools">web tools</DocLink> —{""}
        <Code>search_web</Code>, <Code>fetch_web_page</Code>, <Code>download_web_file</Code> — is
        marked tainted for the rest of that turn. There is no untainting: the model has already read
        whatever the page said.
      </P>
      <P>
        A tainted turn calling a high-risk sink — <Code>send_mail</Code>, or{""}
        <Code>create_routine</Code> / <Code>update_routine</Code> / <Code>delete_routine</Code>, the
        tools an injection would use to persist itself on a schedule — does not execute it. The
        verbatim call is held as an <Strong>Approval</Strong> (kind <Code>tainted_tool</Code>) in
        the same Approvals inbox as everything else, and the employee is told to carry on with its
        unheld work. Reads are never gated — a tainted turn can keep researching freely.
      </P>
      <UL>
        <LI>
          <Strong>Approving</Strong> replays the exact call server-side with a fresh
          employee-authority token — the same handler, grant checks, and audits the original call
          would have hit, minus the taint.
        </LI>
        <LI>
          <Strong>Rejecting</Strong> writes a warning to the employee&apos;s journal about the
          page&apos;s content, so the next run starts suspicious of it.
        </LI>
      </UL>
      <P>
        The gate is configured by a master admin at <Code>Admin → Runtime</Code>, under{""}
        <Strong>Agent</Strong> — <Code>&quot;web&quot;</Code> (the default) arms it,{""}
        <Code>&quot;off&quot;</Code> disables it. It is stored in the database and takes effect
        without a restart; see{""}
        <DocLink to="/docs/self-hosting#runtime-settings">Configuration</DocLink>.
      </P>
      <Callout kind="info" title="Deliberately narrow, for now.">
        Two taint paths are named follow-ups rather than covered today: mail bodies as a taint
        source (it would gate every send-grant employee&apos;s every send), and the connector
        compose tools such as <Code>gmail_send_message</Code>, which dispatch through the
        Integration surface rather than the genosyn catalogue. Treat email content an employee read
        the same way you would a web page it fetched.
      </Callout>

      <Callout kind="tip" title="Three rails, one shape.">
        A policy, a Budget, and the taint gate all work the way{""}
        <DocLink to="/docs/autonomy">earned autonomy</DocLink> does in reverse: the platform holds
        the line mechanically, humans move it deliberately, and every refusal leaves a record.
      </Callout>
    </>
  );
}
