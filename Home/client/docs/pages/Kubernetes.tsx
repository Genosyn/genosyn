import {
  Callout,
  Code,
  DocLink,
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
            The same image that powers <Code>genosyn install</Code> runs fine
            on Kubernetes. You trade the one-line installer for raw
            manifests — and you give up the <Code>genosyn upgrade</Code>{" "}
            and <Code>genosyn backup</Code> commands, which only know how to
            drive Docker on a single host.
          </>
        }
      />

      <Callout kind="warn" title="Not the recommended path.">
        For most self-hosters, single-host Docker is the right answer — it&apos;s
        what the installer, the CLI, and the docs are built around. Reach for
        Kubernetes when you already operate one and want Genosyn to live next
        to your other workloads. Don&apos;t stand up a cluster for this app.
      </Callout>

      <H2 id="architecture">Architecture</H2>
      <P>
        Genosyn is a single stateless container. Everything that needs to
        survive a restart is either in Postgres or under <Code>/app/data</Code>:
      </P>
      <UL>
        <LI>
          <Strong>Deployment, 1 replica.</Strong> Per-employee credential
          directories and CLI working trees under <Code>/app/data</Code> are
          filesystem state that the running process mutates. Scaling out
          horizontally would need a coordination layer Genosyn doesn&apos;t
          have today — keep <Code>replicas: 1</Code>.
        </LI>
        <LI>
          <Strong>PersistentVolumeClaim</Strong> at <Code>/app/data</Code>{" "}
          (ReadWriteOnce is fine). Holds employee creds, materialized git
          checkouts, <Code>.mcp.json</Code> files, and uploaded attachments.
        </LI>
        <LI>
          <Strong>External Postgres.</Strong> SQLite works inside a pod but
          dies with the pod. Run Postgres in-cluster (a separate Helm chart,
          CloudNativePG, Zalando, …) or point at a managed instance.
        </LI>
        <LI>
          <Strong>Secret with config overrides.</Strong> Genosyn&apos;s config
          is a bundled TypeScript object; on Kubernetes you overlay it at
          runtime — see below.
        </LI>
        <LI>
          <Strong>Service + Ingress.</Strong> The container listens on{" "}
          <Code>8471</Code>. Front it with whatever Ingress controller you
          already run.
        </LI>
      </UL>

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
                Reachable from the cluster. Genosyn runs every migration on
                boot, so an empty database is fine.
              </>
            ),
          },
          {
            term: "StorageClass",
            def: (
              <>
                One that supports <Code>ReadWriteOnce</Code>. The default
                class on every managed cluster qualifies.
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
        <Code>App/config.ts</Code> is compiled into the image at build time, so
        the live process reads <Code>/app/dist/config.js</Code>. To change
        values without rebuilding, mount a <Code>ConfigMap</Code> over that
        path. The compiled shape mirrors{" "}
        <DocLink to="/docs/self-hosting">the source</DocLink> exactly:
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
      publicUrl: "https://genosyn.example.com",
      sessionSecret: process.env.GENOSYN_SESSION_SECRET,
      smtp: {
        host: "smtp.example.com", port: 587, secure: false,
        user: "apikey", pass: process.env.GENOSYN_SMTP_PASS,
        from: "Genosyn <no-reply@example.com>",
      },
      integrations: {
        google: { clientId: "", clientSecret: "" },
      },
    };`}</Pre>
      <Callout kind="tip" title="Why process.env here is fine.">
        Genosyn doesn&apos;t use <Code>dotenv</Code> or per-environment files,
        but the config object is plain JavaScript at runtime — referencing{" "}
        <Code>process.env</Code> inside it is just JavaScript reading a
        variable. Keep credentials in a <Code>Secret</Code> and inject them
        with <Code>env:</Code> or <Code>envFrom:</Code> on the pod.
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
  GENOSYN_SMTP_PASS: "<smtp password or api key>"`}</Pre>

      <H2 id="manifests">PVC, Deployment, Service, Ingress</H2>
      <P>One file, four objects. Apply with <Code>kubectl apply -f</Code>:</P>
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
          livenessProbe:
            httpGet: { path: /api/health, port: 8471 }
            initialDelaySeconds: 30
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
        <Strong>Recreate</Strong> over <Strong>RollingUpdate</Strong> because
        an RWO volume can only attach to one pod at a time. The old pod must
        terminate before the new one schedules.
      </P>

      <H2 id="upgrading">Upgrading</H2>
      <P>
        The <Code>genosyn upgrade</Code> CLI command drives Docker on a single
        host — it has no idea about your cluster. Roll the Deployment instead:
      </P>
      <Pre lang="bash">{`kubectl -n genosyn set image deploy/genosyn app=ghcr.io/genosyn/app:v0.3.47
kubectl -n genosyn rollout status deploy/genosyn`}</Pre>
      <P>
        Pin a tag rather than tracking <Code>latest</Code> — that&apos;s how
        you get repeatable rollbacks.
      </P>

      <H2 id="backups">Backups</H2>
      <P>
        On Docker, <Code>genosyn backup</Code> tarballs the data volume. On
        Kubernetes you back up <Strong>two</Strong> things, separately:
      </P>
      <UL>
        <LI>
          <Strong>The Postgres database.</Strong> Use the backup story that
          shipped with your Postgres operator or managed service —{" "}
          <Code>pg_dump</Code> on a CronJob is the cheapest option.
        </LI>
        <LI>
          <Strong>The <Code>genosyn-data</Code> PVC.</Strong> Use a
          VolumeSnapshot if your StorageClass supports it, or a CronJob that{" "}
          <Code>tar</Code>s the volume to object storage.
        </LI>
      </UL>
      <P>
        Restore is symmetric: load Postgres first, then rehydrate the PVC,
        then start the Deployment.
      </P>

      <H2 id="helm">A Helm chart?</H2>
      <P>
        Not officially shipped. The manifests above are short enough that
        templating them adds more friction than it removes for most teams —
        and a chart we&apos;d have to lint, publish, and version across
        Genosyn releases is a real maintenance surface.
      </P>
      <P>
        If you build one internally, the values worth parameterising are{" "}
        <Code>image.tag</Code>, <Code>ingress.host</Code>,{" "}
        <Code>persistence.size</Code>, and the contents of the config{" "}
        <Code>ConfigMap</Code>. Open an issue if you&apos;d like to upstream
        it — community charts are welcome.
      </P>

      <H3 id="next">Next steps</H3>
      <P>
        Once the pod is healthy, open your Ingress host, create the first
        owner account, and follow the post-install path: pick a{" "}
        <DocLink to="/docs/models">model</DocLink>, create an{" "}
        <DocLink to="/docs/employees">AI Employee</DocLink>, schedule a{" "}
        <DocLink to="/docs/routines">Routine</DocLink>.
      </P>
    </>
  );
}
