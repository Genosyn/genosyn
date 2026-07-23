import {
  Callout,
  Code,
  DocLink,
  H2,
  H3,
  LI,
  P,
  PageHeader,
  Pre,
  Strong,
  UL,
} from "@/docs/Prose";

export function Skills() {
  return (
    <>
      <PageHeader
        eyebrow="Core concepts"
        title="Skills"
        lead={
          <>
            A Skill is a named markdown <Strong>playbook</Strong> — the procedure for one capability
            the employee knows how to apply. Stored on <Code>Skill.body</Code>, attached to one
            employee, easy to copy between employees.
          </>
        }
      />

      <H2 id="where-they-live">Where they live</H2>
      <P>
        Skills have their own section in the nav, under <Strong>AI → Skills</Strong>. That list is
        company-wide: every skill, every employee, one page — your whole playbook library. Filter it
        by the <DocLink to="/docs/employees">AI Employee</DocLink> that knows a skill, search by
        name, or narrow the list with a reusable company <DocLink to="/docs/tags">Tag</DocLink>.
      </P>
      <P>
        Clicking a skill opens its detail page: <Strong>Playbook</Strong> — the markdown editor, ⌘S
        to save — and <Strong>Settings</Strong>, where you rename or delete it. Each AI employee
        still links to their own slice of that list — same page, filtered to them.
      </P>

      <H2 id="how-they-work">How they work</H2>
      <P>
        When the runner runs the agent, it surfaces the Soul plus every Skill body into the
        model&apos;s context. The model picks the right playbook for the task at hand the same way a
        human would skim a runbook: by the title and the first paragraph.
      </P>
      <P>
        A Skill is prose, not code — it tells the employee <Strong>how</Strong> to work, while the tools it
        uses live in <DocLink to="/docs/integrations">Integrations</DocLink> and the built-in
        catalogue. A Skill may <Strong>declare</Strong> which tools its procedure uses, under
        Settings → Tools, so those are loaded up-front instead of looked up (see{" "}
        <DocLink to="/docs/tool-discovery">How tools reach the model</DocLink>). Declaring is not
        granting: access is still decided by Grants.
        A Skill is the prose around the tool: <em>when</em> to reach for it, <em>how</em> to use it,
        and what good output looks like.
      </P>

      <H2 id="anatomy">Anatomy of a good Skill</H2>
      <UL>
        <LI>
          <Strong>Title.</Strong> A verb-first slug — <Code>write-weekly-digest</Code>,{" "}
          <Code>reconcile-stripe-payouts</Code>, <Code>page-oncall-for-checkout-p99</Code>.
          Searchable by what it does.
        </LI>
        <LI>
          <Strong>Trigger.</Strong> One sentence on when this skill fires. Either it&apos;s called
          explicitly by a Routine, or the model decides based on context — make that easy.
        </LI>
        <LI>
          <Strong>Inputs.</Strong> What the skill expects: a date range, a customer id, a markdown
          brief. Be explicit.
        </LI>
        <LI>
          <Strong>Steps.</Strong> The procedure. Number them. Reference the exact integration tools
          the employee will call.
        </LI>
        <LI>
          <Strong>Definition of done.</Strong> What the output looks like. A markdown report? A new{" "}
          <DocLink to="/docs/vocabulary">Todo</DocLink>? A Slack message? Spell it out so the model
          has something to check itself against.
        </LI>
      </UL>

      <H3 id="example">Example</H3>
      <Pre lang="markdown">{`# reconcile-stripe-payouts

## Trigger
Daily Routine "Reconcile Stripe", or when a teammate asks "what landed yesterday?"

## Inputs
- Date range (default: yesterday in company timezone)
- Account: the Stripe Connection named "Live"

## Steps
1. Call \`stripe.list_charges\` for the date range.
2. Group by payout id.
3. Cross-check totals against the bank Connection&#x27;s deposits.
4. Flag any payout where the totals diverge by more than $0.01.

## Definition of done
A markdown report posted to #finance with three sections:
- Totals (count, gross, net, fees)
- Payouts (one row per payout, with link)
- Discrepancies (empty section is fine — say "none")`}</Pre>

      <H2 id="composition">Composition</H2>
      <P>
        Skills compose by reference. A bigger skill can say{" "}
        <em>&quot;then run <Code>reconcile-stripe-payouts</Code>&quot;</em> and
        the model will follow that link. This keeps individual skills small
        and reusable across employees.
      </P>

      <H2 id="sharing">Sharing skills between employees</H2>
      <P>
        Today, copying is manual, but the company-wide list makes it quick:
        open the source skill, copy its playbook, hit <Strong>New skill</Strong>
        , pick the target employee, paste. The future{" "}
        <Strong>Marketplace</Strong> milestone (
        <DocLink to="/docs/vocabulary">M17</DocLink>) will let you export an
        employee — soul + skills + routines + grants — as a bundle that
        imports into another company.
      </P>

      <Callout kind="info" title="Write skills like onboarding docs.">
        The best test of a Skill is: could a new junior hire follow it? If
        yes, the model can too. If it relies on tribal knowledge, the model
        will guess.
      </Callout>
    </>
  );
}
