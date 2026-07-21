import { Callout, Code, DocLink, H2, KeyList, LI, P, PageHeader, Strong, UL } from "@/docs/Prose";

export function Browser() {
  return (
    <>
      <PageHeader
        eyebrow="Brains &amp; tools"
        title="Browser"
        lead={
          <>
            Give an AI employee a real, persistent web browser. A headless Chromium runs inside the
            App container; the employee reads pages as ref-annotated snapshots and acts on them with
            a small set of <Code>browser_*</Code> tools, while you watch live and take over whenever
            a human is needed.
          </>
        }
      />

      <Callout kind="warn" title="Unavailable in shared SaaS mode">
        The current Chromium runtime shares the App container and filesystem, so the fail-closed
        hosted profile disables it. It remains available for single-tenant self-hosting. A hosted
        browser needs a separately isolated worker before operators should enable it.
      </Callout>

      <H2 id="enabling">Enabling it</H2>
      <P>
        Browser access is off by default. Open the employee, go to{" "}
        <Strong>Settings → Browser</Strong>, and flip on <Strong>Browser access</Strong>. The same
        card holds the two shaping controls: the <Strong>allow list</Strong> (which hosts the
        employee may open) and <Strong>require approval for form submits</Strong> (a
        human-in-the-loop gate on anything that sends data). A{" "}
        <DocLink to="/docs/routines">Routine</DocLink> can override the toggle per schedule — useful
        for an employee who may browse during a nightly research run but not in ad-hoc chat.
      </P>

      <H2 id="tools">The tools</H2>
      <P>
        When enabled, the employee&apos;s tool list grows by the <Code>browser</Code> set. Every
        action returns a fresh snapshot of the page, so the employee always acts on current state:
      </P>
      <KeyList
        rows={[
          {
            term: "browser_open",
            def: "Navigate to a URL (gated by the allow list) and snapshot the loaded page.",
          },
          {
            term: "browser_snapshot",
            def: "Re-read the current page without acting — e.g. at the start of a new turn.",
          },
          {
            term: "browser_click",
            def: "Click an element. If the click opens a new tab, the browser follows it automatically.",
          },
          { term: "browser_fill", def: "Type into an input or textarea, replacing its contents." },
          {
            term: "browser_select",
            def: "Choose an option in a native dropdown by value or visible label.",
          },
          { term: "browser_press", def: "Press a key — Enter, Tab, Escape, arrows." },
          {
            term: "browser_hover",
            def: "Hover to reveal menus or tooltips; the hover holds so a follow-up click works.",
          },
          {
            term: "browser_scroll",
            def: "Scroll by a viewport (fires real wheel events, so lazy-loaded and infinite-scroll pages load more content) or bring a specific element into view.",
          },
          {
            term: "browser_back",
            def: "Go back one page in history — the recovery move after a misclick.",
          },
          {
            term: "browser_wait",
            def: "Wait for a selector to appear (up to 15s) or pause a fixed time, instead of polling with snapshots.",
          },
          {
            term: "browser_screenshot",
            def: "A JPEG of the viewport, for when layout or imagery matters.",
          },
          {
            term: "browser_submit",
            def: "Submit a form. With approval mode on, queues an Approval instead of firing.",
          },
          {
            term: "browser_resume",
            def: "Re-fire an approved submit — in the same turn or any later one.",
          },
          {
            term: "browser_close",
            def: "Shut the browser down (skipped while a human is watching the live view).",
          },
        ]}
      />

      <H2 id="snapshots">Snapshots and refs</H2>
      <P>
        A snapshot is a YAML outline of the page in which every interactive element carries a stable
        marker like <Code>[ref=e12]</Code> — including elements inside iframes. The employee acts on
        a ref directly by passing <Code>aria-ref=e12</Code> as the selector, which resolves
        instantly and unambiguously; CSS and text selectors work too as fallbacks. The outline
        covers the whole page, not just the viewport; on very large pages it is capped with a note
        saying how many elements were omitted, and the employee narrows down by interacting with a
        section or navigating to a more specific URL.
      </P>
      <P>
        Events the employee could not otherwise see — a JavaScript dialog that was auto-dismissed, a
        popup tab that was adopted, a selector that matched more than one element — are surfaced as{" "}
        <Code>NOTE:</Code> lines at the top of the next snapshot.
      </P>

      <H2 id="allow-list">The allow list</H2>
      <P>
        One host pattern per line; blank means unrestricted. Lines starting with <Code>#</Code> are
        comments. Matching rules:
      </P>
      <UL>
        <LI>
          <Code>mail.google.com</Code> — that exact host, and nothing else. Use this to pin a single
          host.
        </LI>
        <LI>
          <Code>*.github.com</Code> — the apex <Code>github.com</Code> and every subdomain (
          <Code>www.github.com</Code>, <Code>gist.github.com</Code>, …).
        </LI>
        <LI>
          <Code>app.*.example.com</Code> — a glob; each <Code>*</Code> spans a single label and
          never crosses a dot.
        </LI>
      </UL>
      <P>
        The list is enforced server-side on every <Code>browser_open</Code>, so edits apply
        immediately — no restart needed.
      </P>

      <H2 id="approvals">Approval-gated submits</H2>
      <P>
        With <Strong>require approval for form submits</Strong> on, a <Code>browser_submit</Code>{" "}
        does not fire. It queues an Approval — visible in the company Approvals inbox with the page
        URL and a one-line summary of what the employee is trying to do — and the employee is told
        the submission is pending. Once you approve, the employee re-fires it with{" "}
        <Code>browser_resume</Code>, in the same turn or a later one. The approval is{" "}
        <Strong>bound to the page it was raised on and fires exactly once</Strong>: if the browser
        has moved to a different page (or was reclaimed while idle) the employee is asked to submit
        again rather than firing blindly against whatever is now loaded. Rejecting writes the
        decision to the employee&apos;s journal.
      </P>

      <H2 id="live-view">Live view and takeover</H2>
      <P>
        While the employee browses, the chat panel shows the page live. Click{" "}
        <Strong>Take over</Strong> to drive it yourself — your mouse and keyboard go straight to the
        same Chromium. That is the intended flow for credentials, captchas, and 2FA: the employee
        navigates to the login page, you type the secret, the employee carries on. The browser is
        never torn down while someone is watching.
      </P>

      <H2 id="persistence">What persists</H2>
      <P>
        The browser outlives individual chat turns — &quot;I&apos;ll wait while you sign in&quot;
        genuinely works, and an idle browser is reclaimed after five minutes once nobody is using
        it. Cookies and local storage are snapshotted per employee under the company data directory,
        so a login survives new conversations and container restarts. Model credentials are never
        involved; see <DocLink to="/docs/self-hosting">Configuration</DocLink> for where data lives
        on disk.
      </P>

      <Callout title="Reserved name">
        <Code>browser</Code> is a reserved MCP server name — a user-configured server with that name
        is ignored so it can&apos;t shadow the built-in tools. See{" "}
        <DocLink to="/docs/models">AI Models</DocLink> for how the tool list is assembled.
      </Callout>
    </>
  );
}
