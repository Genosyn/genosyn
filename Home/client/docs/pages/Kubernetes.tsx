import {
  Callout,
  Code,
  DocLink,
  ExtLink,
  H2,
  H3,
  KeyList,
  LI,
  P,
  PageHeader,
  Pre,
  Strong,
  UL,
} from "@/docs/Prose";

export function Kubernetes() {
  return (
    <>
      <PageHeader
        eyebrow="Self-hosting"
        title="Kubernetes"
        lead={
          <>
            Genosyn ships an official Helm chart at{" "}
            <Code>oci://ghcr.io/genosyn/charts/genosyn</Code>, versioned in lockstep with every
            release. Use Helm for upgrades and your cluster&apos;s backup system for storage.
          </>
        }
      />

      <Callout kind="warn" title="Only if you already run a cluster.">
        For most self-hosters, single-host Docker is the right answer — it&apos;s what the
        installer, the CLI, and the docs are built around. Reach for Kubernetes when you already
        operate one and want Genosyn to live next to your other workloads. Don&apos;t stand up a
        cluster for this app.
      </Callout>

      <H2 id="helm">Install with Helm</H2>
      <P>
        The chart is an OCI artifact — no repo to add — and it is also listed on{" "}
        <ExtLink href="https://artifacthub.io/packages/search?ts_query_web=genosyn">
          Artifact Hub
        </ExtLink>
        :
      </P>
      <Pre lang="bash">{`helm install genosyn oci://ghcr.io/genosyn/charts/genosyn \\
  --namespace genosyn --create-namespace \\
  --set config.bootstrapMasterAdminEmail=operator@example.com \\
  --set ingress.enabled=true --set ingress.host=genosyn.example.com \\
  --set ingress.tls.enabled=true --set ingress.tls.secretName=genosyn-tls`}</Pre>
      <P>
        The default chart enables shared SaaS mode, bundled Postgres, and the coding sandbox, with
        one replica and a 20Gi volume at <Code>/app/data</Code>. Supply your own operator email,
        hostname, and TLS Secret. Private installations can use the repository&apos;s{" "}
        <Code>Helm/genosyn/values-selfhost.yaml</Code> overlay for SQLite and single-tenant mode.
        The pod becomes Ready once every migration has run — <Code>/api/health</Code> answers{" "}
        <Code>{"{ ok: true, version }"}</Code> only after boot completes, so a pending readiness
        probe during the first minute is normal. The handful of values that matter:
      </P>
      <KeyList
        rows={[
          {
            term: "ingress.enabled + ingress.host",
            def: (
              <>
                Front the app with your Ingress controller. WebSockets share port <Code>8471</Code>{" "}
                and pass through a plain Ingress rule on nginx and Traefik — no snippet annotations
                needed.
              </>
            ),
          },
          {
            term: "persistence.size",
            def: (
              <>
                The <Code>/app/data</Code> volume — 20Gi by default. Keep it even on Postgres
                installs: it holds checkouts, browser state, artifacts, and uploads. The chart
                stores instance secrets in a separate Kubernetes Secret.
              </>
            ),
          },
          {
            term: "config.db.driver",
            def: (
              <>
                <Code>sqlite</Code> or <Code>postgres</Code>. For an external Postgres, point{" "}
                <Code>config.db.postgresUrlSecret</Code> at a Secret holding the full connection
                URL.
              </>
            ),
          },
          {
            term: "postgres.enabled",
            def: "Bundled single-node Postgres for evaluation (implies driver: postgres). No HA, no backups — production installs run their own.",
          },
          {
            term: "sandbox.enabled",
            def: (
              <>
                Grants the securityContext that bubblewrap needs. On in the chart&apos;s shared SaaS
                default; off in <Code>values-selfhost.yaml</Code>, which uses host coding. See the
                execution-mode callout below for cluster requirements.
              </>
            ),
          },
          {
            term: "secrets.existingSecret",
            def: (
              <>
                A Secret with <Code>sessionSecret</Code> and <Code>encryptionSecret</Code> keys
                (each 32+ characters, distinct). When omitted, the chart generates a durable Secret
                and preserves it across upgrades and uninstall. Back it up with the database.
              </>
            ),
          },
        ]}
      />
      <P>
        Upgrades are plain Helm — the chart version tracks the app version, so upgrading the chart
        upgrades Genosyn:
      </P>
      <Pre lang="bash">{`helm upgrade genosyn oci://ghcr.io/genosyn/charts/genosyn \\
  -n genosyn --reuse-values`}</Pre>
      <P>
        The full values reference, the multi-tenant checklist, and the sandbox details live in the
        chart&apos;s README in the <Code>Helm/genosyn</Code> directory of the repository. The rest
        of this page explains what the chart deploys and how to operate it.
      </P>

      <H2 id="saas-deploy">Test and production SaaS deployments</H2>
      <P>
        From the repository root, use <Code>Helm/Values/test.values.yaml</Code> and{" "}
        <Code>Helm/Values/prod.values.yaml</Code> with the npm commands below. Supply the cluster,
        DNS, and certificates separately; each profile includes Postgres. Private values are
        excluded from Git and Docker builds. Restore them from private storage on a new checkout.
      </P>
      <UL>
        <LI>
          <Strong>Test:</Strong> <Code>test.genosyn.com</Code>, namespace <Code>genosyn-test</Code>,
          TLS Secret <Code>genosyn-test-tls</Code>, and bundled Postgres for evaluation.
        </LI>
        <LI>
          <Strong>Production:</Strong> <Code>app.genosyn.com</Code>, namespace{" "}
          <Code>genosyn-prod</Code>, TLS Secret <Code>genosyn-prod-tls</Code>, and a single-node
          Postgres database with a 100Gi volume. The same App and Ingress serve{" "}
          <Code>connect.genosyn.com</Code> using <Code>genosyn-connect-tls</Code>; that host exposes
          only the <Code>/api/connect</Code> namespace and six legacy Gmail sign-in paths. Both
          domains share one address.
        </LI>
      </UL>
      <P>
        Both profiles enable SaaS security and the sandbox. They use one replica,{" "}
        <Code>Recreate</Code>, and a persistent <Code>ReadWriteOnce</Code> volume from the
        cluster&apos;s default StorageClass. Select your ingress controller with{" "}
        <Code>ingress.className</Code>, or leave it empty for the cluster default. The chart uses
        standard Kubernetes resources; configure HTTPS redirects, WebSockets, streaming timeouts,
        and query-string-free access logs in your ingress infrastructure. Controller settings can
        pass through <Code>ingress.annotations</Code> and <Code>service.annotations</Code>.
        Kubernetes probes still use <Code>/api/health</Code>. The App trusts one HTTP proxy hop by
        default; adjust <Code>trustedProxyHops</Code> through <Code>config.extraJs</Code> to match
        your proxy chain, and keep the App port private. Supply TLS and a suitable StorageClass; the
        cluster must support the sandbox, and production needs backups. Helm creates Secrets from
        each profile&apos;s private <Code>secrets.sessionSecret</Code>,{" "}
        <Code>secrets.encryptionSecret</Code>, and <Code>postgres.password</Code>. Keep these values
        stable and back them up with the database; deployment previews omit Secret documents.
      </P>
      <P>
        Set <Code>config.bootstrapMasterAdminEmail</Code> in your local profile or pass{" "}
        <Code>GENOSYN_BOOTSTRAP_ADMIN_EMAIL</Code>. Deployment requires an explicit operator email.
        Commands deploy the published image named by <Code>VERSION</Code>; they do not build or
        publish it. Use <Code>GENOSYN_IMAGE_TAG</Code> for another release or a pinned{" "}
        <Code>sha-</Code> commit tag. Preview before deploying:
      </P>
      <Pre lang="bash">{`GENOSYN_BOOTSTRAP_ADMIN_EMAIL=operator@example.com npm run template-deploy-test
GENOSYN_BOOTSTRAP_ADMIN_EMAIL=operator@example.com npm run template-deploy-prod

GENOSYN_TEST_KUBE_CONTEXT=your-test-context GENOSYN_BOOTSTRAP_ADMIN_EMAIL=operator@example.com npm run deploy-test
GENOSYN_PROD_KUBE_CONTEXT=your-prod-context GENOSYN_BOOTSTRAP_ADMIN_EMAIL=operator@example.com npm run deploy-prod`}</Pre>
      <P>
        The commands require Node 22, Helm, kubectl, and access through your existing kubeconfig.
        Set the environment&apos;s context as above, or use <Code>GENOSYN_KUBE_CONTEXT</Code> for a
        one-command override. Live deployments require an explicit context and never change your
        current context. Standard <Code>KUBECONFIG</Code> settings and your cluster&apos;s
        credential plugins work as usual; offline previews need no cluster access.
      </P>
      <P>
        Deployment waits for App readiness, then initializes the stored HTTPS public URL for a fresh
        database. It does not replace an existing different URL; change that at{" "}
        <Code>Admin → General</Code>. Verify DNS and HTTPS before opening registration, then verify
        the configured operator and set <Code>Admin → Email transport</Code> for verification and
        recovery messages. OAuth apps belong at <Code>Admin → Integrations</Code>. Private{" "}
        <Code>billing</Code> values initialize Stripe on first setup; see{" "}
        <DocLink to="/docs/plans-billing#operators">billing setup</DocLink>. Edit saved settings at{" "}
        <Code>Admin → Billing</Code>. Keep the public URL at <Code>https://app.genosyn.com</Code>.
        For hosted sign-in, set{" "}
        <Strong>Admin → Runtime → Hosted sign-in → Hosted sign-in address</Strong> to{" "}
        <Code>https://connect.genosyn.com</Code> before enabling hosting. Register Google&apos;s new{" "}
        <Code>https://connect.genosyn.com/api/connect/google/callback</Code> alongside the
        App&apos;s ordinary Google redirect URI; retain the legacy{" "}
        <Code>/api/google-sign-in/callback</Code> for older installations. Test leaves the extra
        host off. See <DocLink to="/docs/saas-hosting">shared SaaS setup</DocLink> for these final steps.
      </P>
      <P>
        New profiles use <Code>ingress.connect.enabled</Code>, <Code>host</Code>, and{" "}
        <Code>tlsSecretName</Code>. Existing <Code>ingress.gmailSignIn</Code> values remain
        supported; each supplied <Code>connect</Code> field overrides its legacy counterpart,
        including <Code>enabled: false</Code>. Unspecified fields inherit the legacy value.
        The Connect host shares the App Service and requires its own TLS Secret and a distinct
        hostname. Its <Code>/api/connect</Code> prefix accommodates future providers without
        ingress changes, while App and administration pages remain on the primary host.
      </P>

      <H2 id="architecture">Architecture</H2>
      <P>
        Genosyn runs one App container per replica. Everything that needs to survive a restart is
        either in Postgres or under <Code>/app/data</Code>:
      </P>
      <UL>
        <LI>
          <Strong>Deployment.</Strong> Keep ordinary self-hosted installs at one replica. Shared
          SaaS mode supports multiple replicas through Postgres leases, database-backed auth flow
          state, and cross-replica realtime fan-out; follow{" "}
          <DocLink to="/docs/saas-hosting">Shared SaaS mode</DocLink>.
        </LI>
        <LI>
          <Strong>PersistentVolumeClaim</Strong> at <Code>/app/data</Code> (ReadWriteOnce is fine
          for one replica; use ReadWriteMany when scaling). Holds materialized git checkouts,
          browser state, tool artifacts, and uploaded attachments. Model and Connection credentials
          stay encrypted in Postgres.
        </LI>
        <LI>
          <Strong>External Postgres.</Strong> SaaS requires Postgres; private installations can
          persist SQLite on the data volume. Run Postgres in-cluster (a separate Helm chart,
          CloudNativePG, Zalando, …) or point at a managed instance.
        </LI>
        <LI>
          <Strong>Secret with config overrides.</Strong> Genosyn&apos;s config is a bundled
          TypeScript object; on Kubernetes you overlay it at runtime — see below.
        </LI>
        <LI>
          <Strong>Service + Ingress.</Strong> The container listens on <Code>8471</Code>. Front it
          with whatever Ingress controller you already run.
        </LI>
      </UL>

      <H2 id="by-hand">Doing it by hand</H2>
      <P>
        Render <Code>Helm/genosyn/templates</Code> for the maintained manifests when using GitOps.
      </P>

      <H2 id="prerequisites">Prerequisites</H2>
      <KeyList
        rows={[
          {
            term: "Cluster",
            def: "A cluster that permits the sandbox securityContext and user namespaces. Confirm support before deploying shared SaaS; it refuses to start without a working sandbox.",
          },
          {
            term: "Postgres",
            def: (
              <>
                Reachable from the cluster. Genosyn runs every migration on boot, so an empty
                database is fine.
              </>
            ),
          },
          {
            term: "StorageClass",
            def: (
              <>
                One that supports <Code>ReadWriteOnce</Code>. The default class on every managed
                cluster qualifies.
              </>
            ),
          },
          {
            term: "Ingress",
            def: "nginx, Traefik, or your cloud's controller — anything that can route HTTPS to a ClusterIP Service.",
          },
        ]}
      />

      <H2 id="config-override">Overriding config</H2>
      <P>
        <Code>App/config.ts</Code> is compiled into the image at build time, so the live process
        reads <Code>/app/dist/config.js</Code>. To change values without rebuilding, mount a{" "}
        <Code>ConfigMap</Code> over that path. The mount <em>replaces</em> the whole object, so
        every key the server still reads has to be present — which is a short list, because the
        compiled shape mirrors <DocLink to="/docs/self-hosting">the source</DocLink> exactly and
        that file is boot configuration only. Start from{" "}
        <Code>Helm/genosyn/templates/configmap.yaml</Code> to retain the complete current shape.
      </P>
      <Callout kind="tip" title="Why process.env here is fine.">
        Genosyn doesn&apos;t use <Code>dotenv</Code> or per-environment files, but the config object
        is plain JavaScript at runtime — referencing <Code>process.env</Code> inside it is just
        JavaScript reading a variable. Keep credentials in a <Code>Secret</Code> and inject them
        with <Code>env:</Code> or <Code>envFrom:</Code> on the pod.
      </Callout>
      <P>
        Nothing operational belongs in this file. The SMTP transport, web tools, mail sync pacing,
        meetings, the container&apos;s browser, and the agent&apos;s taint policy, member browsers,
        and tool discovery all live in the database and are edited at <Code>Admin → Runtime</Code>{" "}
        and <Code>Admin → Email transport</Code> — so a settings change is a form submit, not a
        ConfigMap edit and a rollout. Set the initial public URL before signup using the command
        below; later changes belong at <Code>Admin → General</Code>. Those values are stored in
        Postgres and shared by every replica.
      </P>
      <Pre lang="bash">{`kubectl exec -n genosyn deploy/genosyn -- node dist/server/scripts/setupPublicUrl.js --url https://genosyn.example.com`}</Pre>
      <Callout kind="info" title="Claiming the first account before SMTP exists.">
        A fresh install has no mail transport, so the bootstrap master admin&apos;s verification
        link is written to the pod log instead of being sent. Read it with{" "}
        <Code>kubectl logs -n genosyn deploy/genosyn</Code>, open it in the browser to claim the
        account, enroll two-factor authentication, then configure SMTP at{" "}
        <Code>Admin → Email transport</Code>. Successful enrollment authorizes that browser session
        immediately. Boot warns until you do, and <Code>Admin → Instance Health</Code> flags the
        transport meanwhile. A link that scrolled out of the log can be reissued from{" "}
        <Code>Check your inbox</Code> once signed in — it prints to the log again.
      </Callout>
      <P>
        The instance Secret contains <Code>sessionSecret</Code> and <Code>encryptionSecret</Code>.
        Each must be a different random value of at least 32 characters. An external database URL
        belongs in its own Secret, referenced through <Code>config.db.postgresUrlSecret</Code>.
      </P>

      <H2 id="manifests">PVC, Deployment, Service, Ingress</H2>
      <P>
        The template commands above render all these objects together. Review the generated
        namespace, image, storage, and ingress before applying it through your deployment process.
        Generated manifests can include Secret values; keep their output private.
      </P>
      <P>
        <Strong>Recreate</Strong> over <Strong>RollingUpdate</Strong> because an RWO volume can only
        attach to one pod at a time. The old pod must terminate before the new one schedules.
      </P>
      <P>
        Both probes hit <Code>GET /api/health</Code>, which returns{" "}
        <Code>{"{ ok: true, version }"}</Code> without auth — and only once boot has finished,
        migrations included. That makes it exactly right for readiness: traffic arrives only after
        the schema is current.
      </P>
      <Callout kind="info" title="Execution mode follows the deployment shape.">
        The single-tenant self-host values file uses host coding. OpenCode runs commands with the App
        process user&apos;s authority inside the pod, so no additional namespace permissions are
        required. The chart&apos;s default shared SaaS deployment uses bubblewrap instead. Its
        <Code> sandbox.enabled</Code> setting adds <Code>seccompProfile: Unconfined</Code> and
        <Code> procMount: Unmasked</Code>; supported clusters also use
        <Code> hostUsers: false</Code>. Cluster feature gates and admission policy must permit those
        fields. Shared SaaS refuses to boot without working isolation; the self-host values file
        selects host execution and needs none of those fields.
      </Callout>

      <H2 id="upgrading">Upgrading</H2>
      <P>
        The <Code>genosyn upgrade</Code> CLI command drives Docker on a single host — it has no idea
        about your cluster. Chart installs use <Code>helm upgrade</Code> (shown above); with raw
        manifests, roll the Deployment instead:
      </P>
      <Pre lang="bash">{`kubectl -n genosyn set image deploy/genosyn app=ghcr.io/genosyn/app:1.155.0
kubectl -n genosyn rollout status deploy/genosyn`}</Pre>
      <P>
        Pin a tag rather than tracking <Code>latest</Code> — that&apos;s how you get repeatable
        deployments. Image tags carry no <Code>v</Code> prefix, even though the matching GitHub
        release does: the release is <Code>v1.155.0</Code>, the image is <Code>app:1.155.0</Code>.
      </P>

      <H2 id="backups">Backups</H2>
      <P>
        On Docker, <Code>genosyn backup</Code> tarballs the data volume. On Kubernetes you back up{" "}
        <Strong>three</Strong> things, separately:
      </P>
      <UL>
        <LI>
          <Strong>The Postgres database.</Strong> Use the backup story that shipped with your
          Postgres operator or managed service — <Code>pg_dump</Code> on a CronJob is the cheapest
          option.
        </LI>
        <LI>
          <Strong>
            The <Code>genosyn-data</Code> PVC.
          </Strong>{" "}
          Use a VolumeSnapshot if your StorageClass supports it, or a CronJob that <Code>tar</Code>s
          the volume to object storage.
        </LI>
        <LI>
          <Strong>The instance Secret.</Strong> Preserve the session and encryption keys with the
          database. Losing the encryption key makes stored credentials unreadable.
        </LI>
      </UL>
      <P>
        Restore is symmetric: restore the Secret and Postgres, rehydrate the PVC, then start the
        Deployment.
      </P>

      <H3 id="next">Next steps</H3>
      <P>
        Once the pod is healthy, open your Ingress host, create the first owner account, and follow
        the post-install path: pick a <DocLink to="/docs/models">model</DocLink>, create an{" "}
        <DocLink to="/docs/employees">AI Employee</DocLink>, schedule a{" "}
        <DocLink to="/docs/routines">Routine</DocLink>.
      </P>
    </>
  );
}
