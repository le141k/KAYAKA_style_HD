import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const script = join(scriptsDir, 'preflight-production-normal-canary.sh');
const safeEnv = [
  'NODE_ENV=production',
  'TELECOM_HD_INBOUND_DELIVERY_ENABLED=true',
  'TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED=false',
  'TELECOM_HD_IMAP_ENABLED=false',
  'TELECOM_HD_OUTBOUND_DELIVERY_ENABLED=false',
  'TELECOM_HD_OUTBOUND_CANARY_EMAIL_ID=',
  'TELECOM_HD_OUTBOUND_CANARY_RECIPIENT=',
  'TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID=42',
  'TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID=99',
  'TELECOM_HD_IMAP_BOOTSTRAP_POLICY=FROM_NOW',
  'TELECOM_HD_IMAP_BACKFILL_LIMIT=0',
  `TELECOM_HD_FIELD_ENCRYPTION_KEY=${'a'.repeat(64)}`,
].join('\n');

function run(content) {
  const directory = mkdtempSync(join(tmpdir(), 'telecom-hd-production-normal-canary-'));
  const envFile = join(directory, '.env.prod');
  try {
    writeFileSync(envFile, content, { mode: 0o600 });
    chmodSync(envFile, 0o600);
    return spawnSync('bash', [script, envFile], { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('production normal-canary preflight accepts one promoted delivery with all other transports closed', () => {
  const result = run(safeEnv);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /NORMAL_CANARY_DELIVERY_ID/u);
});

test('production normal-canary preflight rejects an open SMTP/IMAP path or an incomplete selector pair', () => {
  const result = run(
    safeEnv
      .replace('TELECOM_HD_IMAP_ENABLED=false', 'TELECOM_HD_IMAP_ENABLED=true')
      .replace('TELECOM_HD_OUTBOUND_DELIVERY_ENABLED=false', 'TELECOM_HD_OUTBOUND_DELIVERY_ENABLED=true')
      .replace('TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID=99', 'TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID='),
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /IMAP_ENABLED/u);
  assert.match(result.stderr, /OUTBOUND_DELIVERY_ENABLED/u);
  assert.match(result.stderr, /NORMAL_CANARY_DELIVERY_ID/u);
});

test('production normal-canary preflight never prints a malformed field key', () => {
  const secretLookingKey = 'do-not-print-normal-canary-key';
  const result = run(safeEnv.replace(`TELECOM_HD_FIELD_ENCRYPTION_KEY=${'a'.repeat(64)}`, `TELECOM_HD_FIELD_ENCRYPTION_KEY=${secretLookingKey}`));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FIELD_ENCRYPTION_KEY/u);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secretLookingKey, 'u'));
});
