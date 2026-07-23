import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const script = join(scriptsDir, 'preflight-production-capture-only.sh');

const safeProductionCapture = [
  'NODE_ENV=production',
  'TELECOM_HD_OUTBOUND_DELIVERY_ENABLED=false',
  'TELECOM_HD_INBOUND_DELIVERY_ENABLED=false',
  'TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED=true',
  'TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID=42',
  'TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES=1',
  `TELECOM_HD_FIELD_ENCRYPTION_KEY=${'a'.repeat(64)}`,
  'TELECOM_HD_IMAP_ENABLED=true',
  'TELECOM_HD_IMAP_BOOTSTRAP_POLICY=FROM_NOW',
  'TELECOM_HD_IMAP_BACKFILL_LIMIT=0',
].join('\n');

function run(content, environment = { ...process.env, NODE_ENV: 'test' }) {
  const directory = mkdtempSync(join(tmpdir(), 'telecom-hd-production-capture-preflight-'));
  const envFile = join(directory, '.env.prod');
  try {
    writeFileSync(envFile, content, { mode: 0o600 });
    chmodSync(envFile, 0o600);
    return spawnSync('bash', [script, envFile], { encoding: 'utf8', env: environment });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('production capture preflight allows exactly one TLS IMAP hold with all delivery gates closed', () => {
  const result = run(safeProductionCapture);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /exactly one/u);
});

test('production capture preflight rejects normal delivery, outbound send, backfill, and a bulk cap', () => {
  const result = run(
    safeProductionCapture
      .replace('TELECOM_HD_OUTBOUND_DELIVERY_ENABLED=false', 'TELECOM_HD_OUTBOUND_DELIVERY_ENABLED=true')
      .replace('TELECOM_HD_INBOUND_DELIVERY_ENABLED=false', 'TELECOM_HD_INBOUND_DELIVERY_ENABLED=true')
      .replace('TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES=1', 'TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES=2')
      .replace('TELECOM_HD_IMAP_BOOTSTRAP_POLICY=FROM_NOW', 'TELECOM_HD_IMAP_BOOTSTRAP_POLICY=BACKFILL')
      .replace('TELECOM_HD_IMAP_BACKFILL_LIMIT=0', 'TELECOM_HD_IMAP_BACKFILL_LIMIT=1'),
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OUTBOUND_DELIVERY_ENABLED/u);
  assert.match(result.stderr, /INBOUND_DELIVERY_ENABLED/u);
  assert.match(result.stderr, /CAPTURE_MAX_MESSAGES/u);
  assert.match(result.stderr, /BOOTSTRAP_POLICY/u);
  assert.match(result.stderr, /BACKFILL_LIMIT/u);
});

test('production capture preflight rejects lingering normal or SMTP canary selectors', () => {
  const result = run(
    `${safeProductionCapture}\nTELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID=42\nTELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID=99\nTELECOM_HD_OUTBOUND_CANARY_RECIPIENT=approved@example.test\n`,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /NORMAL_CANARY_QUEUE_ID/u);
  assert.match(result.stderr, /NORMAL_CANARY_DELIVERY_ID/u);
  assert.match(result.stderr, /OUTBOUND_CANARY_RECIPIENT/u);
});

test('production capture preflight never prints an invalid field-encryption key', () => {
  const secretLookingBadKey = 'do-not-print-this-production-key';
  const result = run(
    safeProductionCapture.replace(`TELECOM_HD_FIELD_ENCRYPTION_KEY=${'a'.repeat(64)}`, `TELECOM_HD_FIELD_ENCRYPTION_KEY=${secretLookingBadKey}`),
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FIELD_ENCRYPTION_KEY/u);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secretLookingBadKey, 'u'));
});

test('production capture preflight rejects an arbitrary interactive target path', () => {
  const result = run(safeProductionCapture, { ...process.env, NODE_ENV: 'development' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only this checkout/u);
});
