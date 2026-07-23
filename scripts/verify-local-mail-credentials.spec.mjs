import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { verifyImap, verifySmtp, waitForSocketEvent } from './verify-local-mail-credentials.mjs';

class FakeSocket extends EventEmitter {
  constructor(onWrite = () => {}) {
    super();
    this.onWrite = onWrite;
    this.commands = [];
    this.destroyed = false;
  }

  setEncoding() {}

  write(value) {
    const command = String(value).replace(/\r?\n$/u, '');
    this.commands.push(command);
    this.onWrite(command);
    return true;
  }

  respond(value, { later = false } = {}) {
    const emit = () => this.emit('data', value);
    if (later) setImmediate(emit);
    else queueMicrotask(emit);
  }

  destroy() {
    if (this.destroyed) return this;
    this.destroyed = true;
    queueMicrotask(() => this.emit('close'));
    return this;
  }
}

const imapEntries = new Map([
  ['TEST_IMAP_HOST', 'imap.example.test'],
  ['TEST_IMAP_PORT', '993'],
  ['TEST_IMAP_USERNAME', 'test@example.test'],
  ['TEST_IMAP_PASSWORD', 'test password'],
  ['TEST_IMAP_USE_TLS', 'true'],
  ['TEST_IMAP_MAILBOX', 'Helpdesk Test'],
]);

const smtpEntries = new Map([
  ['TELECOM_HD_SMTP_HOST', 'smtp.example.test'],
  ['TELECOM_HD_SMTP_PORT', '587'],
  ['TELECOM_HD_SMTP_SECURE', 'false'],
  ['TELECOM_HD_SMTP_USER', 'test@example.test'],
  ['TELECOM_HD_SMTP_PASSWORD', 'test password'],
]);

test('credential verifier sends only IMAP LOGIN/EXAMINE/LOGOUT and never mutates a mailbox', async () => {
  const socket = new FakeSocket((command) => {
    if (command.startsWith('a1 LOGIN ')) socket.respond('a1 OK LOGIN completed\r\n');
    if (command.startsWith('a2 EXAMINE ')) {
      socket.respond('* 0 EXISTS\r\n* OK [UIDVALIDITY 99] UIDs valid\r\na2 OK [READ-ONLY] EXAMINE completed\r\n');
    }
    if (command === 'a3 LOGOUT') socket.respond('* BYE logging out\r\na3 OK LOGOUT completed\r\n');
  });
  const output = [];

  await verifyImap(imapEntries, {
    openTls: async () => {
      socket.respond('* OK test IMAP ready\r\n', { later: true });
      return socket;
    },
    output: { write: (line) => output.push(line) },
  });

  assert.equal(socket.commands.length, 3);
  assert.match(socket.commands[0], /^a1 LOGIN /u);
  assert.match(socket.commands[1], /^a2 EXAMINE /u);
  assert.equal(socket.commands[2], 'a3 LOGOUT');
  assert.doesNotMatch(socket.commands.join('\n'), /\b(?:FETCH|STORE|EXPUNGE|APPEND|COPY|MOVE)\b/ui);
  assert.match(output.join(''), /read-only/u);
});

test('credential verifier authenticates SMTP then quits without an envelope or message', async () => {
  const plain = new FakeSocket((command) => {
    if (command.startsWith('EHLO ')) plain.respond('250-local.test\r\n250-STARTTLS\r\n250 AUTH PLAIN\r\n');
    if (command === 'STARTTLS') plain.respond('220 Ready to start TLS\r\n');
  });
  const secured = new FakeSocket((command) => {
    if (command.startsWith('EHLO ')) secured.respond('250-local.test\r\n250 AUTH PLAIN\r\n');
    if (command.startsWith('AUTH PLAIN ')) secured.respond('235 Authentication successful\r\n');
    if (command === 'QUIT') secured.respond('221 Bye\r\n');
  });
  const output = [];

  await verifySmtp(smtpEntries, {
    openPlain: async () => {
      plain.respond('220 local SMTP ready\r\n', { later: true });
      return plain;
    },
    startTls: async () => secured,
    output: { write: (line) => output.push(line) },
  });

  assert.deepEqual(plain.commands, ['EHLO 23telecom-local-test', 'STARTTLS']);
  assert.match(secured.commands[0], /^EHLO /u);
  assert.match(secured.commands[1], /^AUTH PLAIN /u);
  assert.equal(secured.commands[2], 'QUIT');
  assert.doesNotMatch([...plain.commands, ...secured.commands].join('\n'), /\b(?:MAIL FROM|RCPT TO|DATA|RSET)\b/ui);
  assert.match(output.join(''), /no message submitted/u);
});

test('credential verifier destroys a socket when its TCP/TLS handshake times out', async () => {
  const socket = new FakeSocket();
  await assert.rejects(waitForSocketEvent(socket, 'connect', 'test handshake', 5), /timed out/u);
  assert.equal(socket.destroyed, true);
});
