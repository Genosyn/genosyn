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
