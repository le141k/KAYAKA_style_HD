import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const script = join(scriptsDir, 'preflight-capture-only.mjs');
const shellScript = join(scriptsDir, 'preflight-capture-only.sh');

function run(content) {
  const directory = mkdtempSync(join(tmpdir(), 'telecom-hd-capture-preflight-'));
  const envFile = join(directory, '.env');
  try {
    writeFileSync(envFile, content, { mode: 0o600 });
    chmodSync(envFile, 0o600);
    return spawnSync(process.execPath, [script, envFile], {
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test' },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runShell(content) {
  const directory = mkdtempSync(join(tmpdir(), 'telecom-hd-capture-shell-preflight-'));
  const envFile = join(directory, '.env');
  try {
    writeFileSync(envFile, content, { mode: 0o600 });
    chmodSync(envFile, 0o600);
    return spawnSync('bash', [shellScript, envFile], {
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test' },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const safeCaptureEnv = [
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

test('capture preflight accepts exactly one selected IMAP queue with all normal delivery gates closed', () => {
  const result = run(safeCaptureEnv);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /exactly one/u);
});

test('capture preflight rejects normal delivery or a bulk capture count', () => {
  const result = run(
    safeCaptureEnv
      .replace('TELECOM_HD_INBOUND_DELIVERY_ENABLED=false', 'TELECOM_HD_INBOUND_DELIVERY_ENABLED=true')
      .replace('TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES=1', 'TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES=2'),
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /INBOUND_DELIVERY_ENABLED/u);
  assert.match(result.stderr, /CAPTURE_MAX_MESSAGES/u);
});

test('both local capture preflights reject a lingering normal or SMTP canary selector', () => {
  const staleSelectors = `${safeCaptureEnv}\nTELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID=42\nTELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID=99\nTELECOM_HD_OUTBOUND_CANARY_EMAIL_ID=cmoutbox00000000000000001\n`;
  for (const result of [run(staleSelectors), runShell(staleSelectors)]) {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /NORMAL_CANARY_QUEUE_ID/u);
    assert.match(result.stderr, /NORMAL_CANARY_DELIVERY_ID/u);
    assert.match(result.stderr, /OUTBOUND_CANARY_EMAIL_ID/u);
  }
});

test('both local capture preflights reject a queue id beyond Number.MAX_SAFE_INTEGER', () => {
  const unsafe = safeCaptureEnv.replace(
    'TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID=42',
    'TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID=9007199254740992',
  );
  for (const result of [run(unsafe), runShell(unsafe)]) {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CAPTURE_QUEUE_ID/u);
  }
});

test('capture preflight rejects a missing or malformed field key without echoing it', () => {
  const badKey = 'not-a-valid-key-value';
  const result = run(
    safeCaptureEnv.replace(`TELECOM_HD_FIELD_ENCRYPTION_KEY=${'a'.repeat(64)}`, `TELECOM_HD_FIELD_ENCRYPTION_KEY=${badKey}`),
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FIELD_ENCRYPTION_KEY/u);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(badKey, 'u'));
});

test('portable Bash capture preflight enforces the same encrypted one-message gate without values', () => {
  const safe = runShell(safeCaptureEnv);
  assert.equal(safe.status, 0, safe.stderr);
  const fieldKey = 'a'.repeat(64);
  assert.doesNotMatch(`${safe.stdout}${safe.stderr}`, new RegExp(fieldKey, 'u'));

  const secretLookingBadKey = 'not-a-valid-key-value';
  const blocked = runShell(
    safeCaptureEnv.replace(
      `TELECOM_HD_FIELD_ENCRYPTION_KEY=${fieldKey}`,
      `TELECOM_HD_FIELD_ENCRYPTION_KEY=${secretLookingBadKey}`,
    ),
  );
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /FIELD_ENCRYPTION_KEY/u);
  assert.doesNotMatch(`${blocked.stdout}${blocked.stderr}`, new RegExp(secretLookingBadKey, 'u'));
});

test('both capture preflights reject a production-labelled configuration', () => {
  const production = `${safeCaptureEnv}\nNODE_ENV=production\n`;
  for (const result of [run(production), runShell(production)]) {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /production/u);
  }
});
