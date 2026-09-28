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
function render(values = {}, source = chart) {
  const file = path.join(scratch, 'values.json');
  fs.writeFileSync(file, JSON.stringify(values), { mode: 0o600 });
  const result = spawnSync('helm', ['template', 'genosyn', source,
    '--set', 'config.bootstrapMasterAdminEmail=ops@example.com', '-f', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, 'synthetic portability render must succeed');
  return result.stdout.split(/^---\s*$/m).filter(block => block.trim());
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
try {
  const defaults = render({ ingress: { enabled: true, host: 'app.example.com' } });
  standardResources(defaults);
  assert(!/^  annotations:/m.test(resource(defaults, 'Service')), 'default Service has no provider annotations');
  assert(!/^  annotations:/m.test(resource(defaults, 'Ingress')), 'default Ingress has no provider annotations');
  assert(!/ingressClassName:/.test(resource(defaults, 'Ingress')), 'default IngressClass is selected by the cluster');
  assert(!/storageClassName:/.test(resource(defaults, 'PersistentVolumeClaim', 'genosyn-data')));
  const app = resource(defaults, 'Deployment');
  assert.equal((app.match(/path: \/api\/health/g) || []).length, 2, 'standard readiness and liveness probes remain');
  assert.match(app, /procMount: Unmasked/);
  assert.match(app, /seccompProfile:\n\s+type: Unconfined/);
  assert.match(app, /hostUsers: false/);
  process.stdout.write('ok - standard resources, neutral defaults, health probes and sandbox baseline\n');

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

  const oldChart = path.join(scratch, 'old-values');
  fs.cpSync(chart, oldChart, { recursive: true });
  const file = path.join(oldChart, 'values.yaml');
  const oldValues = fs.readFileSync(file, 'utf8')
    .replace(/^service:\n(?:  .*\n|\n)*/m, block => block.replace(/^  annotations: \{\}\n/m, ''))
    .replace(/^  gmailSignIn:\n(?:    .*\n)*/m, '');
  fs.writeFileSync(file, oldValues);
  standardResources(render({}, oldChart));
  const oldIngress = resource(render({ ingress: { enabled: true, host: 'app.example.com',
    tls: { enabled: true, secretName: 'ci-app-tls' } } }, oldChart), 'Ingress');
  assert.equal((oldIngress.match(/^    - host:/gm) || []).length, 1, 'older values retain only the App host');
  assert(!oldIngress.includes('/api/google-sign-in/'));
  process.stdout.write('ok - older reused values need no new Service annotations or Gmail sign-in block\n');
  process.stdout.write('3 Kubernetes portability checks passed\n');
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
NODE
