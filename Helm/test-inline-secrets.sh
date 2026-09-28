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
    '--set', 'config.bootstrapMasterAdminEmail=ops@example.com', '-f', valuesFile], { encoding: 'utf8' });
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
  process.stdout.write(`${checks} inline-secret chart checks passed\n`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
NODE
