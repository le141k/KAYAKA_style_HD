-- GOAL_PUBLIC_SECURITY S2-4/S2-5: provision the `client_login_link` email template in
-- every environment (the production seed does not run). Idempotent upsert.
INSERT INTO "EmailTemplate" ("key", "locale", "subject", "htmlBody", "textBody", "updatedAt")
VALUES (
  'client_login_link',
  'en',
  'Your 23 Telecom Help Desk sign-in link',
  '<p>Hello,</p>'
    || '<p>Use the link below to sign in to the 23 Telecom Help Desk and view your tickets:</p>'
    || '<p><a href="{{verifyUrl}}">Sign in to the Help Desk</a></p>'
    || '<p>This link expires in {{expiresInMinutes}} minutes and can be used once. '
    || 'If you did not request it, you can safely ignore this email.</p>',
  E'Hello,\n\n'
    || E'Use the link below to sign in to the 23 Telecom Help Desk and view your tickets:\n\n'
    || E'{{verifyUrl}}\n\n'
    || E'This link expires in {{expiresInMinutes}} minutes and can be used once. '
    || E'If you did not request it, you can safely ignore this email.',
  now()
)
ON CONFLICT ("key", "locale") DO UPDATE
  SET "subject"  = EXCLUDED."subject",
      "htmlBody" = EXCLUDED."htmlBody",
      "textBody" = EXCLUDED."textBody",
      "updatedAt" = now();
