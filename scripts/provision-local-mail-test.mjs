#!/usr/bin/env node
/**
 * Copy only outbound SMTP settings from an owner-only local credential file into
 * the ignored development `.env`, with every mail-processing gate fail-closed.
 *
 * IMAP credentials deliberately stay out of `.env`: they are entered through the
 * authenticated EmailQueue API/UI and stored using the application's field-level
 * encryption path. This script never prints any credential value.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a path`);
  return resolve(value);
};

const sourcePath = option('--source', resolve(homedir(), '.config/23telecom-helpdesk/inbound-test.env'));
const targetPath = option('--target', resolve(root, '.env'));
const localEnvPath = resolve(root, '.env');

/**
 * These scripts are deliberately for the disposable local test flow, never a
 * production configuration writer.  Unit tests use isolated temporary paths
 * under NODE_ENV=test; interactive use is restricted to this checkout's .env.
 */
function assertLocalTestTarget(path) {
  if (process.env.NODE_ENV?.toLowerCase() === 'production') {
    throw new Error('Local mail-test provisioning is forbidden when NODE_ENV=production');
  }
  if (path !== localEnvPath && process.env.NODE_ENV !== 'test') {
    throw new Error('Local mail-test provisioning may write only this checkout\'s .env');
  }
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

function assertNoDuplicateKeys(text, label) {
  const seen = new Set();
  for (const rawLine of text.split(/\r?\n/u)) {
    const match = rawLine.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/u);
    if (!match) continue;
    const key = match[1];
    if (seen.has(key)) throw new Error(`${label} contains duplicate key ${key}`);
    seen.add(key);
  }
}

function requireValue(entries, key) {
  const value = entries.get(key)?.trim();
  if (!value) throw new Error(`Credential file is missing ${key}`);
  return value;
}

function quoted(value) {
  // dotenv accepts unquoted values here, but quoting preserves display names in MAIL_FROM.
  return /[\s#]/u.test(value) ? JSON.stringify(value) : value;
}

function setEnv(text, key, value) {
  const line = `${key}=${quoted(value)}`;
  const expression = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*=.*$`, 'mu');
  return expression.test(text) ? text.replace(expression, line) : `${text.replace(/\s*$/u, '')}\n${line}\n`;
}

/** Write beside the destination then atomically rename; never leave a secret-bearing temp file behind. */
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
  assertLocalTestTarget(targetPath);
  const sourceLink = lstatSync(sourcePath);
  if (sourceLink.isSymbolicLink() || !sourceLink.isFile()) {
    throw new Error('Credential file must be a regular non-symlink file');
  }
  const sourceStat = statSync(sourcePath);
  if ((sourceStat.mode & 0o077) !== 0) {
    throw new Error('Credential file permissions must be owner-only (chmod 600)');
  }
  const sourceText = readFileSync(sourcePath, 'utf8');
  assertNoDuplicateKeys(sourceText, 'Credential file');
  const credentials = parseEnv(sourceText);
  const smtpHost = requireValue(credentials, 'TELECOM_HD_SMTP_HOST');
  const smtpPort = requireValue(credentials, 'TELECOM_HD_SMTP_PORT');
  const smtpSecure = requireValue(credentials, 'TELECOM_HD_SMTP_SECURE');
  const smtpUser = requireValue(credentials, 'TELECOM_HD_SMTP_USER');
  const smtpPassword = requireValue(credentials, 'TELECOM_HD_SMTP_PASSWORD');
  const mailFrom = requireValue(credentials, 'TELECOM_HD_MAIL_FROM');
  if (!/^\d{1,5}$/u.test(smtpPort) || Number(smtpPort) < 1 || Number(smtpPort) > 65535) {
    throw new Error('Credential file has an invalid TELECOM_HD_SMTP_PORT');
  }
  if (!/^(true|false)$/iu.test(smtpSecure)) {
    throw new Error('Credential file has an invalid TELECOM_HD_SMTP_SECURE (use true or false)');
  }

  if (existsSync(targetPath)) {
    const targetLink = lstatSync(targetPath);
    if (targetLink.isSymbolicLink() || !targetLink.isFile()) {
      throw new Error('Target environment file must be a regular non-symlink file');
    }
    if ((statSync(targetPath).mode & 0o077) !== 0) {
      throw new Error('Target environment file permissions must be owner-only (chmod 600)');
    }
  }
  let target = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : readFileSync(resolve(root, '.env.example'), 'utf8');
  assertNoDuplicateKeys(target, 'Target environment file');
  const existingTarget = parseEnv(target);
  if (existingTarget.get('NODE_ENV')?.trim().toLowerCase() === 'production') {
    throw new Error('Local mail-test provisioning refuses an environment configured for production');
  }
  const existingFieldKey = existingTarget.get('TELECOM_HD_FIELD_ENCRYPTION_KEY')?.trim() ?? '';
  if (existingFieldKey && !/^[0-9a-f]{64}$/iu.test(existingFieldKey)) {
    // Never replace a malformed non-empty value automatically: it could be the
    // only key capable of decrypting an existing queue password. Stop for an
    // operator decision instead of silently stranding encrypted data.
    throw new Error('Target environment file has an invalid TELECOM_HD_FIELD_ENCRYPTION_KEY');
  }
  const fieldEncryptionKey = existingFieldKey || randomBytes(32).toString('hex');
  for (const [key, value] of [
    ['TELECOM_HD_SMTP_HOST', smtpHost],
    ['TELECOM_HD_SMTP_PORT', smtpPort],
    ['TELECOM_HD_SMTP_SECURE', smtpSecure.toLowerCase()],
    ['TELECOM_HD_SMTP_USER', smtpUser],
    ['TELECOM_HD_SMTP_PASSWORD', smtpPassword],
    ['TELECOM_HD_MAIL_FROM', mailFrom],
    ['TELECOM_HD_FIELD_ENCRYPTION_KEY', fieldEncryptionKey],
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
  ]) {
    target = setEnv(target, key, value);
  }

  replaceOwnerOnlyEnv(targetPath, target);
  process.stdout.write(
    'Local SMTP test configuration prepared with encrypted queue-credential support; inbound and outbound delivery remain disabled.\n',
  );
} catch (error) {
  // Do not interpolate file contents, command arguments or provider errors: all could contain a secret.
  process.stderr.write(`Local mail-test provisioning stopped: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
}
