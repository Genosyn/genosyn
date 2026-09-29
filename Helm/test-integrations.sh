#!/usr/bin/env bash
# Opt-in cluster integrations: GKE's Ingress, cert-manager issuance, the
# sandbox's AppArmor profile, and the public URL Job. Renders synthetic values
# only; no private profiles or cluster access.
set -euo pipefail
chart_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/genosyn"
node - "$chart_dir" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'genosyn-integrations-'));
const chart = process.argv[2];
const app = { ingress: { enabled: true, host: 'app.example.com' } };
function helm(values, { kubeVersion = '1.35.0', source = chart } = {}) {
  const file = path.join(scratch, 'values.json');
  fs.writeFileSync(file, JSON.stringify(values), { mode: 0o600 });
  return spawnSync('helm', ['template', 'genosyn', source, '--kube-version', kubeVersion,
    '--set', 'config.bootstrapMasterAdminEmail=ops@example.com', '-f', file], { encoding: 'utf8' });
}
function render(values, options) {
  const result = helm(values, options);
  assert.equal(result.status, 0, `render must succeed: ${result.stderr}`);
  return result.stdout.split(/^---\s*$/m).filter(block => block.trim());
}
function reject(values, message) {
  const result = helm(values);
  assert.notEqual(result.status, 0, `expected rejection: ${message}`);
  assert(result.stderr.includes(message), `expected error: ${message}`);
}
function find(documents, kind, name) {
  return documents.find(block => new RegExp(`^kind: ${kind}$`, 'm').test(block)
    && (!name || new RegExp(`^  name: ${name}$`, 'm').test(block)));
}
function resource(documents, kind, name) {
  const document = find(documents, kind, name);
  assert(document, `expected ${kind}${name ? ` ${name}` : ''}`);
  return document;
}
const kinds = documents => documents.map(block => /^kind: (.+)$/m.exec(block)[1]);
const tls = { enabled: true, secretName: 'app-tls' };
const connect = { enabled: true, host: 'connect.example.com', tlsSecretName: 'connect-tls' };
let passed = 0;
function check(name, fn) { fn(); passed += 1; process.stdout.write(`ok - ${name}\n`); }
try {
  check('GKE stays off by default and adds nothing', () => {
    const documents = render({ ...app, ingress: { ...app.ingress, tls } });
    for (const kind of ['BackendConfig', 'FrontendConfig', 'ManagedCertificate', 'Issuer', 'Certificate']) {
      assert(!kinds(documents).includes(kind), `${kind} must be opt-in`);
    }
    assert.match(resource(documents, 'ConfigMap'), /trustedProxyHops: 1,/);
  });

  check('GKE adds its BackendConfig, redirect, annotations and two proxy hops', () => {
    const documents = render({ ...app, ingress: { ...app.ingress, tls }, gke: { enabled: true, staticIpName: 'genosyn-ip' } });
    const backend = resource(documents, 'BackendConfig', 'genosyn-backend');
    assert.match(backend, /timeoutSec: 3600/);
    assert.match(backend, /requestPath: \/api\/health/);
    assert.match(backend, /logging:\n\s+enable: false/);
    assert.match(resource(documents, 'FrontendConfig', 'genosyn-frontend'), /redirectToHttps:\n\s+enabled: true/);
    const service = find(documents.filter(block => !/genosyn-postgres/.test(block)), 'Service');
    assert.match(service, /cloud.google.com\/neg: '\{"ingress": true\}'/);
    assert.match(service, /cloud.google.com\/backend-config: '\{"default": "genosyn-backend"\}'/);
    const ingress = resource(documents, 'Ingress');
    assert.match(ingress, /kubernetes.io\/ingress.class: gce/);
    assert.match(ingress, /networking.gke.io\/v1beta1.FrontendConfig: genosyn-frontend/);
    assert.match(ingress, /kubernetes.io\/ingress.global-static-ip-name: genosyn-ip/);
    assert.match(ingress, /secretName: "app-tls"/);
    assert.match(resource(documents, 'ConfigMap'), /trustedProxyHops: 2,/);
  });

  check('GKE yields to operator annotations and a selected IngressClass', () => {
    const documents = render({ ...app, gke: { enabled: true, redirectToHttps: false },
      ingress: { ...app.ingress, tls, className: 'gce-internal', annotations: { 'example.com/keep': 'kept' } },
      service: { annotations: { 'cloud.google.com/neg': '{"ingress": false}' } } });
    const ingress = resource(documents, 'Ingress');
    assert(!ingress.includes('kubernetes.io/ingress.class'), 'the class annotation conflicts with ingressClassName');
    assert.match(ingress, /ingressClassName: gce-internal/);
    assert.match(ingress, /example.com\/keep: kept/);
    assert(!find(documents, 'FrontendConfig'), 'redirectToHttps: false omits the FrontendConfig');
    assert.match(find(documents.filter(block => !/genosyn-postgres/.test(block)), 'Service'), /cloud.google.com\/neg: '\{"ingress": false\}'/);
  });

  check('a Google-managed certificate covers both hosts in place of TLS Secrets', () => {
    const documents = render({ ...app, ingress: { ...app.ingress, connect: { enabled: true, host: 'connect.example.com' } },
      gke: { enabled: true, managedCertificate: { enabled: true } } });
    const certificate = resource(documents, 'ManagedCertificate', 'genosyn');
    assert.match(certificate, /domains:\n\s+- "app.example.com"\n\s+- "connect.example.com"/);
    const ingress = resource(documents, 'Ingress');
    assert.match(ingress, /networking.gke.io\/managed-certificates: genosyn/);
    assert(!/^  tls:/m.test(ingress), 'managed certificates need no TLS Secrets');
    assert.equal((ingress.match(/^    - host:/gm) || []).length, 2);
    assert(find(documents, 'FrontendConfig'), 'a managed certificate is TLS, so HTTP redirects');
    const named = render({ ...app, gke: { enabled: true, managedCertificate: { enabled: true, name: 'existing-cert' } } });
    assert(find(named, 'ManagedCertificate', 'existing-cert'));
    assert.match(resource(named, 'Ingress'), /managed-certificates: existing-cert/);
  });

  check('managed certificates reject missing GKE, missing hosts and TLS Secrets', () => {
    reject({ ...app, gke: { managedCertificate: { enabled: true } } }, 'gke.managedCertificate.enabled requires gke.enabled=true');
    reject({ gke: { enabled: true, managedCertificate: { enabled: true } } }, 'gke.managedCertificate.enabled requires ingress.enabled=true and ingress.host');
    reject({ ...app, ingress: { ...app.ingress, tls }, gke: { enabled: true, managedCertificate: { enabled: true } } },
      'gke.managedCertificate.enabled and ingress.tls.enabled are alternatives');
    reject({ ...app, ingress: { ...app.ingress, connect: { enabled: true, host: 'connect.example.com' } } },
      'requires ingress.enabled=true and ingress.tls.enabled=true');
  });

  check('cert-manager issues both Secrets through the GKE Ingress, starting temporary', () => {
    const documents = render({ ...app, gke: { enabled: true }, ingress: { ...app.ingress, connect,
      tls: { ...tls, certManager: { enabled: true, email: 'ops@example.com' } } } });
    const issuer = resource(documents, 'Issuer', 'genosyn-acme');
    assert.match(issuer, /server: "https:\/\/acme-v02.api.letsencrypt.org\/directory"/);
    assert.match(issuer, /email: "ops@example.com"/);
    assert.match(issuer, /http01:\n(?:\s+#.*\n)*\s+ingress:\n\s+name: genosyn/);
    for (const [name, host] of [['app-tls', 'app.example.com'], ['connect-tls', 'connect.example.com']]) {
      const certificate = resource(documents, 'Certificate', name);
      assert.match(certificate, /cert-manager.io\/issue-temporary-certificate: "true"/);
      assert.match(certificate, new RegExp(`secretName: ${name}`));
      assert.match(certificate, new RegExp(`dnsNames:\\n\\s+- "${host.replaceAll('.', '\\.')}"`));
      assert.match(certificate, /issuerRef:\n\s+kind: Issuer\n\s+name: genosyn-acme\n\s+group: cert-manager.io/);
    }
  });

  check('cert-manager answers through the IngressClass or reuses an existing issuer', () => {
    const classed = render({ ...app, ingress: { ...app.ingress, className: 'nginx', tls: { ...tls, certManager: { enabled: true } } } });
    assert.match(resource(classed, 'Issuer'), /ingress:\n\s+ingressClassName: nginx/);
    const unclassed = render({ ...app, ingress: { ...app.ingress, tls: { ...tls, certManager: { enabled: true } } } });
    assert.match(resource(unclassed, 'Issuer'), /ingress: \{\}/);
    const shared = render({ ...app, ingress: { ...app.ingress, tls: { ...tls,
      certManager: { enabled: true, issuerRef: { kind: 'ClusterIssuer', name: 'letsencrypt' } } } } });
    assert(!find(shared, 'Issuer'), 'an existing issuer replaces the chart Issuer');
    assert.match(resource(shared, 'Certificate', 'app-tls'), /kind: ClusterIssuer\n\s+name: letsencrypt/);
    reject({ ...app, ingress: { ...app.ingress, tls: { enabled: true, secretName: '', certManager: { enabled: true } } } },
      'ingress.tls.certManager.enabled requires');
    reject({ ...app, ingress: { ...app.ingress, tls: { ...tls, certManager: { enabled: true, issuerRef: { kind: 'ClusterIssuer' } } } } },
      'ingress.tls.certManager.issuerRef needs a name');
  });

  check('the sandbox runs AppArmor-unconfined, as a field or on older clusters an annotation', () => {
    const current = resource(render(app), 'Deployment');
    assert.match(current, /appArmorProfile:\n\s+type: Unconfined/);
    assert(!current.includes('container.apparmor.security.beta.kubernetes.io'));
    const older = resource(render(app, { kubeVersion: '1.29.0' }), 'Deployment');
    assert.match(older, /container.apparmor.security.beta.kubernetes.io\/app: unconfined/);
    assert(!older.includes('appArmorProfile:'), 'Kubernetes 1.29 API servers reject the field');
    assert.match(resource(render({ ...app, sandbox: { appArmorProfile: 'RuntimeDefault' } }), 'Deployment'), /type: RuntimeDefault/);
    assert(!/apparmor/i.test(resource(render({ ...app, sandbox: { appArmorProfile: '' } }), 'Deployment')), 'an empty string omits the profile');
    reject({ ...app, sandbox: { appArmorProfile: 'Localhost' } }, 'sandbox.appArmorProfile must be Unconfined, RuntimeDefault');
    const selfHost = render({ config: { multiTenant: false, db: { driver: 'sqlite' } }, sandbox: { enabled: false }, postgres: { enabled: false } });
    assert(!/apparmor/i.test(resource(selfHost, 'Deployment')), 'without the sandbox there is no profile');
  });

  check('a Job stores the HTTPS public URL once for multi-tenant installs', () => {
    const documents = render({ ...app, ingress: { ...app.ingress, tls } });
    const job = resource(documents, 'Job', 'genosyn-public-url');
    assert.match(job, /helm.sh\/hook: post-install,post-upgrade/);
    assert.match(job, /name: GENOSYN_PUBLIC_URL\n\s+value: "https:\/\/app.example.com"/);
    assert.match(job, /setupPublicUrl.js --url "\$GENOSYN_PUBLIC_URL"/);
    assert.match(job, /A different public URL is already stored"\*\)\n\s+echo .*\n\s+exit 0/, 'an origin changed in Admin must not fail upgrades');
    assert.match(job, /name: GENOSYN_POSTGRES_URL/);
    assert(!/persistentVolumeClaim/.test(job), 'the Job must not mount the App\'s ReadWriteOnce volume');
    const explicit = render({ ...app, config: { publicUrl: 'https://genosyn.example.com/' } });
    assert.match(resource(explicit, 'Job'), /value: "https:\/\/genosyn.example.com"/);
    assert(!find(render(app), 'Job'), 'no HTTPS origin, no Job');
    assert(!find(render({ ...app, ingress: { ...app.ingress, tls }, config: { multiTenant: false }, sandbox: { enabled: false } }), 'Job'),
      'single-tenant installs never need the setup');
    reject({ ...app, config: { publicUrl: 'http://app.example.com' } }, 'config.publicUrl must be an https:// origin');
    reject({ ...app, config: { publicUrl: 'https://app.example.com/path' } }, 'config.publicUrl must be an https:// origin');
  });

  check('older reused values without the new blocks keep portable defaults', () => {
    const oldChart = path.join(scratch, 'old-values');
    fs.cpSync(chart, oldChart, { recursive: true });
    const file = path.join(oldChart, 'values.yaml');
    const oldValues = fs.readFileSync(file, 'utf8')
      .replace(/^gke:\n(?:  .*\n|\n)*/m, '')
      .replace(/^    certManager:\n(?:      .*\n)*/m, '')
      .replace(/^  appArmorProfile: .*\n/m, '')
      .replace(/^  publicUrl: .*\n/m, '');
    assert(!/^gke:|certManager:|appArmorProfile:|publicUrl:/m.test(oldValues), 'fixture removes every new block');
    fs.writeFileSync(file, oldValues);
    const documents = render({ ...app, ingress: { ...app.ingress, tls } }, { source: oldChart });
    assert(!kinds(documents).some(kind => ['BackendConfig', 'FrontendConfig', 'ManagedCertificate', 'Issuer', 'Certificate'].includes(kind)));
    assert.match(resource(documents, 'Deployment'), /appArmorProfile:\n\s+type: Unconfined/, 'the sandbox requirement survives');
    assert(find(documents, 'Job', 'genosyn-public-url'));
  });
  process.stdout.write(`${passed} integration checks passed\n`);
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
NODE
