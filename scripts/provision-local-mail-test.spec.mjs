import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const script = join(scriptsDir, 'provision-local-mail-test.mjs');
const smtpSecret = 'smtp-secret-must-not-appear-in-output';

function withFiles(callback) {
  const directory = mkdtempSync(join(tmpdir(), 'telecom-hd-mail-provision-'));
  const source = join(directory, 'credentials.env');
  const target = join(directory, '.env');
  try {
    writeFileSync(
      source,
      [
        'TELECOM_HD_SMTP_HOST=smtp.example.test',
        'TELECOM_HD_SMTP_PORT=587',
        'TELECOM_HD_SMTP_SECURE=false',
        'TELECOM_HD_SMTP_USER=test@example.test',
        `TELECOM_HD_SMTP_PASSWORD=${smtpSecret}`,
        'TELECOM_HD_MAIL_FROM="Test <test@example.test>"',
      ].join('\n'),
      { mode: 0o600 },
    );
    chmodSync(source, 0o600);
    writeFileSync(
      target,
      [
        'NODE_ENV=development',
        'TELECOM_HD_OUTBOUND_CANARY_EMAIL_ID=cmoutbox00000000000000001',
        'TELECOM_HD_OUTBOUND_CANARY_RECIPIENT=old-canary@example.test',
        'TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID=77',
        'TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID=88',
      ].join('\n'),
      { mode: 0o600 },
    );
    chmodSync(target, 0o600);
    callback({ source, target });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function provision(source, target) {
  return spawnSync(process.execPath, [script, '--source', source, '--target', target], {
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' },
  });
}

test('provision generates an owner-only field key without printing credentials or the key', () => {
  withFiles(({ source, target }) => {
    const result = provision(source, target);
    assert.equal(result.status, 0, result.stderr);
    const output = `${result.stdout}${result.stderr}`;
    assert.doesNotMatch(output, new RegExp(smtpSecret, 'u'));

    const targetText = readFileSync(target, 'utf8');
    const match = targetText.match(/^TELECOM_HD_FIELD_ENCRYPTION_KEY=([0-9a-f]{64})$/mu);
    assert.ok(match, 'expected one valid generated field-encryption key');
    assert.doesNotMatch(output, new RegExp(match[1], 'u'));
    assert.equal(statSync(target).mode & 0o077, 0);
    assert.match(targetText, /^TELECOM_HD_OUTBOUND_DELIVERY_ENABLED=false$/mu);
    assert.match(targetText, /^TELECOM_HD_INBOUND_DELIVERY_ENABLED=false$/mu);
    assert.match(targetText, /^TELECOM_HD_OUTBOUND_CANARY_EMAIL_ID=$/mu);
    assert.match(targetText, /^TELECOM_HD_OUTBOUND_CANARY_RECIPIENT=$/mu);
    assert.match(targetText, /^TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID=$/mu);
    assert.match(targetText, /^TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID=$/mu);
  });
});

test('provision preserves an existing valid field key and refuses to replace a malformed non-empty one', () => {
  withFiles(({ source, target }) => {
    const preserved = 'b'.repeat(64);
    writeFileSync(target, `NODE_ENV=development\nTELECOM_HD_FIELD_ENCRYPTION_KEY=${preserved}\n`, { mode: 0o600 });
    chmodSync(target, 0o600);

    const first = provision(source, target);
    assert.equal(first.status, 0, first.stderr);
    assert.match(readFileSync(target, 'utf8'), new RegExp(`^TELECOM_HD_FIELD_ENCRYPTION_KEY=${preserved}$`, 'mu'));

    writeFileSync(target, 'TELECOM_HD_FIELD_ENCRYPTION_KEY=not-valid\n', { mode: 0o600 });
    chmodSync(target, 0o600);
    const second = provision(source, target);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /FIELD_ENCRYPTION_KEY/u);
    assert.doesNotMatch(`${second.stdout}${second.stderr}`, /not-valid/u);
  });
});

test('provision refuses production-labelled configuration and arbitrary interactive target paths', () => {
  withFiles(({ source, target }) => {
    writeFileSync(target, 'NODE_ENV=production\n', { mode: 0o600 });
    chmodSync(target, 0o600);
    const productionFile = provision(source, target);
    assert.notEqual(productionFile.status, 0);
    assert.match(productionFile.stderr, /production/u);

    const interactiveOutsideRoot = spawnSync(process.execPath, [script, '--source', source, '--target', target], {
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'development' },
    });
    assert.notEqual(interactiveOutsideRoot.status, 0);
    assert.match(interactiveOutsideRoot.stderr, /only this checkout/u);
  });
});

test('provision refuses to read an existing target environment file with broad permissions', () => {
  withFiles(({ source, target }) => {
    chmodSync(target, 0o644);
    const result = provision(source, target);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Target environment file permissions.*owner-only/u);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(smtpSecret, 'u'));
  });
});
