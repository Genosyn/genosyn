#!/usr/bin/env bash
# Exercises deployment routing and failures with fake Helm and kubectl.
# No cluster, cloud tools, or installed Helm is used.
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node - "${script_dir}/deploy-saas.sh" <<'NODE'
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-deploy-test-"));
const repo = path.join(testRoot, "fixture checkout");
const bin = path.join(testRoot, "bin");
const scratch = path.join(testRoot, "scratch space");
const log = path.join(testRoot, "commands.jsonl");
const originalConfig = path.join(testRoot, "original-kubeconfig");
const customConfig = path.join(testRoot, "custom config");
const secondConfig = path.join(testRoot, "second config");
const configurationFiles = [originalConfig, customConfig, secondConfig];
let passed = 0;
let failed = 0;
try {
  for (const directory of [bin, scratch, path.join(repo, "CLI"), path.join(repo, "Helm/genosyn"), path.join(repo, "Helm/Values")]) fs.mkdirSync(directory, { recursive: true });
  fs.copyFileSync(process.argv[2], path.join(repo, "CLI/deploy-saas.sh"));
  fs.writeFileSync(path.join(repo, "VERSION"), "1.234.5\n");
  fs.writeFileSync(path.join(repo, "Helm/genosyn/Chart.yaml"), "name: genosyn\nversion: 1.0.0\nappVersion: 1.0.0\n");
  for (const environment of ["test", "prod"]) fs.writeFileSync(path.join(repo, "Helm/Values", `${environment}.values.yaml`), "config: {}\n");
  for (const file of configurationFiles) fs.writeFileSync(file, "current-context: unrelated-context\n", { mode: 0o600 });
  // Give subprocesses only these utilities and our fake Kubernetes tools.
  // A locally installed cloud CLI or credentials plugin cannot mask a dependency.
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  for (const tool of ["bash", "basename", "cat", "dirname", "mktemp", "rm", "touch"]) {
    const found = spawnSync("which", [tool], { encoding: "utf8" });
    assert.equal(found.status, 0, `Missing test utility ${tool}`);
    fs.symlinkSync(found.stdout.trim(), path.join(bin, tool));
  }
  const mock = path.join(bin, "mock-cli");
  fs.writeFileSync(mock, String.raw`#!/usr/bin/env bash
set -euo pipefail
tool="$(basename "$0")"
node - "$tool" "$@" <<'LOG'
const fs = require("node:fs");
const [tool, ...args] = process.argv.slice(2);
const kubeconfig = process.env.KUBECONFIG;
const helmOverrides = Object.keys(process.env).filter(name => name.startsWith("HELM_KUBE") || name === "HELM_NAMESPACE" || name === "HELM_DEBUG");
fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify({ tool, args, kubeconfig, helmOverrides }) + "\n");
LOG
case "$tool" in
  kubectl)
    case "$5" in
      config)
        [ "$6" = get-contexts ] && [ "$7" = --output=name ] && [ "$8" = -- ] && [ "$9" = "$2" ] || exit 99
        if [ "$MOCK_CONTEXT_EXIT" != 0 ]; then
          echo "synthetic-kubeconfig-error-must-not-appear" >&2
          exit "$MOCK_CONTEXT_EXIT"
        fi
        if [ "$MOCK_CONTEXT_FOUND" = true ]; then printf '%s\n' "$2"; fi
        ;;
      exec)
        echo "Mock public URL setup"
        exit "$MOCK_SETUP_EXIT"
        ;;
      *) echo "Unexpected mock kubectl command" >&2; exit 99 ;;
    esac
    ;;
  helm)
    case "$1" in
      package)
        shift
        destination=""
        version=""
        while [ "$#" -gt 0 ]; do
          case "$1" in
            --destination) destination="$2"; shift 2 ;;
            --version) version="$2"; shift 2 ;;
            *) shift ;;
          esac
        done
        touch "$destination/genosyn-$version.tgz"
        ;;
      lint) exit "$MOCK_LINT_EXIT" ;;
      template)
        secret_preview=false
        if [ "$MOCK_SECRET_MANIFESTS" = true ] && [[ " $* " != *" --show-only "* ]]; then
          secret_preview=true
          cat <<'SECRET'
# Source: genosyn/templates/instance-secrets.yaml
apiVersion: v1
kind: Secret
metadata:
  name: private-instance-secret-fixture
data:
  sessionSecret: Zml4dHVyZS1zZXNzaW9uLXNlY3JldA==
---
SECRET
        fi
        printf 'apiVersion: networking.k8s.io/v1\nkind: Ingress\nspec:\n'
        if [ "$MOCK_TEMPLATE_TLS" = true ] || [ -n "$MOCK_SECONDARY_HOST" ]; then
          printf '  tls:\n'
          if [ "$MOCK_TEMPLATE_TLS" = true ]; then
            tls_host="$MOCK_TEMPLATE_TLS_HOST"
            if [ -z "$tls_host" ]; then tls_host="$MOCK_TEMPLATE_HOST"; fi
            printf '    - hosts:\n        - "%s"\n      secretName: "%s"\n' "$tls_host" "$MOCK_TEMPLATE_TLS_SECRET"
          fi
          if [ -n "$MOCK_SECONDARY_HOST" ]; then
            printf '    - hosts:\n        - "%s"\n      secretName: secondary-tls\n' "$MOCK_SECONDARY_HOST"
          fi
        fi
        printf '  rules:\n    - host: "%s"\n      http: {}\n' "$MOCK_TEMPLATE_HOST"
        if [ -n "$MOCK_SECONDARY_HOST" ]; then
          printf '    - host: "%s"\n      http: {}\n' "$MOCK_SECONDARY_HOST"
        fi
        if [ "$secret_preview" = true ]; then
          cat <<'SECRET'
---
# Source: genosyn/templates/postgres-secret.yaml
apiVersion: v1
kind: "Secret"
metadata:
  name: private-database-secret-fixture
stringData:
  password: fixture-database-password
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: public-preview-config
data:
  example.yaml: |
    kind: Secret
  publicOrigin: https://test.genosyn.com
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: public-preview-app
spec:
  template:
    spec:
      containers:
        - name: app
          envFrom:
            - secretRef:
                name: existing-secret-reference
--- # Last resource has no following document separator.
apiVersion: v1
kind: 'Secret' # TLS credentials
metadata:
  name: private-tls-secret-fixture
stringData:
  tls.key: fixture-private-tls-key
SECRET
        fi
        ;;
      upgrade) exit "$MOCK_UPGRADE_EXIT" ;;
      get)
        node - <<'VALUES'
console.log(JSON.stringify({ ingress: { enabled: true, host: process.env.MOCK_GET_HOST, tls: { enabled: process.env.MOCK_GET_TLS_ENABLED === "true", secretName: process.env.MOCK_GET_TLS_SECRET }, connect: { enabled: Boolean(process.env.MOCK_SECONDARY_HOST), host: process.env.MOCK_SECONDARY_HOST, tlsSecretName: "secondary-tls" } }, secretData: "must-not-appear-in-deploy-output" }));
VALUES
        ;;
      *) echo "Unexpected mock Helm command" >&2; exit 99 ;;
    esac
    ;;
esac
`, { mode: 0o755 });
  for (const tool of ["helm", "kubectl"]) fs.symlinkSync(mock, path.join(bin, tool));

  function run(args, extraEnv = {}) {
    fs.writeFileSync(log, "");
    const env = {
      ...process.env,
      PATH: bin,
      TMPDIR: scratch,
      KUBECONFIG: originalConfig,
      GENOSYN_KUBE_CONTEXT: "",
      GENOSYN_TEST_KUBE_CONTEXT: "fixture-test-context",
      GENOSYN_PROD_KUBE_CONTEXT: "fixture-prod-context",
      GENOSYN_IMAGE_TAG: "",
      GENOSYN_BOOTSTRAP_ADMIN_EMAIL: "",
      MOCK_LOG: log,
      MOCK_LINT_EXIT: "0",
      MOCK_CONTEXT_EXIT: "0",
      MOCK_CONTEXT_FOUND: "true",
      MOCK_UPGRADE_EXIT: "0",
      MOCK_SETUP_EXIT: "0",
      MOCK_TEMPLATE_TLS: "true",
      MOCK_TEMPLATE_TLS_HOST: "",
      MOCK_TEMPLATE_TLS_SECRET: "example-tls",
      MOCK_TEMPLATE_HOST: "test.genosyn.com",
      MOCK_SECRET_MANIFESTS: "false",
      MOCK_SECONDARY_HOST: "",
      MOCK_GET_HOST: "test.genosyn.com",
      MOCK_GET_TLS_ENABLED: "true",
      MOCK_GET_TLS_SECRET: "example-tls",
      ...extraEnv,
    };
    const result = spawnSync("bash", [path.join(repo, "CLI/deploy-saas.sh"), ...args], { cwd: testRoot, env, encoding: "utf8" });
    if (result.error) throw result.error;
    const rows = fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    for (const file of configurationFiles) {
      assert.equal(fs.readFileSync(file, "utf8"), "current-context: unrelated-context\n", "operator kubeconfig changed");
      assert.equal(fs.statSync(file).mode & 0o777, 0o600, "operator kubeconfig permissions changed");
    }
    assert.deepEqual(fs.readdirSync(scratch), [], "temporary deployment files were not removed");
    const selectedContext = env.GENOSYN_KUBE_CONTEXT || (args[0] === "test" ? env.GENOSYN_TEST_KUBE_CONTEXT : env.GENOSYN_PROD_KUBE_CONTEXT);
    for (const row of rows.filter(row => row.tool === "kubectl" || row.args[0] === "upgrade" || row.args[0] === "get")) {
      assert.equal(row.kubeconfig, env.KUBECONFIG, "operator KUBECONFIG was replaced");
      assert(!row.args.includes("--kubeconfig"), "multi-file KUBECONFIG must remain supported");
      const contextFlag = row.tool === "kubectl" ? "--context" : "--kube-context";
      assert.equal(row.args[row.args.indexOf(contextFlag) + 1], selectedContext, "selected context was not passed explicitly");
      assert.equal(row.args[row.args.indexOf("--namespace") + 1], `genosyn-${args[0]}`, "namespace was not passed explicitly");
    }
    return { ...result, rows, output: result.stdout + result.stderr };
  }
  const command = (result, tool, first) => result.rows.find(row => row.tool === tool && (first === undefined || row.args[tool === "kubectl" ? 4 : 0] === first));
  const flag = (row, name) => row.args[row.args.indexOf(name) + 1];
  const noCloud = result => assert(result.rows.every(row => row.tool === "helm" && !["upgrade", "get"].includes(row.args[0])), "offline validation touched the cluster");
  function test(name, body) {
    try { body(); passed++; console.log(`ok - ${name}`); }
    catch (error) { failed++; console.error(`FAIL - ${name}\n${error.stack}`); }
  }

  test("offline test preview packages current VERSION without a context or kubectl", () => {
    fs.unlinkSync(path.join(bin, "kubectl"));
    let result;
    try {
      result = run(["test", "--template"], { GENOSYN_TEST_KUBE_CONTEXT: "", GENOSYN_PROD_KUBE_CONTEXT: "" });
    } finally {
      fs.symlinkSync(mock, path.join(bin, "kubectl"));
    }
    assert.equal(result.status, 0, result.output);
    noCloud(result);
    assert.match(result.stdout, /kind: Ingress/);
    const packaged = command(result, "helm", "package");
    assert.equal(flag(packaged, "--version"), "1.234.5");
    assert.equal(flag(packaged, "--app-version"), "1.234.5");
    for (const row of result.rows.filter(row => ["lint", "template"].includes(row.args[0]))) assert(row.args.includes("image.tag=1.234.5"));
    assert.equal(flag(command(result, "helm", "template"), "--namespace"), "genosyn-test");
  });
  test("production preview uses its own profile, namespace, and pinned candidate", () => {
    const result = run(["prod", "--template"], { GENOSYN_IMAGE_TAG: "sha-abcdef0123456789", GENOSYN_BOOTSTRAP_ADMIN_EMAIL: "ops+deploy@example.com", GENOSYN_PROD_KUBE_CONTEXT: "" });
    assert.equal(result.status, 0, result.output);
    noCloud(result);
    const rendered = command(result, "helm", "template");
    assert.equal(flag(rendered, "--namespace"), "genosyn-prod");
    assert.equal(flag(rendered, "-f"), path.join(repo, "Helm/Values/prod.values.yaml"));
    assert(rendered.args.includes("image.tag=sha-abcdef0123456789"));
    assert(rendered.args.includes("config.bootstrapMasterAdminEmail=ops+deploy@example.com"));
  });
  test("offline previews omit whole Secret documents and preserve nonsecret resources", () => {
    for (const environment of ["test", "prod"]) {
      const result = run([environment, "--template"], { MOCK_SECRET_MANIFESTS: "true" });
      assert.equal(result.status, 0, result.output);
      noCloud(result);
      assert.equal((result.stdout.match(/# Secret manifest omitted from preview\./g) || []).length, 3);
      for (const hidden of [
        "private-instance-secret-fixture", "Zml4dHVyZS1zZXNzaW9uLXNlY3JldA==",
        "private-database-secret-fixture", "fixture-database-password",
        "private-tls-secret-fixture", "fixture-private-tls-key", "stringData:",
      ]) assert(!result.output.includes(hidden), `preview leaked ${hidden}`);
      assert.match(result.stdout, /^kind: Ingress$/m);
      assert.match(result.stdout, /^kind: ConfigMap$/m);
      assert.match(result.stdout, /  example\.yaml: \|\n    kind: Secret\n  publicOrigin: https:\/\/test\.genosyn\.com/);
      assert.match(result.stdout, /^kind: Deployment$/m);
      assert.match(result.stdout, /name: existing-secret-reference/);
    }
  });
  test("deploy validates and checks its explicit context before applying, then sets effective public URL", () => {
    const result = run(["test"], { MOCK_GET_HOST: "effective.test.genosyn.com" });
    assert.equal(result.status, 0, result.output);
    const contextIndex = result.rows.findIndex(row => row.tool === "kubectl");
    assert(result.rows.slice(0, contextIndex).some(row => row.args[0] === "lint"));
    assert.equal(result.rows.slice(0, contextIndex).filter(row => row.args[0] === "template").length, 2);
    const lookup = command(result, "kubectl", "config");
    assert.deepEqual(lookup.args.slice(4), ["config", "get-contexts", "--output=name", "--", "fixture-test-context"]);
    assert(contextIndex < result.rows.indexOf(command(result, "helm", "upgrade")));
    const applied = command(result, "helm", "upgrade");
    for (const required of ["--install", "--create-namespace", "--reset-values", "--wait"]) assert(applied.args.includes(required));
    assert.equal(applied.args[2], "genosyn");
    assert.equal(flag(applied, "--timeout"), "15m");
    assert.equal(flag(applied, "--kube-context"), "fixture-test-context");
    assert.equal(flag(applied, "--namespace"), "genosyn-test");
    assert(!applied.args.includes("--atomic"));
    const setup = command(result, "kubectl", "exec");
    assert(setup.args.includes("deployment/genosyn"));
    assert(setup.args.includes("/app/dist/server/scripts/setupPublicUrl.js"));
    assert.equal(flag(setup, "--context"), flag(applied, "--kube-context"));
    assert.equal(flag(setup, "--namespace"), "genosyn-test");
    assert.equal(flag(setup, "--url"), "https://effective.test.genosyn.com");
    assert(!result.output.includes("must-not-appear-in-deploy-output"));
  });
  test("production uses its own selected context and fixed release and namespace", () => {
    const result = run(["prod"], { MOCK_GET_HOST: "app.genosyn.com" });
    assert.equal(result.status, 0, result.output);
    const applied = command(result, "helm", "upgrade");
    assert.equal(applied.args[2], "genosyn");
    assert.equal(flag(applied, "--namespace"), "genosyn-prod");
    assert.equal(flag(applied, "--kube-context"), "fixture-prod-context");
  });
  test("one-run context overrides preserve complex names as a single argument", () => {
    const context = 'operator@cluster/team:production $(do-not-run)';
    for (const environment of ["test", "prod"]) {
      const result = run([environment], { GENOSYN_KUBE_CONTEXT: context });
      assert.equal(result.status, 0, result.output);
      assert.equal(flag(command(result, "helm", "upgrade"), "--kube-context"), context);
      assert.equal(command(result, "kubectl", "config").args.at(-1), context);
    }
  });
  test("custom and multiple kubeconfig files remain inherited and unmodified", () => {
    for (const kubeconfig of [customConfig, `${originalConfig}${path.delimiter}${secondConfig}`]) {
      const result = run(["prod"], { KUBECONFIG: kubeconfig });
      assert.equal(result.status, 0, result.output);
      assert.equal(command(result, "helm", "upgrade").kubeconfig, kubeconfig);
      assert.equal(command(result, "kubectl", "exec").kubeconfig, kubeconfig);
    }
  });
  test("an unset KUBECONFIG leaves the operator's default configuration in effect", () => {
    const result = run(["test"], { KUBECONFIG: undefined });
    assert.equal(result.status, 0, result.output);
    assert.equal(command(result, "helm", "upgrade").kubeconfig, undefined);
    assert.equal(command(result, "kubectl", "config").kubeconfig, undefined);
  });
  test("Helm connection overrides cannot diverge from the selected kubeconfig", () => {
    const overrides = Object.fromEntries([
      "HELM_KUBEAPISERVER", "HELM_KUBECAFILE", "HELM_KUBEASGROUPS", "HELM_KUBEASUSER",
      "HELM_KUBECONTEXT", "HELM_KUBETOKEN", "HELM_KUBEINSECURE_SKIP_TLS_VERIFY",
      "HELM_KUBETLS_SERVER_NAME", "HELM_NAMESPACE",
    ].map(name => [name, "synthetic-override-must-not-control-deployment"]));
    const result = run(["prod"], { ...overrides, HELM_DEBUG: "true" });
    assert.equal(result.status, 0, result.output);
    for (const row of result.rows.filter(row => row.tool === "kubectl" || ["upgrade", "get"].includes(row.args[0]))) {
      assert.deepEqual(row.helmOverrides, [], "a live command inherited a Helm connection override");
    }
    assert(!result.output.includes("synthetic-override-must-not-control-deployment"));
    assert(result.rows.every(row => !row.helmOverrides.includes("HELM_DEBUG")), "Helm debug must be disabled before preflight too");
  });
  test("offline previews disable inherited Helm debug before rendering private values", () => {
    const result = run(["test", "--template"], { HELM_DEBUG: "true", MOCK_SECRET_MANIFESTS: "true" });
    assert.equal(result.status, 0, result.output);
    noCloud(result);
    assert(result.rows.every(row => !row.helmOverrides.includes("HELM_DEBUG")));
    assert(!result.output.includes("fixture-database-password"));
    assert.match(result.stdout, /Secret manifest omitted from preview/);
  });
  test("live deploys require their own selected context without using current-context", () => {
    for (const environment of ["test", "prod"]) {
      const variable = environment === "test" ? "GENOSYN_TEST_KUBE_CONTEXT" : "GENOSYN_PROD_KUBE_CONTEXT";
      for (const missing of ["", "  "]) {
        const result = run([environment], { [variable]: missing });
        assert.equal(result.status, 1, result.output);
        assert.match(result.stderr, /Select a Kubernetes context/);
        noCloud(result);
      }
    }
  });
  test("a context missing from kubeconfig prevents every cluster operation", () => {
    const result = run(["prod"], { MOCK_CONTEXT_FOUND: "false" });
    assert.equal(result.status, 1, result.output);
    assert.match(result.stderr, /context was not found/);
    assert(command(result, "kubectl", "config"));
    assert(!command(result, "helm", "upgrade"));
    assert(!command(result, "kubectl", "exec"));
  });
  test("a second hosted sign-in host never replaces the main App public URL", () => {
    const result = run(["prod"], {
      MOCK_TEMPLATE_HOST: "app.genosyn.com",
      MOCK_GET_HOST: "effective.app.genosyn.com",
      MOCK_SECONDARY_HOST: "connect.genosyn.com",
    });
    assert.equal(result.status, 0, result.output);
    assert.match(result.stdout, /public URL https:\/\/app\.genosyn\.com/);
    assert.equal(flag(command(result, "kubectl", "exec"), "--url"), "https://effective.app.genosyn.com");
    assert(!result.stdout.includes("public URL https://connect.genosyn.com"));
  });
  test("invalid chart fails before reading Kubernetes configuration", () => {
    const result = run(["test"], { MOCK_LINT_EXIT: "17" });
    assert.equal(result.status, 17);
    noCloud(result);
  });
  test("invalid public host and missing TLS fail before reading Kubernetes configuration", () => {
    for (const extra of [{ MOCK_TEMPLATE_HOST: "evil.example/path" }, { MOCK_TEMPLATE_TLS: "false" }]) {
      const result = run(["prod"], extra);
      assert.equal(result.status, 1);
      noCloud(result);
    }
  });
  test("secondary TLS cannot substitute for missing or mismatched primary TLS", () => {
    for (const extra of [
      { MOCK_TEMPLATE_TLS: "false" },
      { MOCK_TEMPLATE_TLS_HOST: "other.genosyn.com" },
      { MOCK_TEMPLATE_TLS_SECRET: "" },
    ]) {
      const result = run(["prod"], { MOCK_SECONDARY_HOST: "connect.genosyn.com", ...extra });
      assert.equal(result.status, 1, result.output);
      assert.match(result.stderr, /primary DNS host and matching TLS/);
      noCloud(result);
    }
  });
  test("context lookup failure never applies a release or prints credential diagnostics", () => {
    const result = run(["test"], { MOCK_CONTEXT_EXIT: "12" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Could not read the selected Kubernetes context/);
    assert(!result.output.includes("synthetic-kubeconfig-error-must-not-appear"));
    assert(!command(result, "helm", "upgrade"));
    assert(!command(result, "kubectl", "exec"));
  });
  test("failed Helm apply never runs public URL setup", () => {
    const result = run(["prod"], { MOCK_UPGRADE_EXIT: "19" });
    assert.equal(result.status, 19);
    assert(!command(result, "helm", "get"));
    assert(!command(result, "kubectl", "exec"));
  });
  test("public URL setup failure is returned after a successful Helm apply", () => {
    const result = run(["test"], { MOCK_SETUP_EXIT: "23" });
    assert.equal(result.status, 23);
    assert.match(result.stderr, /Helm completed, but public URL setup failed/);
  });
  test("invalid effective ingress is never passed to setup", () => {
    const result = run(["test"], { MOCK_GET_HOST: "user@host.example/path" });
    assert.equal(result.status, 1);
    assert(command(result, "helm", "upgrade"));
    assert(!command(result, "kubectl", "exec"));
  });
  test("an effective secondary TLS secret does not satisfy the primary TLS requirement", () => {
    for (const extra of [{ MOCK_GET_TLS_ENABLED: "false" }, { MOCK_GET_TLS_SECRET: "" }]) {
      const result = run(["prod"], { MOCK_SECONDARY_HOST: "connect.genosyn.com", ...extra });
      assert.equal(result.status, 1, result.output);
      assert(command(result, "helm", "upgrade"));
      assert(!command(result, "kubectl", "exec"));
    }
  });
  test("mutable tags, malformed email, unknown environment and extra flags fail locally", () => {
    for (const extra of [{ GENOSYN_IMAGE_TAG: "latest" }, { GENOSYN_IMAGE_TAG: "main" }, { GENOSYN_IMAGE_TAG: "release" }, { GENOSYN_BOOTSTRAP_ADMIN_EMAIL: "ops@example.com,image.tag=main" }, { GENOSYN_BOOTSTRAP_ADMIN_EMAIL: "ops..admin@example.com" }]) {
      const result = run(["test"], extra);
      assert.equal(result.status, 1);
      assert.equal(result.rows.length, 0);
    }
    for (const args of [["dev"], ["prod", "--namespace=default"], ["test", "--template", "--wait"]]) {
      const result = run(args);
      assert.equal(result.status, 1);
      assert.equal(result.rows.length, 0);
    }
  });
} finally {
  fs.rmSync(testRoot, { recursive: true, force: true });
}
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
NODE
