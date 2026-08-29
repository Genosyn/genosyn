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
            Keep company logins, their authenticator codes and software passkeys, API keys, and
            secure notes in one encrypted password manager for Members and AI Employees. People can
            deliberately reveal supported values when they need them; AI Employees use credentials
            through governed server-side actions that keep plaintext and private keys out of model
            output and Run transcripts.
          </>
        }
      />

      <Callout kind="info" title="The Vault is not Settings → Secrets">
        Vault items are credentials people and AI Employees use deliberately, with access set on
        each item. <Strong>Settings → Secrets</Strong> holds environment variables for coding tools
        and Pipelines. Those values are injected by name and do not appear in the Vault. See{" "}
        <DocLink to="/docs/self-hosting#secrets">Configuration</DocLink> for the full distinction.
      </Callout>

      <P>
        The Vault is where a credential belongs when no first-class{" "}
        <DocLink to="/docs/integrations">Integration</DocLink> covers the service — an API with no
        connector, or a site an AI Employee has to sign in to.
      </P>
      <P>
        A retired connector&apos;s secret is already here. Upgrading to 1.132.0 moved each one into a
        restricted secure note named <Code>&lt;Connector&gt; (retired Integration)</Code>, holding
        the connector&apos;s configuration, and removed the dead Connection. Company owners and
        admins can <Strong>Reveal</Strong> it; the only step left is sharing it, or granting it to
        the AI Employees that were using the connector.
      </P>
      <Callout>
        A retired Connection still listed under <Strong>Settings → Integrations</Strong> is one whose
        credential could <Strong>not</Strong> be decrypted during the upgrade, so it was deliberately left
        alone. That row holds the only copy — restore the previous encryption key before
        disconnecting it, or the value is gone.
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
          Optionally attach an authenticator by pasting its Base32 setup key or complete{" "}
          <Code>otpauth://</Code> URI. Leave the field blank while editing to keep the current
          authenticator. Software passkeys are created from an AI Employee&apos;s Browser flow, not
          imported through this form.
        </LI>
        <LI>
          Choose whether every Member in the company may view the item or only selected Members may.
          Save it, then open <Strong>Access</Strong> to add people or AI Employees.
        </LI>
      </OL>
      <P>
        The list and detail screens show the title, username, website, type, private context, and
        whether a login has authenticator codes or passkeys only to Members who can access the item.
        The stored password, API key, or secure-note body stays masked until someone explicitly
        chooses <Strong>Reveal</Strong> or <Strong>Copy</Strong>. A current authenticator code is
        generated only when someone chooses <Strong>Show</Strong> or <Strong>Copy code</Strong>, and
        auto-hides when it expires. Editing never loads an existing password or authenticator setup
        key into the form; leave either field blank to keep it.
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
                username, password, or current authenticator code without returning plaintext to the
                model, or use one of its software passkeys in Genosyn&apos;s browser. Passwords and
                codes go only into matching sign-in inputs, and passkey private keys never cross the
                browser boundary. API-key values and secure-note bodies have no AI plaintext-read or
                Browser-fill path.
              </>
            ),
          },
          {
            term: "Manage",
            def: (
              <>
                Everything in Use, plus update a login&apos;s title, username, and private context.
                The saved website origin cannot be rebound by an AI Employee. Manage also cannot
                reveal, rotate, or delete the stored password, authenticator setup key, or passkey
                material. A login an employee creates receives this level automatically, which also
                lets it capture authenticators during that signup flow.
              </>
            ),
          },
        ]}
      />
      <Callout kind="tip" title="Start with Use">
        Use is enough for an employee that signs in to an existing account, including with a current
        authenticator code or saved software passkey. Reserve Manage for an employee expected to
        maintain the login&apos;s safe metadata or add authenticators, and remove the Grant when
        that work is finished. Grant checks happen again at the moment of use, so revocation fails
        closed.
      </Callout>
      <Callout kind="info" title="Coding is isolated or disabled by mode">
        A working directory alone cannot contain a same-user shell: it could read the Vault
        database, installation encryption key, or another Browser session. So <Code>bash</Code> is
        available only in a working Linux bubblewrap deployment — the default — and nowhere else:
        where that sandbox cannot start, boot falls back to disabled mode, which exposes no coding
        tools at all. Genosyn gives AI Employees in separately acknowledged host mode only
        path-confined file and search tools. This boundary applies even to an employee with no Vault
        Grants.
      </Callout>
      <P>
        With Manage, <Code>update_vault_login</Code> can change the title, username, or private
        context while preserving the encrypted credentials and saved website origin. Website
        rebinding, password rotation, authenticator removal, passkey deletion, and login deletion
        remain deliberate Member actions in the Vault.
      </P>

      <H2 id="browser">Sign in without showing the model a password</H2>
      <P>
        With the <DocLink to="/docs/browser">built-in Browser</DocLink> enabled, an AI Employee can
        complete a login without asking a Member to paste a password into Chat:
      </P>
      <OL>
        <LI>
          <Code>list_vault_items</Code> returns only granted item ids and safe metadata, including
          whether a Login has an authenticator or passkeys. It never returns a password, setup key,
          current code, passkey private key, API key, or secure-note body.
        </LI>
        <LI>The employee opens the website saved on the login item.</LI>
        <LI>
          <Code>browser_fill_vault</Code> asks the App to resolve a granted username, password, or
          current authenticator code and fill the selected field directly in App-owned Chrome. The
          top page and target frame must both match the item&apos;s exact saved origin — scheme,
          host, and port. A password is accepted only into <Code>type=password</Code>; a current
          code is generated at the last possible moment and goes only into an ordinary sign-in
          input.
        </LI>
        <LI>
          For passkey sign-in, <Code>browser_use_vault_passkey</Code> loads only the selected
          origin-bound credential into Genosyn&apos;s software authenticator. The site performs its
          normal WebAuthn assertion and the updated signature counter returns to encrypted storage.
        </LI>
      </OL>
      <P>
        Browser access and the employee&apos;s host allow list remain independent gates: a Vault
        Grant cannot enable the Browser or widen its browsing policy. Sensitive values exist only at
        the server-side credential-to-browser boundary. They are not serialized into the tool
        response, model context, Run transcript, audit detail, or log. Captchas, hardware-bound
        credentials, and unsupported challenges can still use the Browser&apos;s human take-over
        flow.
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
      <P>
        During authenticator enrollment, <Code>browser_prepare_vault_totp</Code> first binds an
        AI-created Login to the exact origin and redacts screenshots and model-visible page text
        before the secret appears. <Code>browser_save_vault_totp</Code> then reads the selected same-origin
        setup key, authenticator QR image, or containing element. Genosyn validates and encrypts it
        server-side. Later,{" "}
        <Code>browser_fill_vault</Code> with the <Code>totp</Code> field generates and fills a
        current code without returning the setup key or code. For approval-gated forms,{" "}
        <Code>browser_submit_with_vault_totp</Code> generates that code only after Approval is
        claimed and submits it immediately. A QR format Genosyn cannot decode still needs take-over
        or manual setup-key entry in the Vault editor.
      </P>
      <P>
        Passkeys use bounded Browser ceremonies. <Code>browser_create_vault_passkey</Code> triggers
        the selected registration control, captures and encrypts the resulting credential, and
        removes the temporary authenticator before returning. <Code>browser_use_vault_passkey</Code>{" "}
        similarly restores one granted credential only for the selected sign-in action, saves its
        updated counter, and removes it before returning. These tools are refused in Member browsers
        and never access Touch ID, Face ID, a password-manager passkey, or a hardware security key.
      </P>
      <Callout kind="warn" title="A Vault passkey is a software credential">
        A Vault passkey is portable because Genosyn encrypts the private key in its database and
        presents it through an App-owned virtual authenticator. It is not hardware-bound and does
        not prove that a human touched a biometric sensor or security key. Some sites require those
        properties and will refuse this flow.
      </Callout>
      <Callout kind="warn" title="Remove authenticators at both ends">
        Replacing or deleting an authenticator in the Vault does not change the external account.
        Removing a setup key or passkey before another sign-in method works can lock everyone out.
        Update or remove it on the external site too.
      </Callout>

      <H2 id="audit">Reveal, copy, and audit</H2>
      <P>
        Revealing and copying are separate, explicit Member actions. Each one writes a company audit
        event identifying the Member, Vault item, action, and time, without recording the secret
        itself. Creating, updating, deleting, sharing, granting, and AI use are audited too. Review
        the history under <Strong>Settings → Audit log</Strong> when investigating access or
        rotating a credential.
      </P>
      <Callout kind="info" title="The Audit log page is gated.">
        Reading the Audit log needs the Scale plan on Genosyn Cloud, or a Genosyn Enterprise
        license self-hosted — events are recorded regardless. See{" "}
        <DocLink to="/docs/plans-billing" /> and <DocLink to="/docs/enterprise-license" />.
      </Callout>
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
