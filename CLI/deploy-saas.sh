#!/usr/bin/env bash
# Deploy an existing, versioned image using the repository's SaaS Helm profile.
# --template renders locally without Kubernetes access.
set -euo pipefail
# Helm debug output can include complete manifests and private values.
unset HELM_DEBUG

usage() {
  echo "Usage: bash CLI/deploy-saas.sh test|prod [--template]" >&2
}

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  usage
  exit 1
fi
environment="$1"
case "$environment" in
  test|prod) ;;
  *) usage; exit 1 ;;
esac
template_only=false
if [ "$#" -eq 2 ]; then
  [ "$2" = "--template" ] || { usage; exit 1; }
  template_only=true
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
chart_dir="${repo_root}/Helm/genosyn"
values_file="${repo_root}/Helm/Values/${environment}.values.yaml"
release=genosyn
# Each environment has its own namespace unless the operator names one.
namespace="${GENOSYN_NAMESPACE:-genosyn-${environment}}"

fail() { echo "$*" >&2; exit 1; }
require_command() { command -v "$1" >/dev/null 2>&1 || fail "Required command is unavailable: $1"; }
namespace_pattern='^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$'
[[ "$namespace" =~ $namespace_pattern ]] || fail "GENOSYN_NAMESPACE must be a Kubernetes namespace name: lowercase letters, digits and hyphens."
require_command helm
require_command node
[ -f "$values_file" ] || fail "Missing deployment profile: ${values_file}"
[ -f "${repo_root}/VERSION" ] || fail "Missing repository VERSION file."
version="$(cat "${repo_root}/VERSION")"
semver_pattern='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
[[ "$version" =~ $semver_pattern ]] || fail "VERSION must contain a release version such as 1.200.0."
image_tag="${GENOSYN_IMAGE_TAG:-$version}"
sha_pattern='^sha-[a-f0-9]{7,40}$'
if ! [[ "$image_tag" =~ $semver_pattern ]] && ! [[ "$image_tag" =~ $sha_pattern ]]; then
  fail "GENOSYN_IMAGE_TAG must be a release version or a pinned sha-<commit> tag."
fi

value_args=(-f "$values_file" --set-string "image.tag=${image_tag}")
if [ -n "${GENOSYN_BOOTSTRAP_ADMIN_EMAIL:-}" ]; then
  email_pattern='^[[:alnum:]_%+-]+(\.[[:alnum:]_%+-]+)*@[[:alnum:]]([[:alnum:]-]*[[:alnum:]])?(\.[[:alnum:]]([[:alnum:]-]*[[:alnum:]])?)+$'
  [[ "$GENOSYN_BOOTSTRAP_ADMIN_EMAIL" =~ $email_pattern ]] || fail "GENOSYN_BOOTSTRAP_ADMIN_EMAIL must be a valid email address."
  value_args+=(--set-string "config.bootstrapMasterAdminEmail=${GENOSYN_BOOTSTRAP_ADMIN_EMAIL}")
fi

umask 077
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/genosyn-deploy.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT
chart_archive="${work_dir}/genosyn-${version}.tgz"
helm package "$chart_dir" --version "$version" --app-version "$version" --destination "$work_dir" >/dev/null
helm lint "$chart_archive" "${value_args[@]}" >&2
helm template "$release" "$chart_archive" --namespace "$namespace" "${value_args[@]}" >"${work_dir}/rendered.yaml"
helm template "$release" "$chart_archive" --namespace "$namespace" "${value_args[@]}" \
  --show-only templates/ingress.yaml >"${work_dir}/ingress.yaml"

# The first input is the chart's own fixed ingress template, not arbitrary YAML.
# Its first rule is always ingress.host; an optional Gmail sign-in rule must
# never become the main App public URL. After deployment, inspect Helm's
# effective values as JSON. Only the validated origin leaves this function.
public_origin() {
  node - "$1" "$2" <<'NODE'
const fs = require("node:fs");
try {
  const [format, path] = process.argv.slice(2);
  const input = fs.readFileSync(path, "utf8");
  let host;
  if (format === "ingress") {
    const rules = [...input.matchAll(/^    - host: (.+)$/gm)];
    const tls = /\n  tls:\n([\s\S]*?)\n  rules:\n/.exec(input);
    // gke.managedCertificate terminates TLS at the load balancer, not from a Secret.
    const managed = /^    networking\.gke\.io\/managed-certificates: \S/m.test(input);
    if (rules.length < 1 || rules.length > 2 || (!tls && !managed)) throw new Error();
    host = JSON.parse(rules[0][1]);
    if (tls) {
      const primaryTls = tls[1].split(/(?=^    - hosts:$)/m).some(entry => {
        const hosts = [...entry.matchAll(/^        - (.+)$/gm)].map(match => JSON.parse(match[1]));
        const secret = /^      secretName: (.+)$/m.exec(entry)?.[1];
        const name = secret?.startsWith('"') ? JSON.parse(secret) : secret;
        return hosts.includes(host) && typeof name === "string" && Boolean(name.trim());
      });
      if (!primaryTls) throw new Error();
    }
  } else {
    const { ingress, gke } = JSON.parse(input);
    const managed = gke?.enabled === true && gke.managedCertificate?.enabled === true;
    const secretTls = ingress?.tls?.enabled === true && typeof ingress.tls.secretName === "string" && Boolean(ingress.tls.secretName.trim());
    if (ingress?.enabled !== true || !(secretTls || managed)) throw new Error();
    host = ingress.host;
  }
  if (typeof host !== "string" || host.length > 253 || !host.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) throw new Error();
  const url = new URL(`https://${host}`);
  if (url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) throw new Error();
  process.stdout.write(`${url.origin}\n`);
} catch {
  console.error("The SaaS profile must enable an ingress with a valid primary DNS host and matching TLS configuration.");
  process.exitCode = 1;
}
NODE
}

planned_origin="$(public_origin ingress "${work_dir}/ingress.yaml")"
if [ "$template_only" = true ]; then
  # Values may contain real credentials. Keep ordinary resources useful in the
  # preview, but omit complete Secret documents (including reversible base64).
  node - "${work_dir}/rendered.yaml" <<'NODE'
const fs = require("node:fs");
const rendered = fs.readFileSync(process.argv[2], "utf8");
for (const document of rendered.split(/(?=^---[ \t]*(?:#.*)?\r?$)/m)) {
  const secret = /^kind:[ \t]*(?:Secret|"Secret"|'Secret')[ \t]*(?:#.*)?\r?$/m.test(document);
  process.stdout.write(secret ? "---\n# Secret manifest omitted from preview.\n" : document);
}
NODE
  exit 0
fi

case "$environment" in
  test) context="${GENOSYN_KUBE_CONTEXT:-${GENOSYN_TEST_KUBE_CONTEXT:-}}" ;;
  prod) context="${GENOSYN_KUBE_CONTEXT:-${GENOSYN_PROD_KUBE_CONTEXT:-}}" ;;
esac
[[ "$context" =~ [^[:space:]] ]] || fail "Select a Kubernetes context with GENOSYN_KUBE_CONTEXT or GENOSYN_TEST_KUBE_CONTEXT / GENOSYN_PROD_KUBE_CONTEXT before deploying."
require_command kubectl
# Helm-only overrides can otherwise send this release to a different endpoint
# or identity than kubectl uses for the same context. Use kubeconfig for both.
unset HELM_KUBEAPISERVER HELM_KUBECAFILE HELM_KUBEASGROUPS HELM_KUBEASUSER \
  HELM_KUBECONTEXT HELM_KUBETOKEN HELM_KUBEINSECURE_SKIP_TLS_VERIFY \
  HELM_KUBETLS_SERVER_NAME HELM_NAMESPACE
# Read the operator's existing configuration without switching contexts or
# rewriting it. KUBECONFIG may name several files; leave its value untouched.
if ! available_context="$(kubectl --context "$context" --namespace "$namespace" \
  config get-contexts --output=name -- "$context" 2>"${work_dir}/context-error")"; then
  fail "Could not read the selected Kubernetes context from the existing kubeconfig."
fi
[ "$available_context" = "$context" ] || fail "The selected Kubernetes context was not found in the existing kubeconfig."
printf 'Deploying %s to %s (%s), image %s, public URL %s\n' "$release" "$namespace" "$context" "$image_tag" "$planned_origin"
cluster_args=(--kube-context "$context" --namespace "$namespace")
helm upgrade --install "$release" "$chart_archive" "${cluster_args[@]}" \
  --create-namespace --reset-values --wait --timeout 15m --history-max 10 "${value_args[@]}"

helm get values "$release" "${cluster_args[@]}" --all --output json >"${work_dir}/effective-values.json"
effective_origin="$(public_origin values "${work_dir}/effective-values.json")"
if kubectl --context "$context" --namespace "$namespace" \
  exec "deployment/${release}" -c app -- node /app/dist/server/scripts/setupPublicUrl.js --url "$effective_origin"; then
  printf 'App ready; public URL configured: %s\n' "$effective_origin"
  echo "Verify DNS and ingress TLS before onboarding Members."
else
  result=$?
  echo "Helm completed, but public URL setup failed. Resolve the setup error before opening this deployment to Members." >&2
  exit "$result"
fi
