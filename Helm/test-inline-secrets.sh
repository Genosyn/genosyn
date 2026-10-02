#!/usr/bin/env bash
# Offline chart regression checks. Uses only generated, synthetic test values;
# never loads an operator's private Helm/Values profiles or contacts a cluster.
set -euo pipefail
chart_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/genosyn"
node - "$chart_dir" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const chart = process.argv[2];
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'genosyn-inline-secrets-'));
const sessionSecret = 'synthetic-session-' + 's'.repeat(40);
const encryptionSecret = 'synthetic-encryption-' + 'e'.repeat(40);
const password = 'synthetic-password-' + 'p'.repeat(40);
const marker = 'SYNTHETIC_VALUE_MUST_NOT_APPEAR_IN_ERRORS';
const inline = { secrets: { sessionSecret, encryptionSecret }, postgres: { password } };
const encode = value => Buffer.from(value).toString('base64');
let checks = 0;
function render(values = {}, source = chart) {
  const valuesFile = path.join(scratch, 'values.json');
  fs.writeFileSync(valuesFile, JSON.stringify(values), { mode: 0o600 });
  return spawnSync('helm', ['template', 'genosyn', source, '--namespace', 'ci-secrets',
    '-f', valuesFile], { encoding: 'utf8' });
}
function successful(values, source) {
  const result = render(values, source);
  assert.equal(result.status, 0, 'synthetic Helm render must succeed');
  return result.stdout;
}
function rejected(values, expected, source) {
  const result = render(values, source);
  assert.notEqual(result.status, 0, 'invalid values must fail rendering');
  assert.match(result.stderr, expected, 'error must identify the invalid setting');
  for (const value of [sessionSecret, encryptionSecret, password, marker]) {
    assert(!result.stderr.includes(value), 'error must not disclose a supplied value');
    assert(!result.stderr.includes(encode(value)), 'error must not disclose encoded Secret data');
  }
  assert.equal(result.stdout.trim(), '', 'failed rendering must not emit manifests');
  return result.stderr;
}
function document(text, kind, name) {
  const found = text.split(/^---\s*$/m).find(block =>
    new RegExp(`^kind: ${kind}$`, 'm').test(block) && new RegExp(`^  name: ${name}$`, 'm').test(block));
  assert(found, `expected ${kind} ${name}`);
  return found;
}
function secretData(text, name) {
  const block = document(text, 'Secret', name).split('\ndata:\n')[1];
  return Object.fromEntries([...block.matchAll(/^  ([A-Za-z]+): (.+)$/gm)].map(([, key, raw]) =>
    [key, Buffer.from(raw.startsWith('"') ? JSON.parse(raw) : raw, 'base64').toString()]));
}
function secretRef(text, envName, name, key) {
  assert(text.includes(`- name: ${envName}\n              valueFrom:\n                secretKeyRef:\n                  name: ${name}\n                  key: ${key}`),
    `${envName} must reference the intended Secret key`);
}
function check(name, callback) {
  callback();
  checks++;
  process.stdout.write(`ok - ${name}\n`);
}
try {
  check('inline values render exact Secret bytes and workload references', () => {
    const text = successful(inline);
    assert.deepEqual(secretData(text, 'genosyn-instance-secrets'), inline.secrets);
    assert.deepEqual(secretData(text, 'genosyn-postgres'), { password });
    const app = document(text, 'Deployment', 'genosyn');
    const postgres = document(text, 'StatefulSet', 'genosyn-postgres');
    secretRef(app, 'GENOSYN_SESSION_SECRET', 'genosyn-instance-secrets', 'sessionSecret');
    secretRef(app, 'GENOSYN_ENCRYPTION_SECRET', 'genosyn-instance-secrets', 'encryptionSecret');
    secretRef(app, 'GENOSYN_POSTGRES_PASSWORD', 'genosyn-postgres', 'password');
    secretRef(postgres, 'POSTGRES_PASSWORD', 'genosyn-postgres', 'password');
    for (const value of [sessionSecret, encryptionSecret, password]) assert(!text.includes(value));
    for (const name of ['genosyn-instance-secrets', 'genosyn-postgres']) {
      assert.match(document(text, 'Secret', name), /"helm.sh\/resource-policy": keep/);
    }
  });
  check('empty defaults still generate independent instance roots and database password', () => {
    const text = successful({});
    const roots = secretData(text, 'genosyn-instance-secrets');
    assert.match(roots.sessionSecret, /^[A-Za-z0-9]{48}$/);
    assert.match(roots.encryptionSecret, /^[A-Za-z0-9]{48}$/);
    assert.notEqual(roots.sessionSecret, roots.encryptionSecret);
    assert.match(secretData(text, 'genosyn-postgres').password, /^[A-Za-z0-9]{32}$/);
  });
  check('existing Secret references omit managed Secrets and preserve workload wiring', () => {
    const text = successful({ secrets: { existingSecret: 'ci-instance' },
      postgres: { passwordSecret: { name: 'ci-database', key: 'credential' } } });
    assert(!/^kind: Secret$/m.test(text));
    secretRef(text, 'GENOSYN_SESSION_SECRET', 'ci-instance', 'sessionSecret');
    secretRef(text, 'GENOSYN_ENCRYPTION_SECRET', 'ci-instance', 'encryptionSecret');
    secretRef(text, 'GENOSYN_POSTGRES_PASSWORD', 'ci-database', 'credential');
    secretRef(text, 'POSTGRES_PASSWORD', 'ci-database', 'credential');
  });
  check('instance roots must be paired, strong, and distinct', () => {
    for (const secrets of [{ sessionSecret }, { encryptionSecret },
      { sessionSecret: 'short', encryptionSecret }, { sessionSecret, encryptionSecret: ' '.repeat(32) }]) {
      rejected({ secrets }, /must be supplied together and each contain at least 32 characters/);
    }
    rejected({ secrets: { sessionSecret, encryptionSecret: sessionSecret } }, /must be different/);
  });
  check('inline values cannot compete with existing Secret references', () => {
    rejected({ secrets: { ...inline.secrets, existingSecret: 'ci-instance' } }, /cannot be combined with secrets.existingSecret/);
    rejected({ postgres: { password, passwordSecret: { name: 'ci-database' } } }, /cannot be combined with postgres.passwordSecret.name/);
  });
  check('bundled database password is URL-safe and requires bundled Postgres', () => {
    for (const password of ['has:colon', 'has/slash', 'has%escape', 'has space', 'has@sign']) {
      rejected({ postgres: { password } }, /postgres.password must use URL-safe/);
    }
    rejected({ postgres: { enabled: false, password }, config: { db: { postgresUrlSecret: { name: 'ci-external' } } } },
      /postgres.password requires postgres.enabled=true/);
    const text = successful({ postgres: { password: 'URL-safe.password_123~test' } });
    assert.equal(secretData(text, 'genosyn-postgres').password, 'URL-safe.password_123~test');
  });
  check('non-string inline values fail without disclosing their contents', () => {
    for (const value of [{ sensitive: marker }, [marker], false, 123]) {
      rejected({ secrets: { sessionSecret: value, encryptionSecret } }, /must be strings/);
      rejected({ secrets: { sessionSecret, encryptionSecret: value } }, /must be strings/);
      rejected({ postgres: { password: value } }, /postgres.password must be a string/);
    }
  });

  // Inject synthetic lookup results into the same named data helpers called by
  // the real Secret templates, without needing cluster access or a chart knob.
  const upgradeChart = path.join(scratch, 'upgrade');
  fs.mkdirSync(path.join(upgradeChart, 'templates'), { recursive: true });
  for (const file of ['Chart.yaml', 'values.yaml', 'templates/_helpers.tpl']) {
    fs.copyFileSync(path.join(chart, file), path.join(upgradeChart, file));
  }
  for (const [file, helper] of [['instance-secrets.yaml', 'instanceSecretData'], ['postgres-secret.yaml', 'postgresSecretData']]) {
    const template = fs.readFileSync(path.join(chart, 'templates', file), 'utf8');
    assert(template.includes('lookup "v1" "Secret" .Release.Namespace $secretName'));
    assert.match(template, new RegExp(`include "genosyn.${helper}" .*"existing" \\$existing`));
  }
  fs.writeFileSync(path.join(upgradeChart, 'templates/check.yaml'), `{{- include "genosyn.validate" . }}
apiVersion: v1
kind: Secret
metadata:
  name: fixture-instance
data:
  {{- include "genosyn.instanceSecretData" (dict "values" .Values.secrets "existing" .Values.fixtureInstance) | nindent 2 }}
---
apiVersion: v1
kind: Secret
metadata:
  name: fixture-postgres
data:
  {{- include "genosyn.postgresSecretData" (dict "values" .Values.postgres "existing" .Values.fixturePostgres) | nindent 2 }}
`);
  const existing = {
    fixtureInstance: { data: { sessionSecret: encode(sessionSecret), encryptionSecret: encode(encryptionSecret) } },
    fixturePostgres: { data: { password: encode(password) } },
  };
  check('upgrades preserve existing Secret bytes with empty or matching inline settings', () => {
    for (const supplied of [{}, inline]) {
      const text = successful({ ...existing, ...supplied }, upgradeChart);
      assert.deepEqual(secretData(text, 'fixture-instance'), inline.secrets);
      assert.deepEqual(secretData(text, 'fixture-postgres'), { password });
    }
  });
  check('upgrades reject changes instead of rotating or ignoring supplied values', () => {
    for (const key of ['sessionSecret', 'encryptionSecret']) {
      rejected({ ...existing, secrets: { ...inline.secrets, [key]: marker } }, /Inline instance secrets do not match/, upgradeChart);
    }
    rejected({ ...existing, postgres: { password: marker } }, /postgres.password does not match/, upgradeChart);
  });
  check('incomplete existing Secrets fail instead of generating replacement keys', () => {
    rejected({ ...existing, fixtureInstance: { data: { sessionSecret: encode(sessionSecret) } } }, /instance Secret is incomplete/, upgradeChart);
    rejected({ ...existing, fixturePostgres: { data: {} } }, /Postgres Secret is incomplete/, upgradeChart);
  });
  check('older reused chart values remain valid when new inline fields are absent', () => {
    const valuesPath = path.join(upgradeChart, 'values.yaml');
    const values = fs.readFileSync(valuesPath, 'utf8').replace(/^  (sessionSecret|encryptionSecret|password): ""\n/gm, '');
    assert(!/^  (sessionSecret|encryptionSecret|password):/m.test(values));
    fs.writeFileSync(valuesPath, values);
    const text = successful(existing, upgradeChart);
    assert.deepEqual(secretData(text, 'fixture-instance'), inline.secrets);
    assert.deepEqual(secretData(text, 'fixture-postgres'), { password });
  });

  // The tenancy and sandbox guards read the release's existing ConfigMap the
  // same way: validate passes lookup's result to helpers this fixture feeds.
  const helpers = fs.readFileSync(path.join(chart, 'templates/_helpers.tpl'), 'utf8');
  assert(helpers.includes('$existingConfig := lookup "v1" "ConfigMap" .Release.Namespace (include "genosyn.configName" .)'));
  assert(helpers.includes('include "genosyn.tenancyProblem" (dict "config" .Values.config "existing" $existingConfig)'));
  assert(helpers.includes('include "genosyn.sandboxProblem" (dict "sandbox" .Values.sandbox "existing" $existingConfig)'));
  assert(fs.readFileSync(path.join(chart, 'templates/configmap.yaml'), 'utf8').includes('name: {{ include "genosyn.configName" . }}'));
  const tenancyChart = path.join(scratch, 'tenancy');
  fs.mkdirSync(path.join(tenancyChart, 'templates'), { recursive: true });
  for (const file of ['Chart.yaml', 'values.yaml', 'templates/_helpers.tpl']) {
    fs.copyFileSync(path.join(chart, file), path.join(tenancyChart, file));
  }
  fs.writeFileSync(path.join(tenancyChart, 'templates/check.yaml'), `{{- $problems := list }}
{{- with include "genosyn.tenancyProblem" (dict "config" .Values.config "existing" .Values.fixtureConfig) }}{{ $problems = append $problems . }}{{ end }}
{{- with include "genosyn.sandboxProblem" (dict "sandbox" .Values.sandbox "existing" .Values.fixtureConfig) }}{{ $problems = append $problems . }}{{ end }}
{{- if $problems }}{{ fail (join "\\n- " $problems) }}{{ end }}
apiVersion: v1
kind: ConfigMap
metadata:
  name: fixture-tenancy
data: {}
`);
  // This chart's own config.js, and what older charts rendered: the sandbox on
  // its own, and the old default of multi-tenant mode in the sandbox.
  const rendered = spawnSync('helm', ['template', 'genosyn', chart, '-s', 'templates/configmap.yaml'], { encoding: 'utf8' });
  assert.equal(rendered.status, 0);
  const singleTenantJs = rendered.stdout.split('\n  config.js: |\n')[1].replace(/^    /gm, '');
  const sandboxedJs = singleTenantJs.replace('  executionMode: "host",\n', '  executionMode: "bubblewrap",\n');
  const multiTenantJs = sandboxedJs.replace('  multiTenant: false,\n', '  multiTenant: true,\n');
  assert(singleTenantJs !== sandboxedJs && sandboxedJs !== multiTenantJs);
  const previous = js => ({ fixtureConfig: { data: { 'config.js': js } } });
  const upgradeGuard = /This release ran in shared multi-tenant mode.*access to every company's data in this install.*set config\.multiTenant=false once to confirm.*give each its own install instead/;
  const unsupported = /the chart runs Genosyn single-tenant only \(one organization per install\) — fix: remove config\.multiTenant/;
  const sandboxGuard = /Bubblewrap isolation was removed: AI Employee commands now run in the App container without an OS sandbox.*fix: set sandbox\.enabled=false once to confirm/;
  const staleSandbox = { hostUsers: false, appArmorProfile: 'Unconfined' };
  check('fresh and single-tenant releases need no tenancy setting, and reject multiTenant=true', () => {
    for (const fixture of [{}, previous(singleTenantJs)]) {
      successful(fixture, tenancyChart);
      successful({ ...fixture, config: { multiTenant: false } }, tenancyChart);
      rejected({ ...fixture, config: { multiTenant: true } }, unsupported, tenancyChart);
    }
  });
  check('upgrading a multi-tenant release stops until config.multiTenant=false confirms it', () => {
    for (const config of [{}, { multiTenant: true }, { multiTenant: 'false' }]) {
      const stderr = rejected({ ...previous(multiTenantJs), config }, upgradeGuard, tenancyChart);
      assert.doesNotMatch(stderr, sandboxGuard, 'the multi-tenant guard covers its sandbox too');
    }
    successful({ ...previous(multiTenantJs), config: { multiTenant: false } }, tenancyChart);
  });
  check('values enabling the sandbox, or a release that ran in it, stop until sandbox.enabled=false', () => {
    for (const fixture of [{}, previous(singleTenantJs)]) {
      successful({ ...fixture, sandbox: staleSandbox }, tenancyChart);
      successful({ ...fixture, sandbox: { ...staleSandbox, enabled: false } }, tenancyChart);
      for (const enabled of [true, 'false']) rejected({ ...fixture, sandbox: { enabled } }, sandboxGuard, tenancyChart);
    }
    for (const sandbox of [{}, staleSandbox, { enabled: true }]) {
      const stderr = rejected({ ...previous(sandboxedJs), sandbox }, sandboxGuard, tenancyChart);
      assert.doesNotMatch(stderr, upgradeGuard);
    }
    successful({ ...previous(sandboxedJs), sandbox: { enabled: false } }, tenancyChart);
    // --reuse-values carries the old defaults, which also enabled the sandbox.
    const reused = { ...previous(multiTenantJs), sandbox: { enabled: true } };
    rejected({ ...reused, config: { multiTenant: false } }, sandboxGuard, tenancyChart);
    successful({ ...reused, config: { multiTenant: false }, sandbox: { enabled: false } }, tenancyChart);
  });
  process.stdout.write(`${checks} inline-secret and upgrade guard checks passed\n`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
NODE
