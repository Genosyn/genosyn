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
      <Callout kind="info" title="Genosyn Member sessions are isolated from AI Browser authority">
        If App-owned Chromium holds a Member&apos;s Genosyn session, every Genosyn App API request
        from that browser is refused. The session cannot mint API keys, change company roles, or
        become a shortcut around Vault access. Use the AI Employee&apos;s Grants and governed tools
        instead.
      </Callout>

      <H2 id="web-tools">Reading the web without a browser</H2>
      <P>
        Most of the time an employee does not need a browser at all — it needs to find a page and
        read it. Three tools do that for every employee, with no Chromium, no setup, and no toggle:
      </P>
      <KeyList
        rows={[
          {
            term: "search_web",
            def: "Search the public web and get back titles, URLs and snippets.",
          },
          {
            term: "fetch_web_page",
            def: "Read one page as plain text. HTML, plain text, JSON and PDF pages are all extracted.",
          },
          {
            term: "download_web_file",
            def: "Download a file and keep it as a chat attachment — a blank form the employee can then fill in with the PDF tools and attach to an email.",
          },
        ]}
      />
      <P>
        That last one is the useful chain: an employee working an email thread can find the current
        version of a form online, download it, complete it from what your company already knows, and
        attach the finished file to a Gmail draft. See{" "}
        <DocLink to="/docs/email#assistant">AI chat on every email</DocLink>.
      </P>
      <P>
        Every request goes through the same outbound guard as the rest of the product: http(s) only,
        no credentials in the URL, and every redirect re-checked so a link cannot be used to reach
        loopback, private, or cloud-metadata addresses inside your network. Fetched content is fed to
        the model as untrusted data, and the employee is told plainly that a web page giving it
        instructions is a stranger talking, not its teammate. Operators who want this off entirely —
        or search off while direct fetches stay — set <Code>web.enabled</Code> and{" "}
        <Code>web.searchProvider</Code> in <Code>config.ts</Code>. Search uses DuckDuckGo&apos;s
        no-JavaScript endpoint by default, so no API key or account is involved.
      </P>
      <P>
        Everything below is about the heavier capability: a real browser that holds a session,
        clicks, and fills forms.
      </P>

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
      <P>
        The browser an employee drives does not have to be the one inside the container. A Member
        can connect a Chrome running on their own computer and point a conversation at it, so the
        employee works from that machine and its signed-in sites, with the same tools and the same
        live view. It is a dedicated Chrome profile rather than their everyday browser, and it comes
        with a stricter policy of its own — see{" "}
        <DocLink to="/docs/member-browsers">Member browsers</DocLink>.
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
            term: "browser_fill_vault",
            def: "Fill a username or Login password from an explicitly granted Vault item. Passwords go only into password inputs, and the App never returns plaintext to the model.",
          },
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
            term: "browser_save_vault_login",
            def: "Request owner/admin approval to capture a same-origin password input into a new restricted Vault login without reading it back through the model.",
          },
          {
            term: "browser_screenshot",
            def: "A JPEG of the viewport when layout matters. It is unavailable after the session has observed or filled a password; use the redacted snapshot then.",
          },
          {
            term: "browser_submit",
            def: "Submit a form. With approval mode on, queues an Approval instead of firing.",
          },
          {
            term: "browser_resume",
            def: "Run an approved submit or restricted Vault capture in its original Browser session and page.",
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
      <P>
        Password-input values are removed from snapshots before they reach the model, including
        password fields inside frames. Once a password has been observed or filled in the session,
        <Code>browser_screenshot</Code> refuses to create a model-visible image; the structural
        snapshot remains available with the password redacted.
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
        The list is enforced server-side on <Code>browser_open</Code> and intersected with Vault
        autofill and capture checks on the live top page and target frame. Edits apply immediately —
        no restart needed — and a Vault Grant never widens this Browser policy.
      </P>

      <H2 id="vault">Vault autofill and capture</H2>
      <P>
        A granted <DocLink to="/docs/vault">Vault</DocLink> login removes the need to paste a
        password into Chat or type it during take-over. The employee first calls{" "}
        <Code>list_vault_items</Code> for safe metadata, opens the saved website, then calls{" "}
        <Code>browser_fill_vault</Code> for the username or password field. The App resolves the
        current item-level Grant and types the value directly into Chromium. The tool result only
        confirms that the field was filled.
      </P>
      <P>
        Autofill is bound to the login&apos;s exact saved origin: scheme, host, and port must match
        on both the top page and target frame. The stored password is accepted only from a Login
        item and only into an input with <Code>type=password</Code>; API keys and secure-note bodies
        are not Browser-fill sinks. A missing or revoked Grant fails closed. Browser access and the
        host allow list still apply independently, so a Vault Grant cannot turn the Browser on or
        widen where it may navigate.
      </P>
      <P>
        For signup and password-generation flows, <Code>browser_save_vault_login</Code> captures the
        current value of a same-origin password input only after a company owner or admin approves
        the request. This approval is mandatory even when ordinary form-submit approval is off. The
        result is a restricted Vault item bound to the current origin, with a Manage Grant for the
        employee; other Members do not see it until an owner or admin changes its access. The
        password is neither read back nor included in model output. An employee can instead use{" "}
        <Code>create_vault_login</Code> to have Genosyn generate and encrypt a company-visible
        password before filling it into the page.
      </P>

      <H2 id="approvals">Approval-gated submits</H2>
      <P>
        With <Strong>require approval for form submits</Strong> on, a <Code>browser_submit</Code>{" "}
        does not fire. It queues an Approval — visible in the company Approvals inbox with the page
        URL and a one-line summary of what the employee is trying to do — and the employee is told
        the submission is pending. Once you approve, the employee re-fires it with{" "}
        <Code>browser_resume</Code>, in the same turn or a later one. The approval is{" "}
        <Strong>bound to the page it was raised on and fires exactly once</Strong>. Genosyn claims
        the approval atomically before touching the page, so concurrent resumes cannot submit it
        twice. If a browser process or network connection fails after that claim, Genosyn treats the
        outcome as unknown and will not replay it automatically; raise a new submit for another
        reviewed attempt. If the browser moved to a different page before the claim (or was
        reclaimed while idle), the employee is asked to submit again rather than firing blindly
        against whatever is now loaded. Rejecting writes the decision to the employee&apos;s
        journal. Only owners and admins may open or decide these requests, and deciding requires
        recent primary and second-factor authentication in a logged-in browser session rather than
        an API key.
      </P>

      <H2 id="live-view">Live view and takeover</H2>
      <P>
        While the employee browses, the chat panel shows the page live. Click{" "}
        <Strong>Take over</Strong> to drive it yourself — your mouse and keyboard go straight to the
        same Chromium. Use Vault autofill for a granted stored credential; take-over remains the
        fallback for a credential not in the Vault and the intended flow for captchas and 2FA. The
        employee navigates to the right page, you complete the human-only step, and the employee
        carries on. The browser is never torn down while someone is watching.
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
      <P>
        That per-employee session is also what{" "}
        <DocLink to="/docs/integrations">browser-login Connections</DocLink> use. When a site
        challenges a stored-password sign-in with a captcha or a 2FA prompt, the fix is to take over
        here and sign in once — the Connection picks up the session you established and stops
        failing.
      </P>

      <Callout title="Reserved name">
        <Code>browser</Code> is a reserved MCP server name — a user-configured server with that name
        is ignored so it can&apos;t shadow the built-in tools. See{" "}
        <DocLink to="/docs/models">AI Models</DocLink> for how the tool list is assembled.
      </Callout>
    </>
  );
}
