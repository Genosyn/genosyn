#!/usr/bin/env bash
# Exercise only synthetic values; no private profiles or cluster access.
set -euo pipefail
chart_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/genosyn"
node - "$chart_dir" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'genosyn-connect-ingress-'));
const chart = process.argv[2];
const primary = { enabled: true, host: 'app.example.com', tls: { enabled: true, secretName: 'ci-app-tls' } };
const connect = { enabled: true, host: 'connect.example.com', tlsSecretName: 'ci-connect-tls' };
function template(ingress, source = chart) {
  const file = path.join(scratch, 'values.json');
  fs.writeFileSync(file, JSON.stringify({ ingress }), { mode: 0o600 });
  return spawnSync('helm', ['template', 'genosyn', source, '-f', file,
    '--set', 'config.bootstrapMasterAdminEmail=ops@example.com', '-s', 'templates/ingress.yaml'], { encoding: 'utf8' });
}
function render(ingress, source) {
  const result = template(ingress, source);
  assert.equal(result.status, 0, 'synthetic Connect ingress render must succeed');
  const text = result.stdout;
  assert.equal((text.match(/^kind: Ingress$/gm) || []).length, 1);
  // Inspect this chart's fixed output without adding a YAML dependency.
  const rules = text.split('\n  rules:\n')[1].split(/(?=^    - host: )/m).filter(block => block.trim());
  return { text, rules: rules.map(block => ({
    host: JSON.parse(/^    - host: (.+)$/m.exec(block)[1]),
    paths: [...block.matchAll(/^          - path: (.+)$/gm)].map(match => match[1]),
    types: [...block.matchAll(/^            pathType: (.+)$/gm)].map(match => match[1]),
    services: [...block.matchAll(/^                name: (.+)$/gm)].map(match => match[1]),
    ports: [...block.matchAll(/^                  number: (.+)$/gm)].map(match => match[1]),
  })) };
}
function assertConnect(rendered, host = connect.host, tls = connect.tlsSecretName) {
  assert.deepEqual(rendered.rules.map(rule => rule.host), [primary.host, host]);
  const [app, broker] = rendered.rules;
  assert.deepEqual(app.paths, ['/']);
  assert.deepEqual(broker.paths, ['/api/connect', ...['status', 'start', 'authorize', 'callback', 'poll', 'refresh']
    .map(endpoint => `/api/google-sign-in/${endpoint}`)], 'only the provider namespace and legacy exact routes are exposed');
  assert.deepEqual(broker.types, ['Prefix', ...Array(6).fill('Exact')]);
  assert.deepEqual(broker.services, Array(7).fill(app.services[0]));
  assert.deepEqual(broker.ports, Array(7).fill(app.ports[0]));
  for (const [name, secret] of [[primary.host, primary.tls.secretName], [host, tls]]) {
    assert(rendered.text.includes(`- hosts:\n        - "${name}"\n      secretName: "${secret}"`), 'each host has its own TLS reference');
  }
}
function assertAppOnly(rendered) {
  assert.equal(rendered.rules.length, 1, 'the Connect host must be opt-in');
  assert.deepEqual(rendered.rules[0].paths, ['/']);
  assert(!rendered.text.includes('/api/connect'));
  assert(!rendered.text.includes('/api/google-sign-in/'));
}
function reject(ingress, message) {
  const result = template(ingress);
  assert.notEqual(result.status, 0, 'invalid Connect ingress must fail');
  assert(result.stderr.includes(message), `expected actionable error: ${message}`);
}
try {
  assertConnect(render({ ...primary, connect }));
  process.stdout.write('ok - one provider namespace, six legacy exact routes, shared App backend and separate TLS\n');

  assertAppOnly(render(primary));
  assertAppOnly(render({ ...primary, connect: { enabled: false } }));
  process.stdout.write('ok - default and disabled Connect host expose only the primary App host\n');

  assertConnect(render({ ...primary, gmailSignIn: connect }));
  process.stdout.write('ok - legacy Gmail-only values retain hosted sign-in after upgrade\n');

  const legacy = { enabled: true, host: 'legacy.example.com', tlsSecretName: 'legacy-tls' };
  assertConnect(render({ ...primary, gmailSignIn: legacy, connect }));
  assertAppOnly(render({ ...primary, gmailSignIn: legacy, connect: { enabled: false } }));
  assertConnect(render({ ...primary, gmailSignIn: legacy, connect: { host: connect.host } }), connect.host, legacy.tlsSecretName);
  reject({ ...primary, gmailSignIn: legacy, connect: { host: '' } }, 'ingress.connect.host must be a valid');
  reject({ ...primary, gmailSignIn: legacy, connect: { tlsSecretName: '' } }, 'ingress.connect.tlsSecretName is required');
  process.stdout.write('ok - explicit canonical fields override legacy values, including false and empty strings\n');

  for (const values of [{ enabled: false }, { tls: { enabled: false } }]) {
    reject({ ...primary, connect, ...values }, 'requires ingress.enabled=true and ingress.tls.enabled=true');
  }
  reject({ ...primary, connect: { ...connect, host: primary.host } }, 'ingress.connect.host must differ from ingress.host');
  for (const host of ['', 'https://connect.example.com', '127.0.0.1', '*.example.com', 'connect.example.com/path', 'Upper.example.com']) {
    reject({ ...primary, connect: { ...connect, host } }, 'ingress.connect.host must be a valid');
  }
  reject({ ...primary, connect: { ...connect, tlsSecretName: ' ' } }, 'ingress.connect.tlsSecretName is required');
  reject({ ...primary, gmailSignIn: { ...connect, host: primary.host } }, 'ingress.connect.host must differ from ingress.host');
  process.stdout.write('ok - both settings require a distinct DNS host and TLS on the primary and Connect hosts\n');

  for (const name of ['connect', 'gmailSignIn']) {
    reject({ ...primary, [name]: 'invalid' }, `ingress.${name} must be a settings object`);
    reject({ ...primary, [name]: { ...connect, enabled: 'false' } }, 'ingress.connect.enabled must be a boolean');
    reject({ ...primary, [name]: { ...connect, host: { invalid: true } } }, 'ingress.connect.host and ingress.connect.tlsSecretName must be strings');
  }
  process.stdout.write('ok - malformed canonical and legacy settings fail with fixed field errors\n');

  const oldChart = path.join(scratch, 'old-values');
  fs.cpSync(chart, oldChart, { recursive: true });
  const valuesPath = path.join(oldChart, 'values.yaml');
  fs.writeFileSync(valuesPath, fs.readFileSync(valuesPath, 'utf8').replace(/^  connect: \{\}\n/m, ''));
  assertAppOnly(render(primary, oldChart));
  assertConnect(render({ ...primary, gmailSignIn: connect }, oldChart));
  process.stdout.write('ok - reused chart values without the new block remain valid\n');
  process.stdout.write('7 Connect ingress checks passed\n');
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
NODE
