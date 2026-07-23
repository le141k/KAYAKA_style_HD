/**
 * Small protocol matchers used by the attended, read-only mail credential verifier.
 * Kept pure so protocol edge cases can be checked without live credentials or sockets.
 */

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * IMAP commands regularly emit untagged data before their tagged completion response
 * (EXAMINE commonly reports FLAGS/EXISTS/UIDVALIDITY). The verifier's reader consumes
 * everything through the matching tagged line, so a later command cannot match stale output.
 */
export function imapTaggedStatusPattern(tag) {
  if (!/^[A-Za-z0-9]+$/u.test(tag)) throw new Error('IMAP verifier tag is invalid');
  return new RegExp(`(?:^|\\r?\\n)${escapeRegex(tag)} (OK|NO|BAD)[^\\r\\n]*\\r?\\n`, 'u');
}

/**
 * SMTP replies may have continuation lines (`250-...`) before the final `250 ...`.
 * The verifier must not proceed after only the first capability line.
 */
export function smtpReplyPattern(code) {
  if (!/^\d{3}$/u.test(code)) throw new Error('SMTP verifier response code is invalid');
  return new RegExp(`^${code}(?:-[^\\r\\n]*\\r?\\n${code})* [^\\r\\n]*\\r?\\n`, 'u');
}
