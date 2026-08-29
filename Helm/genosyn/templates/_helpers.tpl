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
Fail fast — at template time, aggregated — when the configuration cannot boot.
Genosyn's multi-tenant startup validation (App/server/services/runtimeSecurity.ts)
refuses to boot a shared SaaS below its baseline; catching the chart-supplied
parts here turns a CrashLoopBackOff twenty minutes in into one actionable
`helm install` error. Every problem is collected before failing so a bare
install reports EVERYTHING missing at once, not one error per attempt.
Included from deployment.yaml so it runs on every render.
*/}}
{{- define "genosyn.validate" -}}
{{- $problems := list -}}
{{- if .Values.config.multiTenant -}}
{{- if not (default "" .Values.config.bootstrapMasterAdminEmail | trim) -}}
{{- $problems = append $problems "config.bootstrapMasterAdminEmail is required (multi-tenant bootstrap predeclares the only email allowed to claim the first master admin) — fix: --set config.bootstrapMasterAdminEmail=you@example.com" -}}
{{- end -}}
{{- if not (default "" .Values.config.smtp.host | trim) -}}
{{- $problems = append $problems "config.smtp.host is required (multi-tenant boot refuses without a system SMTP for verification and recovery mail) — fix: --set config.smtp.host=smtp.example.com" -}}
{{- end -}}
{{- if not .Values.sandbox.enabled -}}
{{- $problems = append $problems "sandbox.enabled must be true (multi-tenant boot refuses without a working bubblewrap sandbox) — fix: --set sandbox.enabled=true" -}}
{{- end -}}
{{- if ne (include "genosyn.dbDriver" .) "postgres" -}}
{{- $problems = append $problems "config.db.driver must be postgres (multi-tenant mode refuses SQLite) — fix: --set config.db.driver=postgres" -}}
{{- end -}}
{{- end -}}
{{- if and (eq (include "genosyn.dbDriver" .) "postgres") (not .Values.postgres.enabled) (not .Values.config.db.postgresUrlSecret.name) -}}
{{- $problems = append $problems "config.db.driver=postgres needs a database — fix: --set postgres.enabled=true (bundled, evaluation only) or point config.db.postgresUrlSecret.name/key at a Secret holding the connection URL" -}}
{{- end -}}
{{- if gt (len $problems) 0 -}}
{{- fail (printf "\n\nGenosyn cannot boot with this configuration:\n\n- %s\n\nThe chart default is production multi-tenant SaaS. For a single-tenant self-host install, use: helm install ... -f values-selfhost.yaml" (join "\n\n- " $problems)) -}}
{{- end -}}
{{- end }}
