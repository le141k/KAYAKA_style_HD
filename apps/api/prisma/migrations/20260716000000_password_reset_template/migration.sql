-- GOAL_PUBLIC_SECURITY S1-4: provision the `password_reset` email template in every
-- environment. The production seed does not run, so without this row the reset flow
-- rendered the empty JSON fallback (and, combined with the mail-DI bug, logged the raw
-- reset URL instead of emailing it). Idempotent upsert — safe on already-seeded dev DBs
-- and safe to re-run.
INSERT INTO "EmailTemplate" ("key", "locale", "subject", "htmlBody", "textBody", "updatedAt")
VALUES (
  'password_reset',
  'en',
  'Reset your 23 Telecom Help Desk password',
  '<p>Hi {{firstName}},</p>'
    || '<p>We received a request to reset the password for your 23 Telecom Help Desk account. '
    || 'Choose a new password using the link below:</p>'
    || '<p><a href="{{resetUrl}}">Reset your password</a></p>'
    || '<p>This link expires in {{expiresInHours}} hour(s). '
    || 'If you did not request a password reset, you can safely ignore this email — '
    || 'your password will not change.</p>',
  E'Hi {{firstName}},\n\n'
    || E'We received a request to reset the password for your 23 Telecom Help Desk account.\n'
    || E'Choose a new password using the link below:\n\n'
    || E'{{resetUrl}}\n\n'
    || E'This link expires in {{expiresInHours}} hour(s). If you did not request a password\n'
    || E'reset, you can safely ignore this email — your password will not change.',
  now()
)
ON CONFLICT ("key", "locale") DO UPDATE
  SET "subject"  = EXCLUDED."subject",
      "htmlBody" = EXCLUDED."htmlBody",
      "textBody" = EXCLUDED."textBody",
      "updatedAt" = now();
