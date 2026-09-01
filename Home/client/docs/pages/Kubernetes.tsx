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
            release. You trade the one-line installer for <Code>helm</Code> — and you give up the
            {" "}
            <Code>genosyn upgrade</Code> and <Code>genosyn backup</Code> commands, which only know
            how to drive Docker on a single host.
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
  --namespace genosyn --create-namespace`}</Pre>
      <P>
        That gives you the same shape as the one-line Docker installer: one replica, SQLite, and a
        20Gi volume at <Code>/app/data</Code>. The pod becomes Ready once every migration has run —
        {" "}
        <Code>/api/health</Code> answers <Code>{"{ ok: true, version }"}</Code> only after boot
        completes, so a pending readiness probe during the first minute is normal. The handful of
        values that matter:
      </P>
      <KeyList
        rows={[
          {
            term: "ingress.enabled + ingress.host",
            def: (
              <>
                Front the app with your Ingress controller. WebSockets share port <Code>8471</Code>
                {" "}
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
                installs: unless explicit secrets are configured, the managed instance encryption
                secrets live there.
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
                Grants the securityContext the bubblewrap coding sandbox needs (seccomp{" "}
                <Code>Unconfined</Code> + <Code>procMount: Unmasked</Code>). Off by default; see the
                securityContext callout below for what your cluster must permit.
              </>
            ),
          },
          {
            term: "secrets.existingSecret",
            def: (
              <>
                A Secret with <Code>sessionSecret</Code> and <Code>encryptionSecret</Code> keys
                (each 32+ characters, distinct). Strongly recommended; required for{" "}
                <DocLink to="/docs/saas-hosting">shared SaaS mode</DocLink>.
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
        of this page explains what the chart deploys — read on if you want the raw manifests
        instead.
      </P>

      <H2 id="architecture">Architecture</H2>
      <P>
        Genosyn is a single stateless container. Everything that needs to survive a restart is
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
          <Strong>External Postgres.</Strong> SQLite works inside a pod but dies with the pod. Run
          Postgres in-cluster (a separate Helm chart, CloudNativePG, Zalando, …) or point at a
          managed instance.
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
        Everything below is what the chart renders for you, as raw manifests. Skip it if Helm
        already did the job; use it when you want to own every object yourself or fold Genosyn into
        an existing GitOps tree.
      </P>

      <H2 id="prerequisites">Prerequisites</H2>
      <KeyList
        rows={[
          {
            term: "Cluster",
            def: "Any conformant Kubernetes 1.27+. Managed EKS / GKE / AKS, k3s, or kind all work — the manifests below are vanilla.",
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
        that file is boot configuration only:
      </P>
      <Pre lang="yaml">{`apiVersion: v1
kind: ConfigMap
metadata:
  name: genosyn-config
  namespace: genosyn
data:
  config.js: |
    export const config = {
      dataDir: "/app/data",
      db: {
        driver: "postgres",
        sqlitePath: "",
        postgresUrl: process.env.GENOSYN_POSTGRES_URL,
      },
      port: 8471,
      sessionSecret: process.env.GENOSYN_SESSION_SECRET,
      security: {
        multiTenant: false,
        encryptionSecret: process.env.GENOSYN_ENCRYPTION_SECRET,
        previousEncryptionSecrets: [],
        secureCookies: "auto",
        sessionMaxAgeDays: 7,
        trustedProxyHops: 1,
        outboundPrivateHostAllowlist: [],
        outboundRequestTimeoutMs: 15_000,
        outboundMaxResponseBytes: 25 * 1024 * 1024,
        authRateLimit: { windowMinutes: 15, maxAttempts: 10, blockMinutes: 15 },
        bootstrapMasterAdminEmail: "operator@example.com",
      },
      agent: {
        codingTools: {
          enabled: true,
          executionMode: "bubblewrap",
          bubblewrapPath: "/usr/bin/bwrap",
          allowNetwork: false,
          allowUnsafeHostExecution: false,
        },
        browserEnabledInMultiTenant: false,
      },
    };`}</Pre>
      <Callout kind="tip" title="Why process.env here is fine.">
        Genosyn doesn&apos;t use <Code>dotenv</Code> or per-environment files, but the config object
        is plain JavaScript at runtime — referencing <Code>process.env</Code> inside it is just
        JavaScript reading a variable. Keep credentials in a <Code>Secret</Code> and inject them
        with <Code>env:</Code> or <Code>envFrom:</Code> on the pod.
      </Callout>
      <P>
        Nothing operational belongs in this file. The SMTP transport, web tools, mail sync pacing,
        meetings, the container&apos;s browser, and the agent&apos;s taint policy, member browsers,
        and tool discovery all live in the database and are edited at <Code>Admin → Runtime</Code>
        {" "}
        and <Code>Admin → Email transport</Code> — so a settings change is a form submit, not a
        ConfigMap edit and a rollout. Nor is the public URL here: after the first master admin signs
        in, review and save <Code>https://genosyn.example.com</Code> at <Code>Admin → General</Code>
        . Those values are stored in Postgres and shared by every replica.
      </P>
      <Callout kind="info" title="Claiming the first account before SMTP exists.">
        A fresh install has no mail transport, so the bootstrap master admin&apos;s verification
        link is written to the pod log instead of being sent. Read it with{" "}
        <Code>kubectl logs -n genosyn deploy/genosyn</Code>, open it in the browser to claim the
        account, then configure SMTP at <Code>Admin → Email transport</Code>. Boot warns until you
        do, and <Code>Admin → Instance Health</Code> flags the transport meanwhile. A link that
        scrolled out of the log can be reissued from <Code>Account → Profile</Code> once signed in —
        it prints to the log again.
      </Callout>
      <P>
        Sensitive values go in a separate <Code>Secret</Code>:
      </P>
      <Pre lang="yaml">{`apiVersion: v1
kind: Secret
metadata:
  name: genosyn-secrets
  namespace: genosyn
type: Opaque
stringData:
  GENOSYN_POSTGRES_URL: postgresql://genosyn:****@postgres:5432/genosyn
  GENOSYN_SESSION_SECRET: "<32+ random bytes>"
  GENOSYN_ENCRYPTION_SECRET: "<a different 32+ random bytes>"`}</Pre>

      <H2 id="manifests">PVC, Deployment, Service, Ingress</H2>
      <P>
        One file, four objects. Apply with <Code>kubectl apply -f</Code>:
      </P>
      <Pre lang="yaml">{`---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: genosyn-data
  namespace: genosyn
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 20Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: genosyn
  namespace: genosyn
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels: { app: genosyn }
  template:
    metadata:
      labels: { app: genosyn }
    spec:
      containers:
        - name: app
          image: ghcr.io/genosyn/app:latest
          ports:
            - containerPort: 8471
          securityContext:
            seccompProfile:
              type: Unconfined
            procMount: Unmasked
          envFrom:
            - secretRef:
                name: genosyn-secrets
          volumeMounts:
            - name: data
              mountPath: /app/data
            - name: config
              mountPath: /app/dist/config.js
              subPath: config.js
              readOnly: true
          readinessProbe:
            httpGet: { path: /api/health, port: 8471 }
            initialDelaySeconds: 10
            periodSeconds: 10
          # Lax on purpose: migrations run on boot and can hold /api/health
          # closed for a while on upgrade. Don't tighten this.
          livenessProbe:
            httpGet: { path: /api/health, port: 8471 }
            initialDelaySeconds: 60
            periodSeconds: 20
            failureThreshold: 6
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: genosyn-data
        - name: config
          configMap:
            name: genosyn-config
---
apiVersion: v1
kind: Service
metadata:
  name: genosyn
  namespace: genosyn
spec:
  selector: { app: genosyn }
  ports:
    - port: 80
      targetPort: 8471
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: genosyn
  namespace: genosyn
spec:
  ingressClassName: nginx
  rules:
    - host: genosyn.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: genosyn
                port: { number: 80 }`}</Pre>
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
      <Callout kind="info" title="The securityContext is what command execution runs on.">
        Genosyn runs every command an AI Employee asks for inside <Code>bubblewrap</Code>, which
        creates a user namespace and mounts its own <Code>/proc</Code>. A stock pod may do neither:
        the default seccomp profile rejects the namespace flags, and the runtime&apos;s masked{" "}
        <Code>/proc</Code> entries are locked mounts a nested namespace may not mount over. The two
        fields above are the cluster equivalents of the Docker options the{" "}
        <DocLink to="/docs/cli">CLI</DocLink> passes. Both are gated:{" "}
        <Code>procMount: Unmasked</Code> needs the <Code>ProcMountType</Code> feature gate and,
        depending on your Kubernetes version, either user namespaces (<Code>hostUsers: false</Code>
        {" "}
        on the pod) or a privileged container, and Pod Security admission permits neither field
        below the <Code>privileged</Code> level — <Code>baseline</Code> and <Code>restricted</Code>
        {" "}
        reject both. Genosyn itself never needs a privileged container. If your cluster will not
        take these fields, delete them: Genosyn then boots with command execution disabled and logs
        the reason — chat, Routines, Integrations, browser work, and the repository editor all still
        work; builds, test suites, and the per-employee checkout do not.
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
        rollbacks. Image tags carry no <Code>v</Code> prefix, even though the matching GitHub
        release does: the release is <Code>v1.155.0</Code>, the image is <Code>app:1.155.0</Code>.
      </P>

      <H2 id="backups">Backups</H2>
      <P>
        On Docker, <Code>genosyn backup</Code> tarballs the data volume. On Kubernetes you back up
        {" "}
        <Strong>two</Strong> things, separately:
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
          </Strong>
          {" "}
          Use a VolumeSnapshot if your StorageClass supports it, or a CronJob that <Code>tar</Code>s
          the volume to object storage.
        </LI>
      </UL>
      <P>
        Restore is symmetric: load Postgres first, then rehydrate the PVC, then start the
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
