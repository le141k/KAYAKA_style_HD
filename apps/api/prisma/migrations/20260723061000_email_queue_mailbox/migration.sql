-- Each IMAP queue owns a selected folder, not an implicit shared INBOX. The default keeps
-- every existing queue on its legacy behavior. Deliberately do NOT use IF NOT EXISTS here:
-- an untracked partial column would violate Prisma's required/default contract and must stop
-- rollout for an explicit repair rather than silently leaving acceptance CAS predicates inert.
-- Runtime and DTO code use the same explicit ASCII edge set as this CHECK
-- (`space, tab, LF, CR, FF, VT`) and the same Unicode-code-point limit.  Do not use
-- PostgreSQL's default btrim or JavaScript String.trim(): their Unicode whitespace
-- definitions differ and can make the poller select a different folder from the
-- stored one.
ALTER TABLE "EmailQueue"
  ADD COLUMN "mailbox" TEXT NOT NULL DEFAULT 'INBOX';

ALTER TABLE "EmailQueue"
  ADD CONSTRAINT "EmailQueue_mailbox_valid"
  CHECK (
    "mailbox" = btrim("mailbox", E' \t\n\r\f\x0B')
    AND char_length("mailbox") BETWEEN 1 AND 255
    AND "mailbox" !~ E'[\\r\\n]'
  ) NOT VALID;

ALTER TABLE "EmailQueue"
  VALIDATE CONSTRAINT "EmailQueue_mailbox_valid";
