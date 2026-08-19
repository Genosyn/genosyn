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

export function Vault() {
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Vault"
        lead={
          <>
            Keep company logins, API keys, and secure notes in one encrypted password manager for
            Members and AI Employees. People can reveal a value when they need it; AI Employees use
            credentials through governed server-side actions that keep plaintext out of model output
            and Run transcripts.
          </>
        }
      />

      <Callout kind="info" title="The Vault is not Settings → Secrets">
        Vault items are credentials people and AI Employees use deliberately, with access set on
        each item. <Strong>Settings → Secrets</Strong> holds environment variables for coding tools
        and Pipelines. Those values are injected by name and do not appear in the Vault. See{" "}
        <DocLink to="/docs/self-hosting#secrets">Configuration</DocLink> for the full distinction.
      </Callout>

      <H2 id="add">Add a Vault item</H2>
      <OL>
        <LI>
          Open <Strong>Vault</Strong> from the company navigation and choose{" "}
          <Strong>Add item</Strong>.
        </LI>
        <LI>
          Choose <Strong>Login</Strong>, <Strong>API key</Strong>, or <Strong>Secure note</Strong>.
          Add a clear title and the fields that belong to that type. Login and API-key items can
          also carry a website and private context.
        </LI>
        <LI>
          For a login, paste an existing password or choose{" "}
          <Strong>Generate strong password</Strong>. Copy a generated password before saving when
          you also need to enter it somewhere outside Genosyn.
        </LI>
        <LI>
          Choose whether every Member in the company may view the item or only selected Members may.
          Save it, then open <Strong>Access</Strong> to add people or AI Employees.
        </LI>
      </OL>
      <P>
        The list and detail screens show the title, username, website, type, and private context
        only to Members who can access the item. The stored password, API key, or secure-note body
        stays masked until someone explicitly chooses <Strong>Reveal</Strong> or{" "}
        <Strong>Copy</Strong>. Editing an item never loads the current stored value into the form;
        leave the value blank to keep it, or enter a replacement to rotate it.
      </P>

      <H2 id="members">Member access</H2>
      <P>
        A Vault item has either <Strong>Everyone in the company</Strong> visibility or{" "}
        <Strong>Only selected Members</Strong> visibility. Restricted items are absent from other
        Members&apos; lists instead of advertising that a hidden credential exists. The creator and
        company owners or admins can always manage sharing and deletion.
      </P>
      <KeyList
        rows={[
          {
            term: "View",
            def: "Open the item, read its encrypted metadata and private context, and deliberately reveal or copy the stored value.",
          },
          {
            term: "Edit",
            def: "Everything in View, plus change fields and replace the stored value. It does not confer sharing or deletion control.",
          },
        ]}
      />
      <P>
        Company-wide visibility affects Members only. It never gives an AI Employee access. Every AI
        Employee starts with no Vault access and needs a separate item-level Grant.
      </P>

      <H2 id="ai-access">AI Employee Grants</H2>
      <P>
        Open a Vault item&apos;s <Strong>Access</Strong> panel and add only the AI Employees that
        need it. Grants are independent per item, so access to one GitHub login does not expose
        another login or anything else in the company Vault.
      </P>
      <KeyList
        rows={[
          {
            term: "Use",
            def: (
              <>
                Discover safe item metadata. For a Login, use server-side Browser autofill for its
                username or password without returning plaintext to the model. A stored password can
                go only into a password input; API-key values and secure-note bodies have no AI
                plaintext-read or Browser-fill path.
              </>
            ),
          },
          {
            term: "Manage",
            def: (
              <>
                Everything in Use, plus update a login&apos;s title, username, and private context.
                The saved website origin cannot be rebound by an AI Employee. Manage also cannot
                reveal, rotate, or delete the stored password. A login an employee creates receives
                this level automatically.
              </>
            ),
          },
        ]}
      />
      <Callout kind="tip" title="Start with Use">
        Use is enough for an employee that signs in to an existing account. Reserve Manage for an
        employee expected to maintain the login&apos;s safe metadata, and remove the Grant when that
        work is finished. Grant checks happen again at the moment of use, so revocation fails
        closed.
      </Callout>
      <Callout kind="info" title="Coding is isolated or disabled by mode">
        A working directory alone cannot contain a same-user shell: it could read the Vault
        database, installation encryption key, or another Browser session. So <Code>bash</Code> is
        available only in a working Linux bubblewrap deployment — the default — and nowhere else:
        where that sandbox cannot start, boot falls back to disabled mode, which exposes no coding
        tools at all. Genosyn gives AI Employees in separately acknowledged host mode only
        path-confined file and search tools. This boundary applies even to an employee with no
        Vault Grants.
      </Callout>
      <P>
        With Manage, <Code>update_vault_login</Code> can change the title, username, or private
        context while preserving both the encrypted password and saved website origin. Website
        rebinding, password rotation, and deletion remain deliberate Member actions in the Vault.
      </P>

      <H2 id="browser">Sign in without showing the model a password</H2>
      <P>
        With the <DocLink to="/docs/browser">built-in Browser</DocLink> enabled, an AI Employee can
        complete a login without asking a Member to paste a password into Chat:
      </P>
      <OL>
        <LI>
          <Code>list_vault_items</Code> returns only granted item ids and safe metadata. It never
          returns the password, API key, or secure-note body.
        </LI>
        <LI>The employee opens the website saved on the login item.</LI>
        <LI>
          <Code>browser_fill_vault</Code> asks the App to resolve a granted username or password and
          fill the selected field directly in App-owned Chrome. The top page and target frame must
          both match the item&apos;s exact saved origin — scheme, host, and port. A password is
          accepted only from a Login item and only into an input with <Code>type=password</Code>.
        </LI>
      </OL>
      <P>
        Browser access and the employee&apos;s host allow list remain independent gates: a Vault
        Grant cannot enable the Browser or widen its browsing policy. The plaintext exists only at
        the server-side credential-to-browser boundary. It is not serialized into the tool response,
        model context, Run transcript, audit detail, or log. Captchas and 2FA can still use the
        Browser&apos;s human take-over flow.
      </P>
      <P>
        Browser snapshots redact password-input values, including values inside frames, before the
        model sees them. After the session has observed or filled a password, model-requested
        screenshots are refused; use the redacted structural snapshot instead.
      </P>
      <Callout kind="info" title="A Member session cannot become AI authority">
        A Member session used inside App-owned Chrome is marked as an AI Browser request. The App
        rejects every Genosyn API request from that browser, even when the stored cookies belong to
        an owner or admin. This also prevents settings, API keys, invitations, and role changes from
        becoming a route back to Vault authority. AI Employees must use their own item-level Grants
        and <Code>browser_fill_vault</Code>.
      </Callout>

      <H2 id="create">Let an AI Employee create a login safely</H2>
      <P>
        AI Employees can store new credentials without first learning the password in model context.{" "}
        <Code>create_vault_login</Code> generates a strong password inside Genosyn, encrypts it
        immediately, creates a company-visible login, and gives the creating employee a Manage
        Grant. Members can therefore recover the credential, while other AI Employees still receive
        no access. The employee can then use <Code>browser_fill_vault</Code> to enter that generated
        value into a signup or password-change form.
      </P>
      <P>
        When a website or browser flow already put a password into an input,{" "}
        <Code>browser_save_vault_login</Code> can request capture from a same-origin password input.
        Capture always needs approval from a company owner or admin, even when ordinary Browser form
        submissions do not require approval. Once approved, the App saves a restricted Vault item
        bound to the exact current origin and gives the employee a Manage Grant. The password is not
        read back or included in model output. Other Members do not see the restricted item until an
        owner or admin changes its visibility or Member access.
      </P>

      <H2 id="audit">Reveal, copy, and audit</H2>
      <P>
        Revealing and copying are separate, explicit Member actions. Each one writes a company audit
        event identifying the Member, Vault item, action, and time, without recording the secret
        itself. Creating, updating, deleting, sharing, granting, and AI use are audited too. Review
        the history under <Strong>Settings → Audit log</Strong> when investigating access or
        rotating a credential.
      </P>
      <UL>
        <LI>Do not paste a Vault value into Chat; Grant the item and use a governed action.</LI>
        <LI>
          Save the intended website origin on login items. Browser autofill requires the top page
          and target frame to match its scheme, host, and port exactly.
        </LI>
        <LI>
          Back up the whole data directory so the database and any managed instance-secret file stay
          together. Rotating <Code>security.encryptionSecret</Code> follows the same key-ring
          procedure as other encrypted company data.
        </LI>
      </UL>
    </>
  );
}
