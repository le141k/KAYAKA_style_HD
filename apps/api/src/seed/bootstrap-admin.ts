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
 *   - Built-in StaffGroups → always ensured before considering bootstrap credentials.
 *   - Missing env vars   → skip account creation without crashing boot.
 *   - Staff record       → create if email absent; leave unchanged if present
 *                          (password is NEVER reset on subsequent boots).
 */

import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../auth/password.util';
import { ROLE_PRESETS, ROLE_TEMPLATES } from '../auth/permissions';

const prisma = new PrismaClient();

type BootstrapDb = Pick<PrismaClient, 'staff' | 'staffGroup'>;

// Serializes idempotent role seeding across simultaneous API container starts.
const BOOTSTRAP_LOCK_KEY = 23_202_608;

/**
 * Ensure the three built-in role groups (Administrator, Manager, Agent) exist.
 * Production-safe: creates only missing groups from the role templates and NEVER
 * overwrites the permissions of a group that already exists — operator tweaks
 * survive redeploys. Returns the Administrator group (needed for the bootstrap
 * staff account).
 */
export async function ensureStandardGroups(db: BootstrapDb = prisma): Promise<{ id: number }> {
  let adminGroup: { id: number } | null = null;
  for (const tpl of ROLE_TEMPLATES) {
    // Titles are not unique in the live schema. Matching the expected admin flag
    // prevents a stray non-admin group named "Administrator" from becoming the
    // bootstrap account's role.
    const existing = await db.staffGroup.findFirst({ where: { title: tpl.title, isAdmin: tpl.isAdmin } });
    if (existing) {
      console.log(`[bootstrap-admin] StaffGroup "${tpl.title}" already exists (id=${existing.id}).`);
      if (tpl.key === 'administrator') adminGroup = existing;
      continue;
    }
    const created = await db.staffGroup.create({
      data: { title: tpl.title, isAdmin: tpl.isAdmin, permissions: tpl.permissions },
    });
    console.log(`[bootstrap-admin] Created StaffGroup "${tpl.title}" (id=${created.id}).`);
    if (tpl.key === 'administrator') adminGroup = created;
  }

  // Defensive: if for some reason an admin group with the template title is
  // missing (e.g. renamed manually), fall back to any isAdmin group / create one.
  if (!adminGroup) {
    adminGroup =
      (await db.staffGroup.findFirst({ where: { isAdmin: true } })) ??
      (await db.staffGroup.create({
        data: { title: 'Administrator', isAdmin: true, permissions: ROLE_PRESETS.administrator },
      }));
  }
  return adminGroup;
}

export async function bootstrapAdmin(
  env: NodeJS.ProcessEnv = process.env,
  db: BootstrapDb = prisma,
): Promise<void> {
  // Standard roles must exist even on a pre-existing deployment where no
  // bootstrap credentials are configured (or are intentionally removed later).
  const adminGroup = await ensureStandardGroups(db);

  const email = env.TELECOM_HD_BOOTSTRAP_ADMIN_EMAIL?.trim();
  const password = env.TELECOM_HD_BOOTSTRAP_ADMIN_PASSWORD?.trim();

  if (!email || !password) {
    console.log(
      '[bootstrap-admin] TELECOM_HD_BOOTSTRAP_ADMIN_EMAIL or TELECOM_HD_BOOTSTRAP_ADMIN_PASSWORD ' +
        'not set — skipping bootstrap admin creation.',
    );
    return;
  }

  // Guard against an unfilled .env.prod placeholder or a non-email value — never
  // create a garbage-email admin (the email column is unique, which would then
  // block creating the real admin later).
  if (email.includes('<<<') || password.includes('<<<') || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.warn(
      `[bootstrap-admin] Skipping — TELECOM_HD_BOOTSTRAP_ADMIN_EMAIL is not a valid email (got "${email}"). ` +
        'Fill the .env.prod placeholder and redeploy.',
    );
    return;
  }

  console.log(`[bootstrap-admin] Ensuring staff account for <${email}>…`);

  // ── 2. Ensure the staff account exists ────────────────────────────────────
  //
  // If the email is already registered we leave the record untouched — in
  // particular we do NOT reset the password, so operator-changed credentials
  // survive a redeploy.

  const existing = await db.staff.findUnique({ where: { email } });

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
  const usernameExists = await db.staff.findUnique({ where: { username: baseUsername } });
  const username = usernameExists ? `${baseUsername}_${Date.now().toString(36)}` : baseUsername;

  const passwordHash = await hashPassword(password);

  const staff = await db.staff.create({
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

async function main(): Promise<void> {
  await prisma.$transaction(async (db) => {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY})`;
    await bootstrapAdmin(process.env, db);
  });
}

if (require.main === module) {
  main()
    .catch((err: unknown) => {
      console.error('[bootstrap-admin] Fatal error:', err);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
