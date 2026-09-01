import { Callout, Code, DocLink, H2, KeyList, LI, P, PageHeader, Strong, UL } from "@/docs/Prose";

export function Autonomy() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Earned autonomy"
        lead={
          <>
            An AI Employee with a clean record can stop asking permission for work it has already
            proven it does safely. Genosyn measures that record, proposes the change through the
            ordinary Approvals inbox, and takes the autonomy back automatically — and instantly —
            the moment the record breaks.
          </>
        }
      />

      <Callout kind="info" title='"Waiver" is the word.'>
        Genosyn never says &quot;trust score,&quot; &quot;tier,&quot; or &quot;level.&quot; Earned
        autonomy is a closed set of named <Strong>Waivers</Strong>, each one a specific gate
        switched off, with the evidence that justified it kept on the record.
      </Callout>

      <H2 id="what-a-waiver-is">What a waiver is</H2>
      <P>
        A waiver is one approval gate, waived. There are exactly two kinds — not a score that
        unlocks things by degrees:
      </P>
      <KeyList
        rows={[
          {
            term: "Browser approvals waived",
            def: (
              <>
                The employee&apos;s <DocLink to="/docs/browser">browser</DocLink> submits stop
                queueing for a human ✓ — <Code>browserApprovalRequired</Code> is switched off for
                that employee.
              </>
            ),
          },
          {
            term: "Routine approvals waived",
            def: (
              <>
                One <DocLink to="/docs/routines">Routine</DocLink>&apos;s gated ticks stop waiting
                for approval — <Code>requiresApproval</Code> is switched off for that routine, and
                only that routine.
              </>
            ),
          },
        ]}
      />

      <H2 id="earning-a-promotion">How a promotion is earned</H2>
      <P>
        Once an hour, a sweep reads each employee&apos;s trailing <Strong>30-day</Strong> record. To
        be eligible for a waiver, the record must show:
      </P>
      <UL>
        <LI>
          At least <Strong>10</Strong> terminal Runs, with <Strong>zero</Strong> failures or
          timeouts, nothing graded <DocLink to="/docs/routines#outcome-check">off goal</DocLink>,
          and no required <DocLink to="/docs/verification">Check</DocLink> failed.
        </LI>
        <LI>
          Those Runs must be <Strong>verified</Strong>, not merely un-flagged. A Run graded{" "}
          <Code>unverified</Code> — the checker errored, timed out, or never submitted — no longer
          counts toward the ten. So does a Run nobody has graded at all. Before M58 both were
          recorded with the same word as &quot;the evidence was ambiguous&quot; and read downstream
          as &quot;fine&quot;, which meant an outage in the checker could earn an employee the right
          to work unattended.
        </LI>
        <LI>
          At least <Strong>5 approved</Strong> and <Strong>0 rejected</Strong> approvals of the
          relevant kind — browser submits for the browser waiver, gated ticks for the routine
          waiver. Autonomy is earned by asking well, not by not being caught.
        </LI>
      </UL>
      <P>
        A Routine with <Strong>no acceptance criteria and no Checks</Strong> is not promotable at
        all. Its Runs have never been measured against anything, so a hundred of them are not
        evidence — they are a hundred loops that returned. Give the Routine a bar first, then let it
        clear it.
      </P>
      <P>
        An eligible employee gets no silent upgrade. The sweep drafts an <Strong>Approval</Strong>{" "}
        of kind <Code>autonomy_promotion</Code>, with the evidence — the run counts, the approval
        tallies, the window — written into its summary, and it lands in the same Approvals inbox as
        everything else. An admin approving it is what applies the gate change and records the
        waiver; rejecting it means the same promotion is not proposed again for{" "}
        <Strong>30 days</Strong>.
      </P>

      <H2 id="demotion">Demotion is automatic</H2>
      <P>
        The reverse direction has no inbox and no waiting. Any Run that ends <Code>failed</Code> or{" "}
        <Code>timeout</Code>, or completes but is graded <Code>off goal</Code>, or completes with a
        required <DocLink to="/docs/verification">Check</DocLink> failed, revokes{" "}
        <Strong>every</Strong> active waiver the employee holds and re-arms the gates on the spot. A
        failed Check counts here exactly like an off-goal grade — it is the stronger evidence of the
        two, since no model had a say in it. The employee&apos;s journal records what happened and
        why, and owners, admins, and the employee&apos;s manager are paged. Demotion only ever
        tightens — a bad Run can take autonomy away, never hand more out.
      </P>

      <H2 id="revoking">Seeing and revoking a waiver</H2>
      <P>
        Active waivers show on the employee&apos;s page under <Strong>Settings</Strong>, in the{" "}
        <Strong>Autonomy</Strong> card — which waiver, when it was granted, and the evidence it was
        granted on. Any admin can revoke a waiver there at any time, no justification required;
        revoking re-arms the gate immediately. Nobody has to wait for a bad Run to change their
        mind.
      </P>
      <P>
        Revoking a waiver puts one gate back. When the answer is that the work should not be
        happening at all, the instrument is a <DocLink to="/docs/standdowns">Standdown</DocLink> — a
        waiver&apos;s exact inverse, imposed rather than earned, and broad rather than narrow.
      </P>

      <Callout kind="info" title="Promotion always keeps a human. Demotion never waits for one.">
        That asymmetry is the design. Granting autonomy is a judgement call, so it rides the
        Approvals inbox where a human makes it. Taking autonomy away is damage control, so it
        happens faster than any human could react — which is exactly what makes granting it safe.
      </Callout>
    </>
  );
}
