import {
  Callout,
  Code,
  DocLink,
  ExtLink,
  H2,
  KeyList,
  LI,
  P,
  PageHeader,
  Strong,
  UL,
} from "@/docs/Prose";

export function PlansBilling() {
  return (
    <>
      <PageHeader
        eyebrow="Get started"
        title="Plans &amp; billing"
        lead={
          <>
            One codebase, three ways to run it: self-hosted Community (free), self-hosted
            Enterprise (a license), and Genosyn Cloud (per-company Plans billed through Stripe).
            This page covers what each shape includes and how to move between Plans.
          </>
        }
      />

      <H2 id="editions">The three shapes</H2>
      <KeyList
        rows={[
          {
            term: "Community",
            def: (
              <>
                The default when you self-host. Free forever, with unlimited AI Employees and
                Routines. The two enterprise features — Single sign-on and the Audit log — are
                disabled and show an &ldquo;available in Genosyn Enterprise&rdquo; card in their
                place.
              </>
            ),
          },
          {
            term: "Enterprise",
            def: (
              <>
                A self-hosted install with a Genosyn Enterprise license activated at{" "}
                <Strong>Admin → License</Strong>. Everything in Community plus Single sign-on and
                the Audit log. See <DocLink to="/docs/enterprise-license" />.
              </>
            ),
          },
          {
            term: "Cloud",
            def: (
              <>
                Genosyn Cloud, where each company is on a Plan — Free, Growth, or Scale — billed
                through Stripe. The same Plans apply on any install whose operator enables instance
                billing.
              </>
            ),
          },
        ]}
      />
      <P>
        Whatever the shape, AI model usage is separate: your AI Employees run on the{" "}
        <DocLink to="/docs/models">AI Models</DocLink> you connect, and that API usage is billed by
        your model provider, not by Genosyn.
      </P>

      <H2 id="plans">The Cloud Plans</H2>
      <KeyList
        rows={[
          {
            term: "Free",
            def: (
              <>
                $0. A starter team: <Strong>1 AI Employee</Strong> and{" "}
                <Strong>2 Routines</Strong>. No Single sign-on, no Audit log.
              </>
            ),
          },
          {
            term: "Growth",
            def: (
              <>
                <Strong>$19 / AI Employee / month</Strong>. Unlimited AI Employees and unlimited
                Routines.
              </>
            ),
          },
          {
            term: "Scale",
            def: (
              <>
                <Strong>$49 / AI Employee / month</Strong>. Everything in Growth, plus{" "}
                <Strong>Single sign-on</Strong> and the <Strong>Audit log</Strong>.
              </>
            ),
          },
        ]}
      />
      <P>
        Paid Plans are billed per AI Employee hired, with a minimum of one seat. Hiring and firing
        adjust the billed quantity automatically, and Stripe prorates mid-cycle changes. The full
        comparison lives on <ExtLink href="https://genosyn.com/pricing">genosyn.com/pricing</ExtLink>.
      </P>

      <H2 id="upgrading">Upgrading your company</H2>
      <P>
        Open <Strong>Settings → Billing</Strong>. The top card shows your current plan, its
        subscription status, how many AI Employees you have, and — on Free — how many of your
        Routines are used. Below it, the three plan cards each list what they include; your plan is
        marked <Strong>Current plan</Strong>.
      </P>
      <UL>
        <LI>
          Click <Strong>Upgrade to Growth</Strong> or <Strong>Upgrade to Scale</Strong> on a plan
          card. You are redirected to Stripe Checkout; on success you land back on the Billing page
          with the new plan active.
        </LI>
        <LI>
          <Strong>Manage billing</Strong> opens the Stripe billing portal, where you update cards,
          download invoices, or cancel — changes sync back automatically.
        </LI>
        <LI>
          Only the company <Strong>owner</Strong> can change the plan or open the billing portal;
          company admins can read everything on the page.
        </LI>
      </UL>

      <H2 id="limits">What happens at the Free limits</H2>
      <P>
        The Free limits are company-wide totals, enforced by the server everywhere a Routine or AI
        Employee can be created — including when an AI Employee tries to create a Routine itself.
        At the cap, the action is refused with the exact message:
      </P>
      <UL>
        <LI>
          Hiring a second AI Employee: <em>&ldquo;Your Free plan includes 1 AI Employee. Upgrade to
          Growth to hire more.&rdquo;</em>
        </LI>
        <LI>
          Creating a third Routine: <em>&ldquo;Your Free plan includes 2 Routines. Upgrade to
          Growth for unlimited Routines.&rdquo;</em>
        </LI>
      </UL>
      <P>
        The Employees and Routines pages also show a banner with a <Strong>View plans</Strong> link
        once you reach the cap. Gated features answer similarly — for example, opening the Audit
        log below Scale shows{" "}
        <em>&ldquo;Audit log is available on the Scale plan.&rdquo;</em> with a card linking to the
        Billing page. Nothing is lost at a limit: audit history keeps accruing either way, ready
        the moment you upgrade.
      </P>

      <H2 id="operators">For operators: enabling instance billing</H2>
      <P>
        Everything below is for the person running the install. Self-hosted installs skip this —
        leave billing off and every company runs unlimited (their Billing page explains itself
        away). Turning it on is what makes an install behave like Genosyn Cloud.
      </P>
      <P>
        Open <Strong>Admin → Billing</Strong> and fill in the{" "}
        <Strong>Stripe configuration</Strong> card:
      </P>
      <UL>
        <LI>
          Create two recurring prices in Stripe — Growth ($19 / AI Employee / month) and Scale
          ($49) — and paste their ids into <Strong>Growth price id</Strong> and{" "}
          <Strong>Scale price id</Strong>.
        </LI>
        <LI>
          Paste the <Strong>Stripe secret key</Strong> and the{" "}
          <Strong>Webhook signing secret</Strong>. Both are stored encrypted and never shown again;
          leave a field blank later to keep the stored value.
        </LI>
        <LI>
          Flip <Strong>Enable per-company billing</Strong> and{" "}
          <Strong>Save billing settings</Strong>. The server refuses to enable billing until the
          secret key and both price ids are configured. Companies without a subscription land on
          the Free plan.
        </LI>
      </UL>
      <P>
        Then point a Stripe webhook at{" "}
        <Code>&lt;your URL&gt;/api/billing/stripe/webhook</Code> (the{" "}
        <Strong>Stripe webhook endpoint</Strong> card shows the exact URL with a copy button) and
        subscribe it to the checkout and subscription events. The signing secret is how the install
        verifies those deliveries.
      </P>
      <Callout kind="info" title="Plans never cover model usage.">
        A company&apos;s Plan pays for Genosyn seats. The tokens its AI Employees consume are
        always billed by the customer&apos;s own model provider through the keys they connect at{" "}
        <DocLink to="/docs/models">AI Models</DocLink> — separate bill, separate vendor.
      </Callout>

      <H2 id="see-also">See also</H2>
      <UL>
        <LI>
          <DocLink to="/docs/enterprise-license" /> — unlocking Single sign-on and the Audit log on
          a self-hosted install.
        </LI>
        <LI>
          <DocLink to="/docs/self-hosting#sso">Instance SSO</DocLink> — the operator-level single
          sign-on configured at <Code>Admin → SSO</Code>.
        </LI>
        <LI>
          <ExtLink href="https://genosyn.com/pricing">genosyn.com/pricing</ExtLink> — the public
          plan comparison.
        </LI>
      </UL>
    </>
  );
}
