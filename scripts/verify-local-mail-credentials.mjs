#!/usr/bin/env node
/**
 * Attended, read-only verification of test IMAP and SMTP credentials.
 *
 * This tool authenticates and opens the configured IMAP folder read-only, then
 * authenticates SMTP over TLS and quits. It never submits MAIL FROM, RCPT TO or
 * DATA; it never FETCHes, STOREs, EXPUNGEs or otherwise changes a mailbox. Values
 * are read from an owner-only sidecar outside the repository and are never printed.
 */
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import net from 'node:net';
import { resolve } from 'node:path';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';
import { imapTaggedStatusPattern, smtpReplyPattern } from './local-mail-protocol.util.mjs';

const MAX_PROTOCOL_BUFFER_BYTES = 128 * 1024;
const PROTOCOL_TIMEOUT_MS = 15_000;

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
    if (entries.has(key)) throw new Error(`Credential file defines ${key} more than once`);
    entries.set(key, value);
  }
  return entries;
}

function requireSafeValue(entries, key, { allowSpaces = false } = {}) {
  const value = entries.get(key)?.trim();
  if (!value) throw new Error(`Credential file is missing ${key}`);
  if (!/^[ -~]+$/u.test(value) || (!allowSpaces && /\s/u.test(value))) {
    throw new Error(`Credential file has an unsafe ${key}`);
  }
  return value;
}

function requirePort(entries, key) {
  const value = requireSafeValue(entries, key);
  if (!/^\d{1,5}$/u.test(value) || Number(value) < 1 || Number(value) > 65_535) {
    throw new Error(`Credential file has an invalid ${key}`);
  }
  return Number(value);
}

function requireBoolean(entries, key) {
  const value = requireSafeValue(entries, key).toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Credential file has an invalid ${key}`);
}

function readOwnerOnlyCredentials(sourcePath) {
  const link = lstatSync(sourcePath);
  if (link.isSymbolicLink() || !link.isFile()) {
    throw new Error('Credential file must be a regular non-symlink file');
  }
  const stat = statSync(sourcePath);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error('Credential file permissions must be owner-only (chmod 600)');
  }
  return parseEnv(readFileSync(sourcePath, 'utf8'));
}

function makeReader(socket) {
  let buffer = '';
  const waiters = [];
  const rejectWaiters = (error) => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
  };
  const flush = () => {
    for (let index = 0; index < waiters.length; index += 1) {
      const waiter = waiters[index];
      const match = waiter.pattern.exec(buffer);
      if (!match) continue;
      buffer = buffer.slice(match.index + match[0].length);
      waiters.splice(index, 1);
      index -= 1;
      clearTimeout(waiter.timeout);
      waiter.resolve(match);
    }
  };

  const onData = (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer, 'utf8') > MAX_PROTOCOL_BUFFER_BYTES) {
      rejectWaiters(new Error('Mail server response exceeded the safe verifier limit'));
      socket.destroy();
      return;
    }
    flush();
  };
  const onError = (error) => rejectWaiters(error);
  const onClose = () => rejectWaiters(new Error('Mail server closed the connection'));
  socket.setEncoding('utf8');
  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', onClose);

  return {
    wait(pattern, label) {
      return new Promise((resolve, reject) => {
        const match = pattern.exec(buffer);
        if (match) {
          buffer = buffer.slice(match.index + match[0].length);
          resolve(match);
          return;
        }
        const timeout = setTimeout(() => {
          const error = new Error(`${label} timed out`);
          reject(error);
          socket.destroy(error);
        }, PROTOCOL_TIMEOUT_MS);
        waiters.push({ pattern, resolve, reject, timeout });
      });
    },
    // STARTTLS wraps the same underlying TCP socket in a new TLSSocket. Remove the
    // plaintext reader first so it can never consume encrypted TLS records or retain
    // a stale response buffer after the protocol boundary.
    dispose() {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      for (const waiter of waiters.splice(0)) clearTimeout(waiter.timeout);
      buffer = '';
    },
  };
}

/** Bound the TCP/TLS handshake itself, not only later protocol replies. */
export function waitForSocketEvent(socket, successEvent, label, timeoutMs = PROTOCOL_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off(successEvent, onSuccess);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const settle = (callback, value, destroy = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (destroy) socket.destroy();
      callback(value);
    };
    const onSuccess = () => settle(resolve, socket);
    const onError = (error) => settle(reject, error, true);
    const onClose = () => settle(reject, new Error(`${label} closed before it completed`));
    const timeout = setTimeout(
      () => settle(reject, new Error(`${label} timed out`), true),
      timeoutMs,
    );
    socket.once(successEvent, onSuccess);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

function connectPlain(host, port) {
  const socket = net.connect({ host, port });
  return waitForSocketEvent(socket, 'connect', 'SMTP TCP connection');
}

function connectTls(host, port) {
  const socket = tls.connect({ host, port, servername: host, minVersion: 'TLSv1.2' });
  return waitForSocketEvent(socket, 'secureConnect', 'mail TLS handshake');
}

function upgradeStartTls(socket, host) {
  const secured = tls.connect({ socket, servername: host, minVersion: 'TLSv1.2' });
  return waitForSocketEvent(secured, 'secureConnect', 'SMTP STARTTLS handshake');
}

function write(socket, line) {
  socket.write(`${line}\r\n`);
}

function imapQuote(value) {
  return `"${value.replace(/[\\"]/gu, '\\$&')}"`;
}

async function waitForImapStatus(reader, tag, label) {
  const match = await reader.wait(imapTaggedStatusPattern(tag), label);
  if (match[1] !== 'OK') throw new Error(`${label} was rejected by the mail provider`);
}

export async function verifyImap(
  entries,
  { openTls = connectTls, output = process.stdout } = {},
) {
  const host = requireSafeValue(entries, 'TEST_IMAP_HOST');
  const port = requirePort(entries, 'TEST_IMAP_PORT');
  const username = requireSafeValue(entries, 'TEST_IMAP_USERNAME');
  const password = requireSafeValue(entries, 'TEST_IMAP_PASSWORD', { allowSpaces: true });
  const mailbox = requireSafeValue(entries, 'TEST_IMAP_MAILBOX', { allowSpaces: true });
  if (!requireBoolean(entries, 'TEST_IMAP_USE_TLS')) {
    throw new Error('TEST_IMAP_USE_TLS must be true for this read-only verifier');
  }

  const socket = await openTls(host, port);
  const reader = makeReader(socket);
  try {
    await reader.wait(/^\* (?:OK|PREAUTH)[^\r\n]*\r?\n/u, 'IMAP greeting');
    write(socket, `a1 LOGIN ${imapQuote(username)} ${imapQuote(password)}`);
    await waitForImapStatus(reader, 'a1', 'IMAP authentication');
    // EXAMINE is read-only and does not mark a message as seen.
    write(socket, `a2 EXAMINE ${imapQuote(mailbox)}`);
    await waitForImapStatus(reader, 'a2', 'IMAP read-only folder access');
    write(socket, 'a3 LOGOUT');
    await waitForImapStatus(reader, 'a3', 'IMAP logout').catch(() => undefined);
    output.write('IMAP: authenticated and opened the selected folder read-only — OK\n');
  } finally {
    reader.dispose();
    socket.destroy();
  }
}

async function smtpEhlo(socket, reader) {
  write(socket, 'EHLO 23telecom-local-test');
  await reader.wait(smtpReplyPattern('250'), 'SMTP EHLO');
}

export async function verifySmtp(
  entries,
  { openPlain = connectPlain, openTls = connectTls, startTls = upgradeStartTls, output = process.stdout } = {},
) {
  const host = requireSafeValue(entries, 'TELECOM_HD_SMTP_HOST');
  const port = requirePort(entries, 'TELECOM_HD_SMTP_PORT');
  const secure = requireBoolean(entries, 'TELECOM_HD_SMTP_SECURE');
  const username = requireSafeValue(entries, 'TELECOM_HD_SMTP_USER');
  const password = requireSafeValue(entries, 'TELECOM_HD_SMTP_PASSWORD', { allowSpaces: true });
  let socket = secure ? await openTls(host, port) : await openPlain(host, port);
  let reader = makeReader(socket);
  try {
    await reader.wait(smtpReplyPattern('220'), 'SMTP greeting');
    await smtpEhlo(socket, reader);
    if (!secure) {
      write(socket, 'STARTTLS');
      await reader.wait(smtpReplyPattern('220'), 'SMTP STARTTLS');
      reader.dispose();
      socket = await startTls(socket, host);
      reader = makeReader(socket);
      await smtpEhlo(socket, reader);
    }
    const token = Buffer.from(`\u0000${username}\u0000${password}`, 'utf8').toString('base64');
    write(socket, `AUTH PLAIN ${token}`);
    await reader.wait(smtpReplyPattern('235'), 'SMTP authentication');
    // Deliberately stop here: no envelope and no message are submitted.
    write(socket, 'QUIT');
    await reader.wait(smtpReplyPattern('221'), 'SMTP logout').catch(() => undefined);
    output.write(`SMTP: authenticated over ${secure ? 'TLS' : 'STARTTLS'}; no message submitted — OK\n`);
  } finally {
    reader.dispose();
    socket.destroy();
  }
}

function safeFailure(error) {
  const message = error instanceof Error ? error.message : '';
  if (
    /^(Credential file (is missing|must)|Credential file (defines|has)|TEST_IMAP_USE_TLS)/u.test(message)
  ) {
    return message;
  }
  return 'network, TLS, selected-folder, or authentication check did not complete';
}

function sourcePathFromArgs(args) {
  const sourceIndex = args.indexOf('--source');
  if (
    (sourceIndex !== -1 && (!args[sourceIndex + 1] || args[sourceIndex + 1].startsWith('--'))) ||
    args.some((arg, index) => arg.startsWith('--') && (arg !== '--source' || index !== sourceIndex)) ||
    (sourceIndex !== -1 && args.length !== 2) ||
    (sourceIndex === -1 && args.length !== 0)
  ) {
    return null;
  }
  return resolve(args[sourceIndex + 1] ?? resolve(homedir(), '.config/23telecom-helpdesk/inbound-test.env'));
}

export async function main(args = process.argv.slice(2)) {
  const sourcePath = sourcePathFromArgs(args);
  if (sourcePath === null) {
    process.stderr.write('Usage: node scripts/verify-local-mail-credentials.mjs [--source path/to/inbound-test.env]\n');
    return 2;
  }

  let entries;
  try {
    entries = readOwnerOnlyCredentials(sourcePath);
  } catch (error) {
    process.stderr.write(`Credential verification stopped: ${safeFailure(error)}\n`);
    return 1;
  }

  const checks = await Promise.allSettled([verifyImap(entries), verifySmtp(entries)]);
  let exitCode = 0;
  for (const [name, check] of ['IMAP', 'SMTP'].map((name, index) => [name, checks[index]])) {
    if (check.status === 'rejected') {
      process.stderr.write(`${name}: credential test failed safely — ${safeFailure(check.reason)}\n`);
      exitCode = 1;
    }
  }
  return exitCode;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) process.exitCode = await main();
