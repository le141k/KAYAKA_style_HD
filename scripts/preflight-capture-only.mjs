#!/usr/bin/env node
/**
 * Validate the narrow, attended local IMAP capture test before restarting the API.
 *
 * This is deliberately separate from scripts/preflight.sh: the latter protects a
 * normal production deploy and correctly rejects any enabled capture mode. This
 * script prints only key names and safety outcomes, never environment values.
 */
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const requested = process.argv.slice(2);
if (requested.length > 1) {
  process.stderr.write('Usage: node scripts/preflight-capture-only.mjs [path/to/.env]\n');
  process.exit(2);
}
const envPath = resolve(requested[0] ?? resolve(root, '.env'));
const MAX_SAFE_QUEUE_ID = 9_007_199_254_740_991n;
const localEnvPath = resolve(root, '.env');

function assertLocalTestTarget(path) {
  if (process.env.NODE_ENV?.toLowerCase() === 'production') {
    throw new Error('Local capture preflight is forbidden when NODE_ENV=production');
  }
  if (path !== localEnvPath && process.env.NODE_ENV !== 'test') {
    throw new Error('Local capture preflight may inspect only this checkout\'s .env');
  }
}

function fail(message) {
  process.stderr.write(`[capture-preflight] FAIL ${message}\n`);
  process.exitCode = 1;
}

function ok(message) {
  process.stdout.write(`[capture-preflight] OK ${message}\n`);
}

function parseEnv(text) {
  const entries = new Map();
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    entries.set(key, value);
  }
  return entries;
}

function assertNoDuplicateKeys(text) {
  const seen = new Set();
  for (const rawLine of text.split(/\r?\n/u)) {
    const match = rawLine.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/u);
    if (!match) continue;
    const key = match[1];
    if (seen.has(key)) throw new Error(`duplicate key ${key}`);
    seen.add(key);
  }
}

function isTrue(value) {
  return /^(true|1|yes)$/iu.test(value ?? '');
}

function isFalse(value) {
  return /^(false|0|no)$/iu.test(value ?? '');
}

try {
  assertLocalTestTarget(envPath);
  const link = lstatSync(envPath);
  if (link.isSymbolicLink()) throw new Error('environment file must not be a symlink');
  const stat = statSync(envPath);
  if (!stat.isFile()) throw new Error('not a regular file');
  if ((stat.mode & 0o077) !== 0) throw new Error('permissions must be owner-only (chmod 600)');
  ok('environment file is owner-only');

  const envText = readFileSync(envPath, 'utf8');
  assertNoDuplicateKeys(envText);
  const env = parseEnv(envText);
  const value = (key) => env.get(key);
  if (value('NODE_ENV')?.trim().toLowerCase() === 'production') {
    throw new Error('local capture preflight refuses an environment configured for production');
  }
  const requireFalse = (key) => {
    if (isFalse(value(key))) ok(`${key} is fail-closed`);
    else fail(`${key} must be false for capture-only`);
  };
  const requireBlank = (key) => {
    if ((value(key) ?? '').trim() === '') ok(`${key} is blank`);
    else fail(`${key} must be blank for capture-only`);
  };

  requireFalse('TELECOM_HD_OUTBOUND_DELIVERY_ENABLED');
  requireFalse('TELECOM_HD_INBOUND_DELIVERY_ENABLED');
  requireBlank('TELECOM_HD_OUTBOUND_CANARY_EMAIL_ID');
  requireBlank('TELECOM_HD_OUTBOUND_CANARY_RECIPIENT');
  requireBlank('TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID');
  requireBlank('TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID');

  if (isTrue(value('TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED'))) {
    ok('TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED is enabled');
  } else {
    fail('TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED must be true for the attended test');
  }

  const queueId = value('TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID') ?? '';
  if (/^[1-9][0-9]*$/u.test(queueId) && BigInt(queueId) <= MAX_SAFE_QUEUE_ID) {
    ok('TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID is a positive safe queue id');
  } else {
    fail('TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID must be one positive safe selected queue id');
  }

  // The first Gmail proof is intentionally a one-message experiment. Do not turn this
  // command into a bulk mailbox capture by accepting a larger value here.
  if (value('TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES') === '1') {
    ok('TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES is exactly one');
  } else {
    fail('TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES must be exactly 1 for this test');
  }

  // Capture-only accepts an operator-entered IMAP credential through EmailQueue.
  // Refuse to certify a configuration that would leave that value on the legacy
  // plaintext fallback path. Print only the key name, never its value.
  if (/^[0-9a-f]{64}$/iu.test(value('TELECOM_HD_FIELD_ENCRYPTION_KEY') ?? '')) {
    ok('TELECOM_HD_FIELD_ENCRYPTION_KEY has a valid 256-bit format');
  } else {
    fail('TELECOM_HD_FIELD_ENCRYPTION_KEY must be exactly 64 hex characters for capture-only');
  }

  if (isTrue(value('TELECOM_HD_IMAP_ENABLED'))) ok('TELECOM_HD_IMAP_ENABLED is enabled for the selected IMAP queue');
  else fail('TELECOM_HD_IMAP_ENABLED must be true for the local Gmail IMAP test');

  if (value('TELECOM_HD_IMAP_BOOTSTRAP_POLICY') === 'FROM_NOW') {
    ok('TELECOM_HD_IMAP_BOOTSTRAP_POLICY is FROM_NOW');
  } else {
    fail('TELECOM_HD_IMAP_BOOTSTRAP_POLICY must be FROM_NOW for a no-history test');
  }
  if (value('TELECOM_HD_IMAP_BACKFILL_LIMIT') === '0') ok('TELECOM_HD_IMAP_BACKFILL_LIMIT is zero');
  else fail('TELECOM_HD_IMAP_BACKFILL_LIMIT must be 0 for a no-history test');

  if (process.exitCode) {
    process.stderr.write('[capture-preflight] Capture restart is blocked; no application state was changed.\n');
  } else {
    process.stdout.write('[capture-preflight] Safe one-message capture configuration is ready.\n');
  }
} catch (error) {
  // Never interpolate file contents or provider output: those may contain secrets.
  fail(`could not validate environment file (${error instanceof Error ? error.message : 'unknown error'})`);
}
