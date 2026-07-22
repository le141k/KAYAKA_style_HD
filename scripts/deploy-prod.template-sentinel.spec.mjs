import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const root = dirname(scriptsDir);
const script = readFileSync(join(scriptsDir, 'deploy-prod.sh'), 'utf8');
const cutoverRunbook = readFileSync(
  join(root, 'docs', 'INBOUND_PRODUCTION_CUTOVER.md'),
  'utf8',
);
const preflight = readFileSync(join(scriptsDir, 'preflight.sh'), 'utf8');
const productionEnvTemplate = readFileSync(join(root, '.env.prod.example'), 'utf8');

const guards = [
  `NULLIF(regexp_replace("subject", '[[:space:]]+', '', 'g'), '') IS NOT NULL`,
  `NULLIF(regexp_replace("htmlBody", '[[:space:]]+', '', 'g'), '') IS NOT NULL`,
  `NULLIF(regexp_replace("textBody", '[[:space:]]+', '', 'g'), '') IS NOT NULL`,
];

test('deploy template sentinel rejects every whitespace-only required field', () => {
  for (const source of [script, cutoverRunbook]) {
    for (const guard of guards) assert.ok(source.includes(guard), guard);
    assert.ok(!source.includes('NULLIF(BTRIM("subject"), \'\') IS NOT NULL'));
  }

  // This mirrors PostgreSQL [[:space:]]+ for the inputs that BTRIM misses.
  const isPresent = (value) => value.replace(/\s+/gu, '').length > 0;
  for (const whitespace of ['', ' ', '\t', '\n', ' \t\n ']) {
    assert.equal(isPresent(whitespace), false, JSON.stringify(whitespace));
  }
  assert.equal(isPresent(' A \n'), true);
});

test('preflight closes inbound delivery and IMAP before deploy-prod can start release work', () => {
  assert.match(productionEnvTemplate, /^TELECOM_HD_INBOUND_DELIVERY_ENABLED=false$/m);
  assert.match(productionEnvTemplate, /^TELECOM_HD_IMAP_ENABLED=false$/m);
  assert.ok(preflight.includes('TELECOM_HD_INBOUND_DELIVERY_ENABLED'));
  assert.ok(preflight.includes('TELECOM_HD_IMAP_ENABLED'));
  assert.ok(preflight.includes('if is_true "$INBOUND_DELIVERY_ENABLED"; then'));
  assert.ok(preflight.includes('if is_true "$IMAP_ENABLED"; then'));

  const preflightInvocation = script.indexOf('bash scripts/preflight.sh "$ENV_FILE"');
  const forwardBoundary = script.indexOf("crossing the verified forward-only boundary");
  assert.ok(preflightInvocation >= 0, 'deploy-prod must invoke preflight');
  assert.ok(forwardBoundary > preflightInvocation, 'preflight must run before migration/service work');
});
