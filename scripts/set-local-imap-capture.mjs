#!/usr/bin/env node
/**
 * Atomically open/close only the local one-message IMAP capture test gates.
 * It never reads or prints SMTP/IMAP secret values and does not start containers.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const MAX_SAFE_QUEUE_ID = 9_007_199_254_740_991n;
const localEnvPath = resolve(root, '.env');

function assertLocalTestTarget(path) {
  if (process.env.NODE_ENV?.toLowerCase() === 'production') {
    throw new Error('Local capture gate updates are forbidden when NODE_ENV=production');
  }
  if (path !== localEnvPath && process.env.NODE_ENV !== 'test') {
    throw new Error('Local capture gate updates may write only this checkout\'s .env');
  }
}

function option(name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function usage() {
  process.stderr.write(
    'Usage: node scripts/set-local-imap-capture.mjs --queue-id <positive-id> [--env path]\n' +
      '   or: node scripts/set-local-imap-capture.mjs --disable [--env path]\n',
  );
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
    if (seen.has(key)) throw new Error(`environment file contains duplicate key ${key}`);
    seen.add(key);
  }
}

function quoted(value) {
  return /[\s#]/u.test(value) ? JSON.stringify(value) : value;
}

function setEnv(text, key, value) {
  const line = `${key}=${quoted(value)}`;
  const pattern = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const expression = new RegExp(`^${pattern}\\s*=.*$`, 'mu');
  return expression.test(text) ? text.replace(expression, line) : `${text.replace(/\s*$/u, '')}\n${line}\n`;
}

/** Atomically replace the local secret file without leaving an untracked temp copy on failure. */
function replaceOwnerOnlyEnv(path, contents) {
  let temporaryPath;
  try {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = `${path}.tmp-${process.pid}-${randomBytes(12).toString('hex')}`;
      try {
        writeFileSync(candidate, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        temporaryPath = candidate;
        break;
      } catch (error) {
        if (error && typeof error === 'object' && error.code === 'EEXIST') continue;
        throw error;
      }
    }
    if (!temporaryPath) throw new Error('Could not allocate a secure temporary environment file');
    renameSync(temporaryPath, path);
    temporaryPath = undefined;
    chmodSync(path, 0o600);
  } finally {
    if (temporaryPath) {
      try {
        rmSync(temporaryPath, { force: true });
      } catch {
        // The gitignore rule is a second safety net; never replace the original error.
      }
    }
  }
}

try {
  const disable = args.includes('--disable');
  const rawQueueId = option('--queue-id');
  const rawEnv = option('--env');
  const known = new Set(['--disable', '--queue-id', '--env']);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`);
    if (arg.startsWith('--') && !known.has(arg)) throw new Error(`unknown option ${arg}`);
    if (arg === '--queue-id' || arg === '--env') index += 1;
  }
  if (disable === Boolean(rawQueueId)) {
    usage();
    throw new Error('choose exactly one of --queue-id or --disable');
  }
  if (
    rawQueueId &&
    (!/^[1-9][0-9]*$/u.test(rawQueueId) || BigInt(rawQueueId) > MAX_SAFE_QUEUE_ID)
  ) {
    throw new Error('--queue-id must be a canonical positive safe integer');
  }

  const envPath = resolve(rawEnv ?? resolve(root, '.env'));
  assertLocalTestTarget(envPath);
  const link = lstatSync(envPath);
  if (link.isSymbolicLink()) throw new Error('environment file must not be a symlink');
  const stat = statSync(envPath);
  if (!stat.isFile()) throw new Error('environment path is not a regular file');
  if ((stat.mode & 0o077) !== 0) throw new Error('environment file permissions must be owner-only (chmod 600)');

  // Parse only to prove the file is well-formed enough to carry configuration. Values
  // are intentionally not reported or otherwise used by this gate-only helper.
  let next = readFileSync(envPath, 'utf8');
  assertNoDuplicateKeys(next);
  const current = parseEnv(next);
  if (current.get('NODE_ENV')?.trim().toLowerCase() === 'production') {
    throw new Error('Local capture gate updates refuse an environment configured for production');
  }
  if (!disable && !/^[0-9a-f]{64}$/iu.test(current.get('TELECOM_HD_FIELD_ENCRYPTION_KEY') ?? '')) {
    throw new Error('TELECOM_HD_FIELD_ENCRYPTION_KEY must be exactly 64 hex characters before capture is enabled');
  }
  const changes = disable
    ? [
        ['TELECOM_HD_OUTBOUND_DELIVERY_ENABLED', 'false'],
        ['TELECOM_HD_OUTBOUND_CANARY_EMAIL_ID', ''],
        ['TELECOM_HD_OUTBOUND_CANARY_RECIPIENT', ''],
        ['TELECOM_HD_INBOUND_DELIVERY_ENABLED', 'false'],
        ['TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID', ''],
        ['TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID', ''],
        ['TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED', 'false'],
        ['TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID', ''],
        ['TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES', '1'],
        ['TELECOM_HD_IMAP_ENABLED', 'false'],
      ]
    : [
        ['TELECOM_HD_OUTBOUND_DELIVERY_ENABLED', 'false'],
        ['TELECOM_HD_OUTBOUND_CANARY_EMAIL_ID', ''],
        ['TELECOM_HD_OUTBOUND_CANARY_RECIPIENT', ''],
        ['TELECOM_HD_INBOUND_DELIVERY_ENABLED', 'false'],
        ['TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID', ''],
        ['TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID', ''],
        ['TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED', 'true'],
        ['TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID', rawQueueId],
        ['TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES', '1'],
        ['TELECOM_HD_IMAP_ENABLED', 'true'],
        ['TELECOM_HD_IMAP_BOOTSTRAP_POLICY', 'FROM_NOW'],
        ['TELECOM_HD_IMAP_BACKFILL_LIMIT', '0'],
      ];
  for (const [key, value] of changes) next = setEnv(next, key, value);
  replaceOwnerOnlyEnv(envPath, next);
  process.stdout.write(
    disable
      ? 'Local environment gates were updated. Force-recreate the API and verify health before considering ingress closed.\n'
      : 'Local one-message IMAP capture gates are prepared; run preflight-capture-only before restarting the API.\n',
  );
} catch (error) {
  // Do not include file contents / values in an error: either could contain credentials.
  process.stderr.write(
    `Local capture gate update stopped: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exitCode = 1;
}
