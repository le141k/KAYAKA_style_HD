/**
 * Idempotent bootstrap-admin script for production start.
 *
 * Creates the first administrator account from environment variables.
 * Safe to run on every container start — it is fully idempotent.
 *
 * Env vars:
 *   TELECOM_HD_BOOTSTRAP_ADMIN_EMAIL     — e.g. ops@example.com
 *   TELECOM_HD_BOOTSTRAP_ADMIN_PASSWORD  — strong password (never demo1234)
 *
 * Behaviour:
 *   - Missing env vars   → log + exit 0 (no-op, does NOT crash boot).
 *   - Admin StaffGroup   → create if absent; leave unchanged if present.
 *   - Staff record       → create if email absent; leave unchanged if present
 *                          (password is NEVER reset on subsequent boots).
 */

import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../auth/password.util';
import { ROLE_PRESETS } from '../auth/permissions';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const email = process.env.TELECOM_HD_BOOTSTRAP_ADMIN_EMAIL?.trim();
  const password = process.env.TELECOM_HD_BOOTSTRAP_ADMIN_PASSWORD?.trim();

  if (!email || !password) {
    console.log(
      '[bootstrap-admin] TELECOM_HD_BOOTSTRAP_ADMIN_EMAIL or TELECOM_HD_BOOTSTRAP_ADMIN_PASSWORD ' +
        'not set — skipping bootstrap admin creation.',
    );
    return;
  }

  console.log(`[bootstrap-admin] Ensuring admin StaffGroup and staff account for <${email}>…`);

  // ── 1. Ensure the admin StaffGroup exists ──────────────────────────────────
  //
  // We look for the first group with isAdmin=true and title 'Administrator'.
  // If absent, we create it. We do NOT update an existing group's permissions
  // so that manual tweaks made in the UI are preserved.

  let adminGroup = await prisma.staffGroup.findFirst({
    where: { title: 'Administrator', isAdmin: true },
  });

  if (!adminGroup) {
    adminGroup = await prisma.staffGroup.create({
      data: {
        title: 'Administrator',
        isAdmin: true,
        permissions: ROLE_PRESETS.administrator,
      },
    });
    console.log(`[bootstrap-admin] Created StaffGroup "Administrator" (id=${adminGroup.id}).`);
  } else {
    console.log(`[bootstrap-admin] StaffGroup "Administrator" already exists (id=${adminGroup.id}).`);
  }

  // ── 2. Ensure the staff account exists ────────────────────────────────────
  //
  // If the email is already registered we leave the record untouched — in
  // particular we do NOT reset the password, so operator-changed credentials
  // survive a redeploy.

  const existing = await prisma.staff.findUnique({ where: { email } });

  if (existing) {
    console.log(`[bootstrap-admin] Staff <${email}> already exists (id=${existing.id}) — no changes made.`);
    return;
  }

  // Derive a safe username from the local part of the email address,
  // replacing non-alphanumeric characters so it passes DB constraints.
  const baseUsername = (email.split('@')[0] ?? email)
    .replace(/[^a-z0-9_]/gi, '_')
    .toLowerCase()
    .slice(0, 30);

  // If that username is already taken, append a short timestamp suffix.
  const usernameExists = await prisma.staff.findUnique({ where: { username: baseUsername } });
  const username = usernameExists ? `${baseUsername}_${Date.now().toString(36)}` : baseUsername;

  const passwordHash = await hashPassword(password);

  const staff = await prisma.staff.create({
    data: {
      email,
      username,
      firstName: 'Admin',
      lastName: '',
      passwordHash,
      designation: 'System Administrator',
      staffGroupId: adminGroup.id,
    },
  });

  console.log(
    `[bootstrap-admin] Created staff account <${staff.email}> (id=${staff.id}, ` +
      `username="${staff.username}") in StaffGroup id=${adminGroup.id}.`,
  );
}

main()
  .catch((err: unknown) => {
    console.error('[bootstrap-admin] Fatal error:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
