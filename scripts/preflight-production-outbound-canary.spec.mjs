import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const script = join(scriptsDir, 'preflight-production-outbound-canary.sh');
const safeEnv = [
  'NODE_ENV=production',
  'TELECOM_HD_INBOUND_DELIVERY_ENABLED=false',
  'TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED=false',
  'TELECOM_HD_IMAP_ENABLED=false',
  'TELECOM_HD_OUTBOUND_DELIVERY_ENABLED=true',
  'TELECOM_HD_OUTBOUND_CANARY_EMAIL_ID=cmoutbox00000000000000001',
  'TELECOM_HD_OUTBOUND_CANARY_RECIPIENT=approved@example.test',
  'TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID=',
  'TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID=',
].join('\n');

function run(content) {
  const directory = mkdtempSync(join(tmpdir(), 'telecom-hd-production-outbound-canary-'));
  const envFile = join(directory, '.env.prod');
  try {
    writeFileSync(envFile, content, { mode: 0o600 });
    chmodSync(envFile, 0o600);
    return spawnSync('bash', [script, envFile], { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('production outbound-canary preflight accepts one durable command while inbound is closed', () => {
  const result = run(safeEnv);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OUTBOUND_CANARY_EMAIL_ID/u);
});

test('production outbound-canary preflight rejects an open inbound transport and unsafe canary scope', () => {
  const result = run(
    safeEnv
      .replace('TELECOM_HD_INBOUND_DELIVERY_ENABLED=false', 'TELECOM_HD_INBOUND_DELIVERY_ENABLED=true')
      .replace('TELECOM_HD_IMAP_ENABLED=false', 'TELECOM_HD_IMAP_ENABLED=true')
      .replace('TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID=', 'TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID=42')
      .replace('TELECOM_HD_OUTBOUND_CANARY_RECIPIENT=approved@example.test', 'TELECOM_HD_OUTBOUND_CANARY_RECIPIENT='),
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /INBOUND_DELIVERY_ENABLED/u);
  assert.match(result.stderr, /IMAP_ENABLED/u);
  assert.match(result.stderr, /INBOUND_NORMAL_CANARY_QUEUE_ID/u);
  assert.match(result.stderr, /OUTBOUND_CANARY_RECIPIENT/u);
});

test('production outbound-canary preflight does not print an invalid recipient', () => {
  const secretLookingRecipient = 'do-not-print-this';
  const result = run(safeEnv.replace('approved@example.test', secretLookingRecipient));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OUTBOUND_CANARY_RECIPIENT/u);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secretLookingRecipient, 'u'));
});
