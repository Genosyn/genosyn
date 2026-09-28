#!/usr/bin/env bash
# Offline checks with synthetic Stripe-shaped values. Never reads private
# deployment profiles, connects to a cluster, or calls Stripe.
set -euo pipefail
chart_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/genosyn"
node - "$chart_dir" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'genosyn-billing-chart-'));
const chart = path.join(scratch, 'chart');
fs.cpSync(process.argv[2], chart, { recursive: true });
// Render NOTES through a temporary test-only wrapper so disclosure assertions
// cover the actual notes template as well as the installable resources.
fs.writeFileSync(path.join(chart, 'templates/check-notes.yaml'), `apiVersion: v1
kind: ConfigMap
metadata:
  name: ci-rendered-notes
data:
  notes: |
    {{- include (print $.Template.BasePath "/NOTES.txt") . | nindent 4 }}
`);
const billing = { enabled: true, secretKey: 'sk_test_SyntheticSecret123', webhookSecret: 'whsec_SyntheticHook123',
  growthMonthlyPriceId: 'price_GrowthMonthly123', growthAnnualPriceId: '',
  scaleMonthlyPriceId: 'price_ScaleMonthly123', scaleAnnualPriceId: '' };
const marker = 'SyntheticDoNotDisclose123';
const encode = value => Buffer.from(value).toString('base64');
let checks = 0;
function render(values = {}) {
  const file = path.join(scratch, 'values.json');
  fs.writeFileSync(file, JSON.stringify(values), { mode: 0o600 });
  return spawnSync('helm', ['template', 'genosyn', chart, '--namespace', 'ci-billing',
    '--set', 'config.bootstrapMasterAdminEmail=ops@example.com', '-f', file], { encoding: 'utf8' });
}
function success(values) {
  const result = render(values);
  assert.equal(result.status, 0, 'synthetic chart must render successfully');
  return result.stdout;
}
function reject(supplied, expected) {
  const result = render({ billing: { ...billing, ...supplied } });
  assert.notEqual(result.status, 0, 'invalid billing values must fail rendering');
  assert.match(result.stderr, expected, 'error must identify the invalid setting');
  for (const token of [...Object.values(billing).filter(value => typeof value === 'string' && value), marker]) {
    assert(!result.stderr.includes(token), 'error must not disclose supplied Stripe values');
    assert(!result.stderr.includes(encode(token)), 'error must not disclose encoded credentials');
  }
  assert.equal(result.stdout.trim(), '', 'invalid configuration must not emit manifests');
}
function documents(text) { return text.split(/^---\s*$/m).filter(block => block.trim()); }
function bootstrap(text) {
  const block = documents(text).find(block => /^  name: genosyn-billing-bootstrap$/m.test(block));
  assert(block, 'billing bootstrap Secret must exist');
  assert.match(block, /^kind: Secret$/m);
  const encoded = JSON.parse(/^  settings.json: (.+)$/m.exec(block)[1]);
  return { block, encoded, settings: JSON.parse(Buffer.from(encoded, 'base64').toString()) };
}
function check(name, callback) { callback(); checks++; process.stdout.write(`ok - ${name}\n`); }
try {
  const disabled = success({});
  check('disabled defaults and unfinished settings render no billing input', () => {
    for (const text of [disabled, success({ billing: { ...billing, enabled: false } })]) {
      assert(!text.includes('GENOSYN_BILLING_BOOTSTRAP_JSON'));
      assert(!/^  name: genosyn-billing-bootstrap$/m.test(text));
      assert(!text.includes(billing.secretKey));
    }
  });
  check('enabled billing renders exact JSON through a Secret reference only', () => {
    const text = success({ billing });
    const { block, encoded, settings } = bootstrap(text);
    assert.deepEqual(settings, billing);
    assert(!block.includes('helm.sh/resource-policy'));
    const nonSecret = documents(text).filter(document => document !== block).join('\n');
    assert.match(nonSecret, /- name: GENOSYN_BILLING_BOOTSTRAP_JSON\n              valueFrom:\n                secretKeyRef:\n                  name: genosyn-billing-bootstrap\n                  key: settings.json/);
    for (const value of Object.values(billing).filter(value => typeof value === 'string' && value)) {
      assert(!text.includes(value), 'plaintext Stripe values must be absent from manifests and notes');
      assert(!nonSecret.includes(encode(value)), 'encoded credentials belong only in the bootstrap Secret');
    }
    assert(!nonSecret.includes(encoded), 'bootstrap JSON must be absent from other resources and notes');
    assert.equal(/^        checksum\/config: (.+)$/m.exec(text)[1], /^        checksum\/config: (.+)$/m.exec(disabled)[1],
      'billing credentials must not affect the pod config checksum');
  });
  check('standard and restricted test/live keys plus optional annual plans are accepted', () => {
    for (const prefix of ['sk_test_', 'sk_live_', 'rk_test_', 'rk_live_']) {
      const supplied = { ...billing, secretKey: ` ${prefix}Synthetic123 `,
        growthAnnualPriceId: 'price_GrowthAnnual123', scaleAnnualPriceId: 'price_ScaleAnnual123' };
      assert.deepEqual(bootstrap(success({ billing: supplied })).settings, { ...supplied, secretKey: supplied.secretKey.trim() });
    }
  });
  check('enabled billing requires valid credentials and both monthly prices', () => {
    for (const field of ['secretKey', 'webhookSecret', 'growthMonthlyPriceId', 'scaleMonthlyPriceId']) {
      for (const value of ['', marker]) reject({ [field]: value }, new RegExp(`billing.${field} must be a valid Stripe value`));
    }
    reject({ secretKey: `pk_test_${marker}` }, /billing.secretKey must be a valid Stripe value/);
    for (const field of ['growthAnnualPriceId', 'scaleAnnualPriceId']) {
      reject({ [field]: marker }, new RegExp(`billing.${field} must be a valid Stripe value`));
    }
  });
  check('nonblank plan and interval price IDs must be distinct', () => {
    for (const field of ['scaleMonthlyPriceId', 'growthAnnualPriceId', 'scaleAnnualPriceId']) {
      reject({ [field]: billing.growthMonthlyPriceId }, /price IDs must be different for each plan and interval/);
    }
  });
  check('type and length failures do not disclose supplied values', () => {
    for (const field of Object.keys(billing).filter(field => field !== 'enabled')) {
      reject({ [field]: { sensitive: marker } }, new RegExp(`billing.${field} must be a string`));
      reject({ [field]: false }, new RegExp(`billing.${field} must be a string`));
      const prefix = field === 'secretKey' ? 'sk_test_' : field === 'webhookSecret' ? 'whsec_' : 'price_';
      reject({ [field]: prefix + 'a'.repeat(513) }, new RegExp(`billing.${field} must be a valid Stripe value`));
    }
    reject({ enabled: marker }, /billing.enabled must be a boolean/);
  });
  check('missing billing block in older reused values remains disabled', () => {
    const file = path.join(chart, 'values.yaml');
    const oldValues = fs.readFileSync(file, 'utf8').replace(/^billing:\n(?:[ \t].*\n|\n)*/m, '');
    assert(!/^billing:/m.test(oldValues));
    fs.writeFileSync(file, oldValues);
    const text = success({});
    assert(!text.includes('GENOSYN_BILLING_BOOTSTRAP_JSON'));
    assert(!/^  name: genosyn-billing-bootstrap$/m.test(text));
  });
  process.stdout.write(`${checks} billing bootstrap chart checks passed\n`);
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
NODE
