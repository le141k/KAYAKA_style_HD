import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const script = join(scriptsDir, 'set-local-imap-capture.mjs');

function withEnv(callback) {
  const directory = mkdtempSync(join(tmpdir(), 'telecom-hd-capture-gate-'));
  const envFile = join(directory, '.env');
  try {
    writeFileSync(
      envFile,
      [
        'TELECOM_HD_SMTP_PASSWORD=not-printed',
        'TELECOM_HD_OUTBOUND_DELIVERY_ENABLED=false',
        'TELECOM_HD_OUTBOUND_CANARY_EMAIL_ID=cmoutbox00000000000000001',
        'TELECOM_HD_OUTBOUND_CANARY_RECIPIENT=old-canary@example.test',
        'TELECOM_HD_INBOUND_DELIVERY_ENABLED=false',
        'TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID=77',
        'TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID=88',
        'TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED=false',
        'TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID=',
        'TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES=1',
        `TELECOM_HD_FIELD_ENCRYPTION_KEY=${'a'.repeat(64)}`,
        'TELECOM_HD_IMAP_ENABLED=false',
        'TELECOM_HD_IMAP_BOOTSTRAP_POLICY=FROM_NOW',
        'TELECOM_HD_IMAP_BACKFILL_LIMIT=0',
      ].join('\n'),
      { mode: 0o600 },
    );
    chmodSync(envFile, 0o600);
    callback(envFile);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('sets one-message capture gates and closes them again without printing secret values', () => {
  withEnv((envFile) => {
    const enable = spawnSync(process.execPath, [script, '--queue-id', '42', '--env', envFile], {
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test' },
    });
    assert.equal(enable.status, 0, enable.stderr);
    assert.doesNotMatch(`${enable.stdout}${enable.stderr}`, /not-printed/u);
    const enabled = readFileSync(envFile, 'utf8');
    assert.match(enabled, /^TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED=true$/m);
    assert.match(enabled, /^TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID=42$/m);
    assert.match(enabled, /^TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES=1$/m);
    assert.match(enabled, /^TELECOM_HD_IMAP_ENABLED=true$/m);
    assert.match(enabled, /^TELECOM_HD_OUTBOUND_CANARY_EMAIL_ID=$/m);
    assert.match(enabled, /^TELECOM_HD_OUTBOUND_CANARY_RECIPIENT=$/m);
    assert.match(enabled, /^TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID=$/m);
    assert.match(enabled, /^TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID=$/m);

    const disable = spawnSync(process.execPath, [script, '--disable', '--env', envFile], {
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test' },
    });
    assert.equal(disable.status, 0, disable.stderr);
    const closed = readFileSync(envFile, 'utf8');
    assert.match(closed, /^TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED=false$/m);
    assert.match(closed, /^TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID=$/m);
    assert.match(closed, /^TELECOM_HD_IMAP_ENABLED=false$/m);
    assert.match(closed, /^TELECOM_HD_OUTBOUND_CANARY_EMAIL_ID=$/m);
    assert.match(closed, /^TELECOM_HD_OUTBOUND_CANARY_RECIPIENT=$/m);
    assert.match(closed, /^TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID=$/m);
    assert.match(closed, /^TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID=$/m);
  });
});

test('rejects an unsafe noncanonical queue id', () => {
  withEnv((envFile) => {
    for (const queueId of ['0042', '9007199254740992']) {
      const result = spawnSync(process.execPath, [script, '--queue-id', queueId, '--env', envFile], {
        encoding: 'utf8',
        env: { ...process.env, NODE_ENV: 'test' },
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /canonical positive safe integer/u);
    }
  });
});

test('refuses a duplicate gate key instead of updating an ambiguous environment file', () => {
  withEnv((envFile) => {
    writeFileSync(
      envFile,
      `${readFileSync(envFile, 'utf8')}\nTELECOM_HD_INBOUND_DELIVERY_ENABLED=true\n`,
      { mode: 0o600 },
    );
    const result = spawnSync(process.execPath, [script, '--queue-id', '42', '--env', envFile], {
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test' },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /duplicate key TELECOM_HD_INBOUND_DELIVERY_ENABLED/u);
  });
});

test('refuses to open capture when the local credential-encryption key is invalid, but still permits emergency close', () => {
  withEnv((envFile) => {
    writeFileSync(
      envFile,
      readFileSync(envFile, 'utf8').replace(`TELECOM_HD_FIELD_ENCRYPTION_KEY=${'a'.repeat(64)}`, 'TELECOM_HD_FIELD_ENCRYPTION_KEY=bad'),
      { mode: 0o600 },
    );
    const enable = spawnSync(process.execPath, [script, '--queue-id', '42', '--env', envFile], {
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test' },
    });
    assert.notEqual(enable.status, 0);
    assert.match(enable.stderr, /FIELD_ENCRYPTION_KEY/u);

    const disable = spawnSync(process.execPath, [script, '--disable', '--env', envFile], {
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test' },
    });
    assert.equal(disable.status, 0, disable.stderr);
  });
});

test('capture gate refuses a production-labelled configuration and arbitrary interactive target paths', () => {
  withEnv((envFile) => {
    writeFileSync(envFile, `${readFileSync(envFile, 'utf8')}\nNODE_ENV=production\n`, { mode: 0o600 });
    chmodSync(envFile, 0o600);
    const productionFile = spawnSync(process.execPath, [script, '--disable', '--env', envFile], {
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test' },
    });
    assert.notEqual(productionFile.status, 0);
    assert.match(productionFile.stderr, /production/u);

    const interactiveOutsideRoot = spawnSync(process.execPath, [script, '--disable', '--env', envFile], {
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'development' },
    });
    assert.notEqual(interactiveOutsideRoot.status, 0);
    assert.match(interactiveOutsideRoot.stderr, /only this checkout/u);
  });
});
