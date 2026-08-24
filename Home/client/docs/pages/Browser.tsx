import { Callout, Code, DocLink, H2, KeyList, LI, P, PageHeader, Strong, UL } from "@/docs/Prose";

export function Browser() {
  return (
    <>
      <PageHeader
        eyebrow="Brains &amp; tools"
        title="Browser"
        lead={
          <>
            Give an AI employee a real, persistent web browser. Real Google Chrome runs inside the
            App container; the employee reads pages as ref-annotated snapshots and acts on them with
            a small set of <Code>browser_*</Code> tools, while you watch live and take over whenever
            a human is needed.
          </>
        }
      />

      <Callout kind="warn" title="Unavailable in shared SaaS mode">
        The current browser runtime shares the App container and filesystem, so the fail-closed
        hosted profile disables it. It remains available for single-tenant self-hosting. A hosted
        browser needs a separately isolated worker before operators should enable it.
      </Callout>
      <Callout kind="info" title="Genosyn Member sessions are isolated from AI Browser authority">
        If App-owned Chrome holds a Member&apos;s Genosyn session, every Genosyn App API request
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
        loopback, private, or cloud-metadata addresses inside your network. Fetched content is fed
        to the model as untrusted data, and the employee is told plainly that a web page giving it
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
            def: "Fill a username, Login password, or current authenticator code from an explicitly granted Vault item. Passwords and codes go only into matching sign-in inputs, and the App never returns plaintext to the model.",
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
            term: "browser_prepare_vault_totp",
            def: "Arm an AI-created Login for TOTP enrollment before asking the site to reveal its setup key or QR. Screenshots and model-visible page text are redacted immediately.",
          },
          {
            term: "browser_save_vault_totp",
            def: "Capture the prepared, same-origin authenticator setup key or QR into that Login without returning the setup key.",
          },
          {
            term: "browser_create_vault_passkey",
            def: "Run the selected site's passkey-registration action inside a temporary software authenticator and encrypt the resulting credential into the Login as one bounded ceremony.",
          },
          {
            term: "browser_use_vault_passkey",
            def: "Load one granted, origin-bound Vault passkey, trigger the selected sign-in action, save its counter, and remove it from Chrome before returning.",
          },
          {
            term: "browser_screenshot",
            def: "A JPEG of the viewport when layout matters. It is unavailable after the session has observed a password, one-time code, authenticator setup, or any QR; use the redacted snapshot then.",
          },
          {
            term: "browser_submit",
            def: "Submit a form. With approval mode on, queues an Approval instead of firing.",
          },
          {
            term: "browser_submit_with_vault_totp",
            def: "Claim the bound action, generate a fresh Vault one-time code, fill it, and submit immediately; approval mode queues this before any code is generated or filled.",
          },
          {
            term: "browser_resume",
            def: "Run an approved submit, restricted Vault password capture, TOTP submit, or one-shot passkey create/use action in its original Browser session and page.",
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
        Password-input values and Vault-supplied authenticator values are removed from snapshots
        before they reach the model, including fields inside frames. Once a password or TOTP setup
        value has been observed or filled in the session, <Code>browser_screenshot</Code> refuses to
        create a model-visible image; the structural snapshot remains available with sensitive
        values redacted.
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
        The list is enforced server-side on <Code>browser_open</Code>, on the{" "}
        <a href="#live-view">live view&apos;s address bar</a> during take-over, and intersected with
        Vault autofill and capture checks on the live top page and target frame. Edits apply
        immediately — no restart needed — and neither a Vault Grant nor a human holding control
        widens this Browser policy.
      </P>

      <H2 id="vault">Vault passwords, authenticator codes, and passkeys</H2>
      <P>
        A granted <DocLink to="/docs/vault">Vault</DocLink> login removes the need to paste a
        password or current authenticator code into Chat or type it during take-over. The employee
        first calls <Code>list_vault_items</Code> for safe metadata, opens the saved website, then
        calls <Code>browser_fill_vault</Code> for the username, password, or <Code>totp</Code>{" "}
        field. The App resolves the current item-level Grant, generates a fresh code when needed,
        and types the value directly into Chrome. The tool result only confirms that the field was
        filled.
      </P>
      <P>
        Autofill is bound to the login&apos;s exact saved origin: scheme, host, and port must match
        on both the top page and target frame. The stored password is accepted only into an input
        with <Code>type=password</Code>, while a current authenticator code goes only into an
        ordinary sign-in input; API keys and secure-note bodies are not Browser-fill sinks. A
        missing or revoked Grant fails closed. Browser access and the host allow list still apply
        independently, so a Vault Grant cannot turn the Browser on or widen where it may navigate.
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
      <P>
        If the site offers TOTP during signup, the employee first calls{" "}
        <Code>browser_prepare_vault_totp</Code> on its AI-created Login, then asks the site to reveal
        enrollment. This immediately redacts screenshots and model-visible page text. The employee
        then calls{" "}
        <Code>browser_save_vault_totp</Code> on the same-origin setup key, authenticator QR image, or
        containing element. Genosyn validates and encrypts the setup server-side; neither the setup
        key nor a generated code appears in model output. A Member can also paste a shown Base32 key
        or <Code>otpauth://</Code> URI through the Vault editor.
      </P>
      <P>
        A Vault passkey is created inside Genosyn rather than imported from a person&apos;s device.
        <Code>browser_create_vault_passkey</Code> takes the site&apos;s Create passkey control and
        performs registration, capture, encryption, and browser cleanup as one bounded action. On a
        later login, <Code>browser_use_vault_passkey</Code> takes the site&apos;s sign-in control, loads
        only that granted RP-bound credential, completes the assertion, persists its updated
        signature counter, and removes it from Chrome before returning. No private key enters the
        MCP child, model context, transcript, audit detail, or log.
      </P>
      <Callout kind="warn" title="Software passkeys are not human authenticators">
        Vault passkeys are encrypted software credentials. They do not use Touch ID, Face ID, a
        password manager, or a hardware security key, and they cannot satisfy a site that requires
        hardware-backed attestation or real human verification. All TOTP/passkey capture and use is
        refused in <DocLink to="/docs/member-browsers">Member browsers</DocLink>.
      </Callout>

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
      <P>
        For a TOTP-protected form, use <Code>browser_submit_with_vault_totp</Code>. It queues the
        Approval while the one-time-code field is still empty, then generates and fills a fresh code
        only after the approved action is claimed and submits immediately. This avoids an expired
        code or a changed form fingerprint while the Member is reviewing the Approval.
      </P>

      <H2 id="live-view">Live view and takeover</H2>
      <P>
        While the employee browses, the chat panel shows the page live. Click{" "}
        <Strong>Take over</Strong> to drive it yourself — your mouse and keyboard go straight to the
        same Chrome. Use Vault actions for a granted password, authenticator code, or software
        passkey; take-over remains the fallback for a credential not in the Vault, captchas,
        hardware-bound passkeys, and unsupported challenges. The employee navigates to the right
        page, you complete the human-only step, and the employee carries on. The browser is never
        torn down while someone is watching.
      </P>
      <P>
        Taking over also unlocks the <Strong>address bar</Strong> above the page, along with back,
        forward and reload. Type a URL and press Enter to go somewhere the employee did not — useful
        when a sign-in bounces you to a settings page the model never opened. <Code>Ctrl</Code>/
        <Code>⌘</Code>+<Code>L</Code> focuses it, as it would in a real browser. It is the same
        Chrome carrying the same cookies, so the address bar answers to the same{" "}
        <a href="#allow-list">allow list</a> <Code>browser_open</Code> does: a host the company
        excluded is refused here too, with the reason shown under the bar. While you are only
        watching, the bar shows the current URL and nothing else.
      </P>
      <P>
        Live view is ephemeral in Chat. A <DocLink to="/docs/routines">Routine Run</DocLink> that
        actually uses a browser is different: Genosyn automatically saves a silent visual MP4 of
        each Run-linked browser session and shows it beside that Run&apos;s log. Merely giving the
        employee Browser access does not create a recording; capture starts only when the session
        opens the browser. Parallel delegated browser work produces separate recordings, and none of
        them contain page audio.
      </P>
      <Callout kind="warn" title="A recording shows the whole screen">
        Visual recording captures everything rendered in the browser viewport, including a login
        form mid-sign-in and a TOTP enrollment page mid-reveal. Nothing is cut out of it, so a
        recording is limited to the people accountable for that work: for Genosyn&apos;s browser,
        company owners and admins plus the Member the AI Employee reports to; for a Member browser,
        that browser&apos;s exact owner and nobody else. What the <em>AI Employee</em> sees is
        separate and stays redacted — screenshots and page text scrub Vault values either way.
      </Callout>

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
        That snapshot is written whenever a session is torn down — including on <Code>SIGTERM</Code>
        , so stopping or updating the container flushes every live browser before it exits rather
        than dropping whatever the session had learned since it started. Page loads also trigger a
        debounced save, which bounds what an ungraceful kill can cost to the last page. Two things
        are deliberately <Strong>not</Strong> kept: IndexedDB and service-worker storage, so a site
        that keys its auth off those needs a fresh sign-in; and Chrome&apos;s own profile directory,
        which is new on every launch, so the HTTP cache always starts cold.
      </P>
      <P>
        Vault passkeys do not depend on Chrome&apos;s profile directory. Their encrypted credential
        material lives with the Login in the database and is loaded into a temporary software
        authenticator only for a granted, exact-RP Browser action.
      </P>
      <P>
        Saved Routine recordings are separate from browser state. They live under{" "}
        <Code>.private/browser-recordings/&lt;company-id&gt;/&lt;run-id&gt;/</Code> in the data
        directory, outside the AI Employee&apos;s working tree. They remain with Run history, are
        included in whole-instance backups, and are removed when the owning Routine or company is
        deleted. Chat sessions are not recorded.
      </P>
      <P>
        That per-employee session is also what a sign-in driven from the{" "}
        <DocLink to="/docs/vault">Vault</DocLink> uses. When a site challenges a sign-in with a
        captcha or an authenticator not attached to the Login, the fix is to take over here and sign
        in once — the employee picks up the session you established and stops failing.
      </P>

      <H2 id="runtime">The browser it actually runs</H2>
      <P>
        The App image ships <Strong>real Google Chrome</Strong> — the same build Google publishes
        for Debian, on both x86-64 and ARM — and runs it <Strong>headed</Strong> against a virtual
        display started by the container&apos;s entrypoint. That is a deliberate anti-blocking
        choice, not an implementation detail.
      </P>
      <P>
        App-owned Chrome opens in a larger <Strong>1600 × 1000</Strong> window. The page&apos;s
        usable viewport is slightly shorter because Chrome keeps its normal browser controls. A
        Member browser keeps the real size of its window instead. The live preview scales the
        whole page to fit: drag the panel&apos;s left edge wider or use <Strong>Open in new tab</Strong>
        when you want a larger view. Routine recordings stay capped at 1280 × 800 and preserve
        the page&apos;s aspect ratio, so the larger working area does not increase recording storage.
      </P>
      <P>
        Sites rarely detect &quot;automation&quot; as such. They detect{" "}
        <Strong>contradictions</Strong>: a browser claiming to be Chrome on macOS while its fonts,
        GPU strings and <Code>navigator.platform</Code> all say headless Chromium on Linux. Genosyn
        used to ship exactly that — a Chromium wearing a hand-written costume — and the costume was
        what got it challenged. A real Chrome needs no costume, so there is none to catch out: its
        user agent, client hints, font list and renderer strings agree with each other because they
        are all simply true.
      </P>
      <P>
        Genosyn still never solves a captcha and never defeats a challenge. This only removes{" "}
        <em>false</em> signals from a browser doing legitimate work. If a site challenges the
        employee anyway, the answer is still a human: take over here, or use a{" "}
        <DocLink to="/docs/member-browsers">Member browser</DocLink>.
      </P>
      <P>
        Nothing here needs configuring. The knobs exist in <Code>config.ts</Code> under{" "}
        <Code>browser</Code> if you need them — a different Chrome binary, forced headless on a host
        that cannot run a virtual display, or a locale and timezone matching where your deployment
        egresses from. Leave them empty and Chrome tells the truth about itself, which is the
        setting you want. A source-managed install on a host with no Chrome falls back to whatever
        Chromium it finds, and only then does a compatibility layer start filling in the
        differences.
      </P>
      <Callout kind="info" title="Checking the profile">
        A master admin can <Code>POST /api/admin/browser-self-test</Code> to launch the real profile
        and have it checked for self-contradictions — user agent against platform, client hints
        against user agent, fonts, renderer, and whether any compatibility patch is detectable as a
        patch. Worth running after a Chrome upgrade or an image rebuild; it is the difference
        between finding a regression now and finding it when a Routine fails at 3am.
      </Callout>

      <Callout title="Reserved name">
        <Code>browser</Code> is a reserved MCP server name — a user-configured server with that name
        is ignored so it can&apos;t shadow the built-in tools. See{" "}
        <DocLink to="/docs/models">AI Models</DocLink> for how the tool list is assembled.
      </Callout>
    </>
  );
}
