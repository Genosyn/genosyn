{{/*
Expand the name of the chart.
*/}}
{{- define "genosyn.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name (63-char DNS limit).
*/}}
{{- define "genosyn.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Chart name and version as used by the chart label.
*/}}
{{- define "genosyn.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "genosyn.labels" -}}
helm.sh/chart: {{ include "genosyn.chart" . }}
{{ include "genosyn.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "genosyn.selectorLabels" -}}
app.kubernetes.io/name: {{ include "genosyn.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
The app image reference. An empty tag falls back to the chart appVersion —
image tags carry no `v` prefix, so appVersion is usable verbatim.
*/}}
{{- define "genosyn.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) }}
{{- end }}

{{/*
The ConfigMap carrying config.js. The upgrade guard in genosyn.validate looks
up a release's existing one by this same name.
*/}}
{{- define "genosyn.configName" -}}
{{- printf "%s-config" (include "genosyn.fullname" .) }}
{{- end }}

{{/*
Effective database driver: the bundled Postgres implies postgres.
*/}}
{{- define "genosyn.dbDriver" -}}
{{- if .Values.postgres.enabled }}postgres{{- else }}{{ .Values.config.db.driver }}{{- end }}
{{- end }}

{{/*
Bundled Postgres object names.
*/}}
{{- define "genosyn.postgres.fullname" -}}
{{- printf "%s-postgres" (include "genosyn.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
The secret holding the bundled Postgres password, and the key inside it.
*/}}
{{- define "genosyn.postgres.secretName" -}}
{{- if .Values.postgres.passwordSecret.name }}{{ .Values.postgres.passwordSecret.name }}{{- else }}{{ include "genosyn.postgres.fullname" . }}{{- end }}
{{- end }}

{{- define "genosyn.postgres.secretKey" -}}
{{- if .Values.postgres.passwordSecret.name }}{{ .Values.postgres.passwordSecret.key | default "password" }}{{- else }}password{{- end }}
{{- end }}

{{/*
The chart-managed Secret carrying sessionSecret + encryptionSecret when
secrets.existingSecret is not set.
*/}}
{{- define "genosyn.instanceSecretsName" -}}
{{- printf "%s-instance-secrets" (include "genosyn.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Resolve Secret data after validation. The actual templates supply lookup's
result; keeping resolution separate also lets offline checks exercise upgrades.
Never put a supplied or stored value in a failure message.
*/}}
{{- define "genosyn.instanceSecretData" -}}
{{- $session := default "" .values.sessionSecret -}}
{{- $encryption := default "" .values.encryptionSecret -}}
{{- if .existing -}}
{{- if not (and .existing.data (index .existing.data "sessionSecret") (index .existing.data "encryptionSecret")) -}}
{{- fail "The existing chart-managed instance Secret is incomplete; restore it from backup before deploying. No keys were generated or changed." -}}
{{- end -}}
{{- if and $session (or (ne ($session | b64enc) (index .existing.data "sessionSecret")) (ne ($encryption | b64enc) (index .existing.data "encryptionSecret"))) -}}
{{- fail "Inline instance secrets do not match the existing chart-managed Secret. Supply its current values; key rotation requires a separate migration." -}}
{{- end -}}
{{- toYaml (dict "sessionSecret" (index .existing.data "sessionSecret") "encryptionSecret" (index .existing.data "encryptionSecret")) -}}
{{- else if $session -}}
{{- toYaml (dict "sessionSecret" ($session | b64enc) "encryptionSecret" ($encryption | b64enc)) -}}
{{- else -}}
{{- toYaml (dict "sessionSecret" (randAlphaNum 48 | b64enc) "encryptionSecret" (randAlphaNum 48 | b64enc)) -}}
{{- end -}}
{{- end -}}

{{- define "genosyn.postgresSecretData" -}}
{{- $password := default "" .values.password -}}
{{- if .existing -}}
{{- if not (and .existing.data (index .existing.data "password")) -}}
{{- fail "The existing chart-managed Postgres Secret is incomplete; restore its password before deploying. No password was generated or changed." -}}
{{- end -}}
{{- if and $password (ne ($password | b64enc) (index .existing.data "password")) -}}
{{- fail "postgres.password does not match the existing chart-managed Secret. Supply its current value; changing the database password requires a separate migration." -}}
{{- end -}}
{{- toYaml (dict "password" (index .existing.data "password")) -}}
{{- else if $password -}}
{{- toYaml (dict "password" ($password | b64enc)) -}}
{{- else -}}
{{- toYaml (dict "password" (randAlphaNum 32 | b64enc)) -}}
{{- end -}}
{{- end -}}

{{/*
Resolve the provider-neutral Connect host. Empty defaults let a reused legacy
gmailSignIn block work, while every explicit connect field (even false/empty)
takes precedence. Neither setting ever creates a second App Service.
*/}}
{{- define "genosyn.connectIngress" -}}
{{- $connect := dict "enabled" false "host" "" "tlsSecretName" "" -}}
{{- range $name := list "gmailSignIn" "connect" -}}
{{- if hasKey $.Values.ingress $name -}}
{{- $settings := get $.Values.ingress $name -}}
{{- if not (kindIs "map" $settings) -}}
{{- fail (printf "ingress.%s must be a settings object" $name) -}}
{{- end -}}
{{- range $field := list "enabled" "host" "tlsSecretName" -}}
{{- if hasKey $settings $field -}}
{{- $_ := set $connect $field (get $settings $field) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- if not (kindIs "bool" $connect.enabled) -}}
{{- fail "ingress.connect.enabled must be a boolean (legacy ingress.gmailSignIn is also supported)" -}}
{{- end -}}
{{- if or (not (kindIs "string" $connect.host)) (not (kindIs "string" $connect.tlsSecretName)) -}}
{{- fail "ingress.connect.host and ingress.connect.tlsSecretName must be strings (legacy ingress.gmailSignIn is also supported)" -}}
{{- end -}}
{{- toYaml $connect -}}
{{- end -}}

{{/*
Opt-in integrations, read defensively: values reused from an older release
(`helm upgrade --reuse-values`) lack these blocks entirely. Each boolean helper
renders "true" or nothing, so it can be used directly in `if`.
*/}}
{{- define "genosyn.gke.enabled" -}}
{{- if (default dict .Values.gke).enabled }}true{{ end -}}
{{- end -}}

{{- define "genosyn.gke.managedCertificate" -}}
{{- $gke := default dict .Values.gke -}}
{{- if and $gke.enabled (default dict $gke.managedCertificate).enabled }}true{{ end -}}
{{- end -}}

{{- define "genosyn.gke.backendConfigName" -}}
{{- printf "%s-backend" (include "genosyn.fullname" . | trunc 55 | trimSuffix "-") }}
{{- end -}}

{{- define "genosyn.gke.frontendConfigName" -}}
{{- printf "%s-frontend" (include "genosyn.fullname" . | trunc 54 | trimSuffix "-") }}
{{- end -}}

{{- define "genosyn.gke.managedCertificateName" -}}
{{- (default dict (default dict .Values.gke).managedCertificate).name | default (include "genosyn.fullname" .) }}
{{- end -}}

{{/* The Ingress terminates TLS: from Secrets, or a Google-managed certificate. */}}
{{- define "genosyn.ingressTls" -}}
{{- if and .Values.ingress.enabled (or .Values.ingress.tls.enabled (include "genosyn.gke.managedCertificate" .)) }}true{{ end -}}
{{- end -}}

{{/*
The public HTTPS origin the post-install Job stores, or nothing. The Job
reaches only the database, so SQLite installs, whose database lives on the
App's volume, go without it.
*/}}
{{- define "genosyn.publicUrl" -}}
{{- if eq (include "genosyn.dbDriver" .) "postgres" -}}
{{- $explicit := default "" .Values.config.publicUrl | trim | trimSuffix "/" -}}
{{- if $explicit -}}
{{- $explicit -}}
{{- else if and (include "genosyn.ingressTls" .) .Values.ingress.host -}}
{{- printf "https://%s" .Values.ingress.host -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Proxy hops in front of the App. GKE's load balancer appends both the client's
address and its own to X-Forwarded-For; config.extraJs can still override.
*/}}
{{- define "genosyn.trustedProxyHops" -}}
{{- if include "genosyn.gke.enabled" . }}2{{ else }}1{{ end -}}
{{- end -}}

{{/*
The config.js in lookup's copy of a release's ConfigMap, or nothing for a
fresh install and for offline renders.
*/}}
{{- define "genosyn.existingConfigJs" -}}
{{- get (default dict (get (default dict .) "data")) "config.js" | toString -}}
{{- end -}}

{{/*
The chart runs Genosyn single-tenant: one organization per install. Older
charts defaulted to shared multi-tenant mode, so upgrading such a release
needs an explicit config.multiTenant=false once. genosyn.validate passes
lookup's copy of the release's ConfigMap as `existing`; keeping this separate
lets offline checks exercise upgrades. Renders one problem, or nothing.
*/}}
{{- define "genosyn.tenancyProblem" -}}
{{- $setting := index .config "multiTenant" -}}
{{- $confirmed := and (kindIs "bool" $setting) (not $setting) -}}
{{- $existingJs := include "genosyn.existingConfigJs" .existing -}}
{{- if and (regexMatch "(?m)^\\s*multiTenant:\\s*true\\b" $existingJs) (not $confirmed) -}}
This release ran in shared multi-tenant mode, and this chart runs Genosyn single-tenant (one organization per install): AI Employee commands run in the App container with access to every company's data in this install. If one organization uses this install, set config.multiTenant=false once to confirm. If it serves several unrelated organizations, give each its own install instead.
{{- else if and (not (kindIs "invalid" $setting)) (not $confirmed) -}}
Shared multi-tenant mode is not supported: the chart runs Genosyn single-tenant only (one organization per install) — fix: remove config.multiTenant
{{- end -}}
{{- end -}}

{{/*
Bubblewrap isolation was removed, and the chart never moves a release onto
host execution unasked: values that still enable the sandbox, or a release
whose ConfigMap ran it, need an explicit sandbox.enabled=false once. A
multi-tenant release is genosyn.tenancyProblem's case. Every other sandbox key
is ignored. Takes the same `existing` as genosyn.tenancyProblem; renders one
problem, or nothing.
*/}}
{{- define "genosyn.sandboxProblem" -}}
{{- $sandbox := ternary .sandbox dict (kindIs "map" .sandbox) -}}
{{- $enabled := index $sandbox "enabled" -}}
{{- $confirmed := and (kindIs "bool" $enabled) (not $enabled) -}}
{{- $existingJs := include "genosyn.existingConfigJs" .existing -}}
{{- $ranSandbox := and (regexMatch "(?m)^\\s*executionMode:\\s*\"bubblewrap\"" $existingJs) (not (regexMatch "(?m)^\\s*multiTenant:\\s*true\\b" $existingJs)) -}}
{{- if and (or (not (kindIs "invalid" $enabled)) $ranSandbox) (not $confirmed) -}}
Bubblewrap isolation was removed: AI Employee commands now run in the App container without an OS sandbox, with the App user's filesystem and network access — fix: set sandbox.enabled=false once to confirm
{{- end -}}
{{- end -}}

{{/*
Environment shared by the App container and the public URL Job, so the Job
opens the same database with the same secrets.
*/}}
{{- define "genosyn.appEnv" -}}
{{- $instanceSecret := .Values.secrets.existingSecret | default (include "genosyn.instanceSecretsName" .) -}}
# Always injected: from secrets.existingSecret when set, else the
# chart-generated instance secrets. Not `optional` — a missing key
# must block the pod, never let boot fall through to placeholders.
- name: GENOSYN_SESSION_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ $instanceSecret }}
      key: sessionSecret
- name: GENOSYN_ENCRYPTION_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ $instanceSecret }}
      key: encryptionSecret
{{- if .Values.config.db.postgresUrlSecret.name }}
- name: GENOSYN_POSTGRES_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.config.db.postgresUrlSecret.name }}
      key: {{ .Values.config.db.postgresUrlSecret.key | default "url" }}
{{- else if .Values.postgres.enabled }}
- name: GENOSYN_POSTGRES_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "genosyn.postgres.secretName" . }}
      key: {{ include "genosyn.postgres.secretKey" . }}
- name: GENOSYN_POSTGRES_URL
  value: "postgresql://{{ .Values.postgres.username }}:$(GENOSYN_POSTGRES_PASSWORD)@{{ include "genosyn.postgres.fullname" . }}:5432/{{ .Values.postgres.database }}"
{{- end }}
{{- with .Values.env }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/*
Fail fast — at template time, aggregated — when the configuration cannot be
deployed as intended. Catching chart-supplied mistakes here turns a
CrashLoopBackOff or a failed hook into one actionable `helm install` error.
Every problem is collected before failing so one attempt reports EVERYTHING
wrong at once, not one error per attempt. Included from deployment.yaml so it
runs on every render.
*/}}
{{- define "genosyn.validate" -}}
{{- $problems := list -}}
{{- $existingConfig := lookup "v1" "ConfigMap" .Release.Namespace (include "genosyn.configName" .) -}}
{{- with include "genosyn.tenancyProblem" (dict "config" .Values.config "existing" $existingConfig) -}}
{{- $problems = append $problems . -}}
{{- end -}}
{{- with include "genosyn.sandboxProblem" (dict "sandbox" .Values.sandbox "existing" $existingConfig) -}}
{{- $problems = append $problems . -}}
{{- end -}}
{{- $session := get .Values.secrets "sessionSecret" -}}
{{- $encryption := get .Values.secrets "encryptionSecret" -}}
{{- $password := get .Values.postgres "password" -}}
{{- if or (not (kindIs "string" $session)) (not (kindIs "string" $encryption)) -}}
{{- $problems = append $problems "secrets.sessionSecret and secrets.encryptionSecret must be strings" -}}
{{- else if or $session $encryption -}}
{{- if or (lt (len ($session | trim)) 32) (lt (len ($encryption | trim)) 32) -}}
{{- $problems = append $problems "secrets.sessionSecret and secrets.encryptionSecret must be supplied together and each contain at least 32 characters" -}}
{{- end -}}
{{- if eq $session $encryption -}}
{{- $problems = append $problems "secrets.sessionSecret and secrets.encryptionSecret must be different" -}}
{{- end -}}
{{- if .Values.secrets.existingSecret -}}
{{- $problems = append $problems "Inline instance secrets cannot be combined with secrets.existingSecret" -}}
{{- end -}}
{{- end -}}
{{- if not (kindIs "string" $password) -}}
{{- $problems = append $problems "postgres.password must be a string" -}}
{{- else if $password -}}
{{- if not .Values.postgres.enabled -}}
{{- $problems = append $problems "postgres.password requires postgres.enabled=true; external databases use config.db.postgresUrlSecret" -}}
{{- end -}}
{{- if not (regexMatch "^[A-Za-z0-9._~-]+$" $password) -}}
{{- $problems = append $problems "postgres.password must use URL-safe letters, digits, '.', '_', '~', or '-'" -}}
{{- end -}}
{{- if .Values.postgres.passwordSecret.name -}}
{{- $problems = append $problems "postgres.password cannot be combined with postgres.passwordSecret.name" -}}
{{- end -}}
{{- end -}}
{{- $connect := include "genosyn.connectIngress" . | fromYaml -}}
{{- if $connect.enabled -}}
{{- if not (include "genosyn.ingressTls" .) -}}
{{- $problems = append $problems "ingress.connect.enabled requires ingress.enabled=true and ingress.tls.enabled=true (or gke.managedCertificate.enabled=true)" -}}
{{- end -}}
{{- $signInHost := $connect.host -}}
{{- if or (gt (len $signInHost) 253) (not (regexMatch "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$" $signInHost)) (regexMatch "^[0-9]+(\\.[0-9]+){3}$" $signInHost) -}}
{{- $problems = append $problems "ingress.connect.host must be a valid lowercase DNS hostname without a scheme, port, path, wildcard, or IP address" -}}
{{- end -}}
{{- if eq (lower $signInHost) (lower (default "" .Values.ingress.host)) -}}
{{- $problems = append $problems "ingress.connect.host must differ from ingress.host" -}}
{{- end -}}
{{- if and .Values.ingress.tls.enabled (not ($connect.tlsSecretName | trim)) -}}
{{- $problems = append $problems "ingress.connect.tlsSecretName is required when ingress.connect.enabled uses ingress.tls" -}}
{{- end -}}
{{- end -}}
{{- $gke := default dict .Values.gke -}}
{{- if (default dict $gke.managedCertificate).enabled -}}
{{- if not $gke.enabled -}}
{{- $problems = append $problems "gke.managedCertificate.enabled requires gke.enabled=true" -}}
{{- else if or (not .Values.ingress.enabled) (not .Values.ingress.host) -}}
{{- $problems = append $problems "gke.managedCertificate.enabled requires ingress.enabled=true and ingress.host" -}}
{{- end -}}
{{- if .Values.ingress.tls.enabled -}}
{{- $problems = append $problems "gke.managedCertificate.enabled and ingress.tls.enabled are alternatives; enable one" -}}
{{- end -}}
{{- end -}}
{{- $certManager := default dict .Values.ingress.tls.certManager -}}
{{- if $certManager.enabled -}}
{{- if or (not .Values.ingress.enabled) (not .Values.ingress.host) (not .Values.ingress.tls.enabled) (not (default "" .Values.ingress.tls.secretName | trim)) -}}
{{- $problems = append $problems "ingress.tls.certManager.enabled requires ingress.enabled=true, ingress.host, ingress.tls.enabled=true and ingress.tls.secretName" -}}
{{- end -}}
{{- $issuerRef := default dict $certManager.issuerRef -}}
{{- if and (gt (len $issuerRef) 0) (not $issuerRef.name) -}}
{{- $problems = append $problems "ingress.tls.certManager.issuerRef needs a name, or leave it empty to use the chart's own Issuer" -}}
{{- end -}}
{{- end -}}
{{- /*
The public URL Job hands config.publicUrl to the App's setup script on every
install and upgrade, so a malformed value would fail each of them after the
fact. HTTPS keeps the App's "auto" Secure session cookies on.
*/ -}}
{{- $publicUrl := default "" .Values.config.publicUrl | trim -}}
{{- if and $publicUrl (not (regexMatch "^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]+)?/?$" $publicUrl)) -}}
{{- $problems = append $problems "config.publicUrl must be an https:// origin with a lowercase host and no path, e.g. https://genosyn.example.com" -}}
{{- end -}}
{{- if and (eq (include "genosyn.dbDriver" .) "postgres") (not .Values.postgres.enabled) (not .Values.config.db.postgresUrlSecret.name) -}}
{{- $problems = append $problems "config.db.driver=postgres needs a database — fix: --set postgres.enabled=true (bundled, evaluation only) or point config.db.postgresUrlSecret.name/key at a Secret holding the connection URL" -}}
{{- end -}}
{{- if gt (len $problems) 0 -}}
{{- fail (printf "\n\nGenosyn cannot be deployed with this configuration:\n\n- %s\n" (join "\n\n- " $problems)) -}}
{{- end -}}
{{- end }}
