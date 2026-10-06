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
const service = { enabled: true, existingSecret: 'ci-connect' };
function template(values, source = chart, templates = ['templates/ingress.yaml']) {
  const file = path.join(scratch, 'values.json');
  fs.writeFileSync(file, JSON.stringify(values), { mode: 0o600 });
  return spawnSync('helm', ['template', 'genosyn', source, '-f', file,
    ...templates.flatMap(name => ['-s', name])], { encoding: 'utf8' });
}
function documents(text) {
  return text.split(/^---\s*$/m).filter(block => block.trim());
}
function render(values, source) {
  const result = template(values, source);
  assert.equal(result.status, 0, `synthetic Connect ingress render must succeed: ${result.stderr}`);
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
  assert.deepEqual(app.services, ['genosyn']);
  assert.deepEqual(broker.paths, ['/'], 'the whole sign-in hostname goes to Genosyn Connect');
  assert.deepEqual(broker.types, ['Prefix']);
  assert.deepEqual(broker.services, ['genosyn-connect'], 'and never to the App');
  assert.deepEqual(broker.ports, ['80']);
  assert(!rendered.text.includes('/api/google-sign-in/'), 'no App path is published on the sign-in host');
  for (const [name, secret] of [[primary.host, primary.tls.secretName], [host, tls]]) {
    assert(rendered.text.includes(`- hosts:\n        - "${name}"\n      secretName: "${secret}"`), 'each host has its own TLS reference');
  }
}
function assertAppOnly(rendered) {
  assert.equal(rendered.rules.length, 1, 'the Connect host must be opt-in');
  assert.deepEqual(rendered.rules[0].paths, ['/']);
  assert(!rendered.text.includes('genosyn-connect'));
}
function reject(values, message) {
  const result = template(values);
  assert.notEqual(result.status, 0, 'invalid Connect settings must fail');
  assert(result.stderr.includes(message), `expected actionable error: ${message}\n${result.stderr}`);
}
function workload(values) {
  const result = template(values, chart, ['templates/connect.yaml']);
  assert.equal(result.status, 0, `Connect workload render must succeed: ${result.stderr}`);
  const [svc, deployment] = ['Service', 'Deployment'].map(kind =>
    documents(result.stdout).find(block => new RegExp(`^kind: ${kind}$`, 'm').test(block)));
  return { text: result.stdout, svc, deployment };
}
try {
  assertConnect(render({ ingress: { ...primary, connect }, connect: service }));
  process.stdout.write('ok - the Connect host routes entirely to the Connect service, with separate TLS\n');

  assertAppOnly(render({ ingress: primary }));
  assertAppOnly(render({ ingress: { ...primary, connect: { enabled: false } } }));
  assert.equal(template({}, chart, ['templates/connect.yaml']).stdout.trim(), '', 'no Connect workload by default');
  process.stdout.write('ok - default and disabled Connect render only the App\n');

  reject({ ingress: { ...primary, connect } }, 'ingress.connect routes the sign-in hostname to Genosyn Connect, which now runs as its own service');
  reject({ ingress: { ...primary, gmailSignIn: connect } }, 'set connect.enabled=true and connect.existingSecret');
  process.stdout.write('ok - a profile that routed sign-in to the App fails with what to change\n');

  assertConnect(render({ ingress: { ...primary, gmailSignIn: connect }, connect: service }));
  const legacy = { enabled: true, host: 'legacy.example.com', tlsSecretName: 'legacy-tls' };
  assertConnect(render({ ingress: { ...primary, gmailSignIn: legacy, connect }, connect: service }));
  assertAppOnly(render({ ingress: { ...primary, gmailSignIn: legacy, connect: { enabled: false } } }));
  assertConnect(render({ ingress: { ...primary, gmailSignIn: legacy, connect: { host: connect.host } }, connect: service }),
    connect.host, legacy.tlsSecretName);
  reject({ ingress: { ...primary, gmailSignIn: legacy, connect: { host: '' } }, connect: service }, 'ingress.connect.host must be a valid');
  reject({ ingress: { ...primary, gmailSignIn: legacy, connect: { tlsSecretName: '' } }, connect: service }, 'ingress.connect.tlsSecretName is required');
  process.stdout.write('ok - explicit canonical fields override legacy values, including false and empty strings\n');

  for (const values of [{ enabled: false }, { tls: { enabled: false } }]) {
    reject({ ingress: { ...primary, connect, ...values }, connect: service }, 'requires ingress.enabled=true and ingress.tls.enabled=true');
  }
  reject({ ingress: { ...primary, connect: { ...connect, host: primary.host } }, connect: service }, 'ingress.connect.host must differ from ingress.host');
  for (const host of ['', 'https://connect.example.com', '127.0.0.1', '*.example.com', 'connect.example.com/path', 'Upper.example.com']) {
    reject({ ingress: { ...primary, connect: { ...connect, host } }, connect: service }, 'ingress.connect.host must be a valid');
  }
  reject({ ingress: { ...primary, connect: { ...connect, tlsSecretName: ' ' } }, connect: service }, 'ingress.connect.tlsSecretName is required');
  process.stdout.write('ok - the Connect host needs a distinct DNS name and TLS on both hosts\n');

  for (const name of ['connect', 'gmailSignIn']) {
    reject({ ingress: { ...primary, [name]: 'invalid' } }, `ingress.${name} must be a settings object`);
    reject({ ingress: { ...primary, [name]: { ...connect, enabled: 'false' } } }, 'ingress.connect.enabled must be a boolean');
    reject({ ingress: { ...primary, [name]: { ...connect, host: { invalid: true } } } }, 'ingress.connect.host and ingress.connect.tlsSecretName must be strings');
  }
  process.stdout.write('ok - malformed canonical and legacy settings fail with fixed field errors\n');

  const routed = workload({ ingress: { ...primary, connect }, connect: { ...service, googleScopeGroups: 'gmail, calendar',
    privacyUrl: 'https://genosyn.example/privacy', env: [{ name: 'CONNECT_ACCESS_LOG', value: 'false' }] } });
  assert.match(routed.deployment, /^  name: genosyn-connect$/m);
  assert.match(routed.deployment, /image: ghcr\.io\/genosyn\/connect:\d+\.\d+\.\d+$/m, 'the image follows the chart version');
  assert.match(routed.deployment, /- name: CONNECT_PUBLIC_URL\n\s+value: "https:\/\/connect\.example\.com"/);
  assert.match(routed.deployment, /- name: CONNECT_TRUSTED_PROXY_HOPS\n\s+value: "1"/);
  assert.match(routed.deployment, /- name: CONNECT_GOOGLE_SCOPE_GROUPS\n\s+value: "gmail, calendar"/);
  assert.match(routed.deployment, /- name: CONNECT_PRIVACY_URL\n\s+value: "https:\/\/genosyn\.example\/privacy"/);
  assert.match(routed.deployment, /- name: CONNECT_ACCESS_LOG\n\s+value: "false"/);
  assert(!routed.deployment.includes('CONNECT_TERMS_URL'), 'unset links are not rendered');
  assert.match(routed.deployment, /envFrom:\n\s+- secretRef:\n\s+name: "ci-connect"/);
  assert(!/CONNECT_GOOGLE_CLIENT_SECRET|CONNECT_SECRET\b|CONNECT_DATABASE_URL/.test(routed.text), 'no secret is rendered');
  assert.match(routed.deployment, /runAsNonRoot: true\n\s+runAsUser: 1000\n\s+runAsGroup: 1000\n\s+readOnlyRootFilesystem: true\n\s+allowPrivilegeEscalation: false/);
  assert.match(routed.deployment, /automountServiceAccountToken: false/);
  assert.match(routed.deployment, /readinessProbe:\n\s+httpGet:\n\s+path: \/readyz/);
  assert.match(routed.deployment, /livenessProbe:\n\s+httpGet:\n\s+path: \/healthz/);
  assert(!/volumeMounts|persistentVolumeClaim/.test(routed.deployment), 'Connect keeps nothing on disk');
  assert.match(routed.deployment, /maxUnavailable: 0/);
  assert.match(routed.svc, /^    app\.kubernetes\.io\/component: connect$/m);
  assert.match(routed.svc, /selector:\n(?:\s+.+\n)*\s+app\.kubernetes\.io\/component: connect/);
  const tagged = workload({ connect: { ...service, publicUrl: 'https://connect.example.com/', replicaCount: 3,
    image: { repository: 'registry.example/connect', tag: 'custom' } } });
  assert.match(tagged.deployment, /image: registry\.example\/connect:custom$/m);
  assert.match(tagged.deployment, /replicas: 3/);
  assert.match(tagged.deployment, /value: "https:\/\/connect\.example\.com"/);
  process.stdout.write('ok - the Connect workload runs read-only and non-root with only its Secret as credentials\n');

  for (const [values, message] of [
    [{ connect: { enabled: true, publicUrl: 'https://connect.example.com' } }, 'connect.existingSecret must name a Secret'],
    [{ connect: service }, 'connect.enabled needs a public address'],
    [{ connect: { ...service, publicUrl: 'http://connect.example.com' } }, 'connect.publicUrl must be an https:// origin'],
    [{ connect: { ...service, publicUrl: 'https://connect.example.com/path' } }, 'connect.publicUrl must be an https:// origin'],
    [{ connect: { ...service, publicUrl: 'https://c.example.com', googleScopeGroups: 'gmail;drive' } }, 'connect.googleScopeGroups must be a comma-separated list'],
    [{ connect: { ...service, publicUrl: 'https://c.example.com', replicaCount: 0 } }, 'connect.replicaCount must be a whole number'],
    [{ connect: { ...service, publicUrl: 'https://c.example.com', replicaCount: 1.5 } }, 'connect.replicaCount must be a whole number'],
    [{ connect: { ...service, publicUrl: 'https://c.example.com', termsUrl: 'http://x' } }, 'connect.termsUrl must be an https:// URL'],
  ]) {
    const result = template(values, chart, ['templates/connect.yaml']);
    assert.notEqual(result.status, 0, JSON.stringify(values));
    assert(result.stderr.includes(message), `expected actionable error: ${message}\n${result.stderr}`);
  }
  process.stdout.write('ok - Connect settings fail closed with actionable messages\n');

  const gke = template({ gke: { enabled: true }, ingress: { ...primary, connect }, connect: service }, chart,
    ['templates/gke.yaml', 'templates/connect.yaml']);
  assert.equal(gke.status, 0, gke.stderr);
  const backend = documents(gke.stdout).find(block => /name: genosyn-connect-backend/.test(block));
  assert(backend, 'GKE gets a BackendConfig for Connect');
  assert.match(backend, /requestPath: \/readyz\n\s+port: 8473/);
  assert.match(backend, /logging:\n\s+enable: false/, 'callback URLs carrying authorization codes are not logged');
  assert.match(gke.stdout, /cloud\.google\.com\/backend-config: '\{"default": "genosyn-connect-backend"\}'/);
  assert.match(gke.stdout, /- name: CONNECT_TRUSTED_PROXY_HOPS\n\s+value: "2"/);
  process.stdout.write('ok - on GKE the Connect backend health-checks readiness and keeps request logs off\n');

  const oldChart = path.join(scratch, 'old-values');
  fs.cpSync(chart, oldChart, { recursive: true });
  const valuesPath = path.join(oldChart, 'values.yaml');
  fs.writeFileSync(valuesPath, fs.readFileSync(valuesPath, 'utf8')
    .replace(/^  connect: \{\}\n/m, '')
    .replace(/^connect:\n(?:  .*\n|\n)*/m, ''));
  assertAppOnly(render({ ingress: primary }, oldChart));
  assertConnect(render({ ingress: { ...primary, gmailSignIn: connect }, connect: service }, oldChart));
  process.stdout.write('ok - reused chart values without the new blocks remain valid\n');
  process.stdout.write('10 Connect ingress and workload checks passed\n');
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
NODE
