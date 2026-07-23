import assert from 'node:assert/strict';
import test from 'node:test';
import { imapTaggedStatusPattern, smtpReplyPattern } from './local-mail-protocol.util.mjs';

test('IMAP tagged matcher consumes untagged EXAMINE output before the completion line', () => {
  const response =
    '* FLAGS (\\Seen \\Answered)\r\n* 1 EXISTS\r\n* OK [UIDVALIDITY 77] UIDs valid\r\na2 OK [READ-ONLY] EXAMINE completed\r\n';
  const match = imapTaggedStatusPattern('a2').exec(response);

  assert.ok(match);
  assert.equal(match[1], 'OK');
  // `makeReader()` consumes bytes through match.index + match[0].length, including
  // the preceding untagged EXAMINE lines.
  assert.equal(match.index + match[0].length, response.length);
});

test('SMTP matcher waits for the final line of a multi-line capability response', () => {
  const response = '250-mail.example.test\r\n250-SIZE 35882577\r\n250-STARTTLS\r\n250 AUTH PLAIN LOGIN\r\n';
  assert.equal(smtpReplyPattern('250').exec(response)?.[0], response);
  assert.equal(smtpReplyPattern('250').exec('250-STARTTLS\r\n'), null);
});
