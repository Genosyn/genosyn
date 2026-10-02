#!/usr/bin/env bash
# Render only synthetic values; no private profiles or cluster access.
set -euo pipefail
chart_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/genosyn"
node - "$chart_dir" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'genosyn-portability-'));
const chart = process.argv[2];
const sandboxFields = /seccompProfile|procMount|hostUsers|appArmor|apparmor/;
function template(args) {
  return spawnSync('helm', ['template', 'genosyn', ...args], { encoding: 'utf8' });
}
function documents(text) {
  return text.split(/^---\s*$/m).filter(block => block.trim());
}
function render(values = {}, source = chart, extra = []) {
  const file = path.join(scratch, 'values.json');
  fs.writeFileSync(file, JSON.stringify(values), { mode: 0o600 });
  const result = template([source, '-f', file, ...extra]);
  assert.equal(result.status, 0, 'synthetic portability render must succeed');
  return documents(result.stdout);
}
function resource(documents, kind, name = 'genosyn') {
  const document = documents.find(block => new RegExp(`^kind: ${kind}$`, 'm').test(block)
    && new RegExp(`^  name: ${name}$`, 'm').test(block));
  assert(document, `expected ${kind} ${name}`);
  return document;
}
function standardResources(documents) {
  const standard = new Set(['v1/Service', 'v1/Secret', 'v1/ConfigMap', 'v1/PersistentVolumeClaim',
    'apps/v1/Deployment', 'apps/v1/StatefulSet', 'networking.k8s.io/v1/Ingress']);
  for (const document of documents) {
    const apiVersion = /^apiVersion: (.+)$/m.exec(document)[1];
    const kind = /^kind: (.+)$/m.exec(document)[1];
    assert(standard.has(`${apiVersion}/${kind}`), 'chart must emit standard Kubernetes resources');
  }
}
function singleTenantHost(documents) {
  for (const document of documents) assert(!sandboxFields.test(document), 'no render requests sandbox privileges');
  const config = resource(documents, 'ConfigMap', 'genosyn-config');
  assert.match(config, /^      multiTenant: false,$/m);
  assert.match(config, /codingTools: \{\n\s+enabled: true,\n\s+executionMode: "host",\n\s+allowUnsafeHostExecution: true,\n\s+\},/);
  assert(!/bubblewrap|bwrap|allowNetwork/.test(config), 'no sandbox settings remain in config.js');
}
try {
  const bare = template([chart]);
  assert.equal(bare.status, 0, 'a bare helm template must render');
  standardResources(documents(bare.stdout));
  singleTenantHost(documents(bare.stdout));
  process.stdout.write('ok - a bare install renders single-tenant host execution without sandbox privileges\n');

  const defaults = render({ ingress: { enabled: true, host: 'app.example.com' } });
  standardResources(defaults);
  assert(!/^  annotations:/m.test(resource(defaults, 'Service')), 'default Service has no provider annotations');
  assert(!/^  annotations:/m.test(resource(defaults, 'Ingress')), 'default Ingress has no provider annotations');
  assert(!/ingressClassName:/.test(resource(defaults, 'Ingress')), 'default IngressClass is selected by the cluster');
  assert(!/storageClassName:/.test(resource(defaults, 'PersistentVolumeClaim', 'genosyn-data')));
  const app = resource(defaults, 'Deployment');
  assert.equal((app.match(/path: \/api\/health/g) || []).length, 2, 'standard readiness and liveness probes remain');
  assert.match(app, /securityContext:\n\s+fsGroup: 1000\n/);
  assert.equal((app.match(/securityContext:/g) || []).length, 1, 'the pod needs no container securityContext');
  process.stdout.write('ok - standard resources, neutral defaults and health probes\n');

  const custom = render({ service: { annotations: { 'example.com/service-option': 'enabled' } },
    ingress: { enabled: true, host: 'app.example.com', className: 'example-ingress',
      annotations: { 'example.com/ingress-option': 'enabled' } },
    persistence: { storageClass: 'example-app-storage' }, postgres: { persistence: { storageClass: 'example-db-storage' } } });
  standardResources(custom);
  assert.match(resource(custom, 'Service'), /example.com\/service-option: enabled/);
  assert.match(resource(custom, 'Ingress'), /example.com\/ingress-option: enabled/);
  assert.match(resource(custom, 'Ingress'), /ingressClassName: example-ingress/);
  assert.match(resource(custom, 'PersistentVolumeClaim', 'genosyn-data'), /storageClassName: "example-app-storage"/);
  assert.match(resource(custom, 'StatefulSet', 'genosyn-postgres'), /storageClassName: "example-db-storage"/);
  process.stdout.write('ok - operator Service/Ingress annotations, IngressClass and both StorageClasses pass through\n');

  for (const [setting, message] of [['config.multiTenant=true', 'the chart runs Genosyn single-tenant only (one organization per install)'],
    ['sandbox.enabled=true', 'Bubblewrap isolation was removed']]) {
    const refused = template([chart, '--set', setting]);
    assert.notEqual(refused.status, 0, `${setting} must fail`);
    assert(refused.stderr.includes(message));
    assert.equal(refused.stdout.trim(), '', 'failed rendering must not emit manifests');
  }
  singleTenantHost(render({ config: { multiTenant: false } }));
  singleTenantHost(render({ config: { db: { driver: 'sqlite' } }, postgres: { enabled: false } }));
  for (const sandbox of [{ enabled: false, hostUsers: false, appArmorProfile: 'Unconfined' }, { hostUsers: false }]) {
    singleTenantHost(render({ sandbox }, chart, ['--kube-version', '1.29.0']));
  }
  process.stdout.write('ok - multiTenant=true and sandbox.enabled=true fail; explicit false, SQLite and other stale sandbox keys render single-tenant\n');

  const oldChart = path.join(scratch, 'old-values');
  fs.cpSync(chart, oldChart, { recursive: true });
  const file = path.join(oldChart, 'values.yaml');
  const oldValues = fs.readFileSync(file, 'utf8')
    .replace(/^service:\n(?:  .*\n|\n)*/m, block => block.replace(/^  annotations: \{\}\n/m, ''))
    .replace(/^  connect: \{\}\n/m, '')
    .replace(/^  gmailSignIn:\n(?:    .*\n)*/m, '')
    .replace(/^config:\n/m, 'config:\n  multiTenant: true\n')
    .concat('sandbox:\n  enabled: true\n  hostUsers: false\n  appArmorProfile: Unconfined\n');
  fs.writeFileSync(file, oldValues);
  // `helm upgrade --reuse-values` renders with the previous chart's defaults,
  // which enabled both multi-tenant mode and the sandbox.
  const reused = template([oldChart]);
  assert.notEqual(reused.status, 0, 'the old defaults need an explicit decision');
  assert(reused.stderr.includes('single-tenant only') && reused.stderr.includes('Bubblewrap isolation was removed'));
  const confirmed = ['--set', 'config.multiTenant=false', '--set', 'sandbox.enabled=false'];
  standardResources(render({}, oldChart, confirmed));
  singleTenantHost(render({}, oldChart, confirmed));
  const oldIngress = resource(render({ ingress: { enabled: true, host: 'app.example.com',
    tls: { enabled: true, secretName: 'ci-app-tls' } } }, oldChart, confirmed), 'Ingress');
  assert.equal((oldIngress.match(/^    - host:/gm) || []).length, 1, 'older values retain only the App host');
  assert(!oldIngress.includes('/api/google-sign-in/'));
  assert(!oldIngress.includes('/api/connect'));
  process.stdout.write('ok - older reused values need no new blocks once their tenancy and sandbox are confirmed\n');
  process.stdout.write('5 Kubernetes portability checks passed\n');
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
NODE
