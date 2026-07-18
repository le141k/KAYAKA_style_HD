/**
 * Read-only production identity/session go-live audit.
 *
 * Run on the VM with a read-only DATABASE_URL. Output is aggregate-only: it never
 * prints staff identities, hashes, tokens, or customer data.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { verifyPassword } from '../auth/password.util';

const prisma = new PrismaClient();

// Every password deliberately shipped by a seed/example, plus the weak values
// rejected by bootstrap-admin. Check hashes, not just known demo addresses.
const SHIPPED_OR_DEFAULT_PASSWORDS = ['demo1234', 'password', 'admin', 'changeme', 'change-me'] as const;

const DEMO_EMAILS = [
  'admin@23telecom.example',
  'manager@23telecom.example',
  'agent@23telecom.example',
] as const;

type CountRow = { count: bigint | number };

export interface ProductionReadinessAudit {
  inventory: {
    enabledStaff: number;
    enabledAdmins: number;
    activeRefreshTokens: number;
    unusedPasswordResets: number;
    activeClientLoginTokens: number;
    activeClientSessions: number;
  };
  blockers: {
    enabledDemoIdentities: number;
    enabledDefaultPasswordHashes: number;
    malformedEnabledPasswordHashes: number;
    invalidActiveRefreshTokens: number;
    invalidUnusedPasswordResets: number;
    duplicateUnusedPasswordResetOwners: number;
    invalidActiveClientLoginTokens: number;
    duplicateActiveClientLoginTokenOwners: number;
    invalidActiveClientSessions: number;
    missingEnabledAdministrator: number;
  };
  clean: boolean;
}

const numberFrom = (value: bigint | number | undefined): number => Number(value ?? 0);

async function countDefaultPasswords(hashes: string[]): Promise<number> {
  let matches = 0;
  for (const hash of hashes) {
    for (const candidate of SHIPPED_OR_DEFAULT_PASSWORDS) {
      if (await verifyPassword(hash, candidate)) {
        matches += 1;
        break;
      }
    }
  }
  return matches;
}

export async function auditProductionReadiness(db: PrismaClient = prisma): Promise<ProductionReadinessAudit> {
  const now = new Date();
  const enabledStaffRows = await db.staff.findMany({
    where: { isEnabled: true },
    select: {
      email: true,
      passwordHash: true,
      staffGroup: { select: { isAdmin: true } },
    },
  });

  const enabledAdmins = enabledStaffRows.filter((staff) => staff.staffGroup.isAdmin).length;
  const enabledDemoIdentities = enabledStaffRows.filter((staff) =>
    DEMO_EMAILS.includes(staff.email.trim().toLowerCase() as (typeof DEMO_EMAILS)[number]),
  ).length;
  const malformedEnabledPasswordHashes = enabledStaffRows.filter(
    (staff) => !staff.passwordHash.startsWith('$argon2id$'),
  ).length;
  const enabledDefaultPasswordHashes = await countDefaultPasswords(
    enabledStaffRows.map((staff) => staff.passwordHash),
  );

  const [
    activeRefreshTokens,
    invalidActiveRefreshTokens,
    unusedPasswordResets,
    invalidUnusedPasswordResets,
    duplicateUnusedPasswordResetOwners,
    activeClientLoginTokens,
    invalidActiveClientLoginTokens,
    duplicateActiveClientLoginTokenOwners,
    activeClientSessions,
    invalidActiveClientSessions,
  ] = await Promise.all([
    db.refreshToken.count({ where: { revokedAt: null, expiresAt: { gt: now } } }),
    db.$queryRaw<CountRow[]>(Prisma.sql`
      SELECT count(*) AS count
      FROM "RefreshToken" r
      LEFT JOIN "Staff" s ON s."id" = r."staffId"
      WHERE r."revokedAt" IS NULL AND r."expiresAt" > now()
        AND (s."id" IS NULL OR NOT s."isEnabled" OR r."authVersion" <> s."authVersion")
    `),
    db.passwordReset.count({ where: { usedAt: null, expiresAt: { gt: now } } }),
    db.$queryRaw<CountRow[]>(Prisma.sql`
      SELECT count(*) AS count
      FROM "PasswordReset" p
      LEFT JOIN "Staff" s ON s."id" = p."staffId"
      WHERE p."usedAt" IS NULL AND p."expiresAt" > now()
        AND (s."id" IS NULL OR NOT s."isEnabled" OR p."authVersion" <> s."authVersion")
    `),
    db.$queryRaw<CountRow[]>(Prisma.sql`
      SELECT count(*) AS count
      FROM (
        SELECT "staffId"
        FROM "PasswordReset"
        WHERE "usedAt" IS NULL AND "expiresAt" > now()
        GROUP BY "staffId"
        HAVING count(*) > 1
      ) duplicate_owners
    `),
    db.clientLoginToken.count({ where: { usedAt: null, expiresAt: { gt: now } } }),
    db.$queryRaw<CountRow[]>(Prisma.sql`
      SELECT count(*) AS count
      FROM "ClientLoginToken" t
      LEFT JOIN "User" u ON u."id" = t."userId"
      WHERE t."usedAt" IS NULL AND t."expiresAt" > now()
        AND (u."id" IS NULL OR NOT u."isEnabled" OR t."clientAuthVersion" <> u."clientAuthVersion")
    `),
    db.$queryRaw<CountRow[]>(Prisma.sql`
      SELECT count(*) AS count
      FROM (
        SELECT "userId"
        FROM "ClientLoginToken"
        WHERE "usedAt" IS NULL AND "expiresAt" > now()
        GROUP BY "userId"
        HAVING count(*) > 1
      ) duplicate_owners
    `),
    db.clientSession.count({ where: { revokedAt: null, expiresAt: { gt: now } } }),
    db.$queryRaw<CountRow[]>(Prisma.sql`
      SELECT count(*) AS count
      FROM "ClientSession" c
      LEFT JOIN "User" u ON u."id" = c."userId"
      WHERE c."revokedAt" IS NULL AND c."expiresAt" > now()
        AND (u."id" IS NULL OR NOT u."isEnabled" OR c."clientAuthVersion" <> u."clientAuthVersion")
    `),
  ]);

  const inventory = {
    enabledStaff: enabledStaffRows.length,
    enabledAdmins,
    activeRefreshTokens,
    unusedPasswordResets,
    activeClientLoginTokens,
    activeClientSessions,
  };
  const blockers = {
    enabledDemoIdentities,
    enabledDefaultPasswordHashes,
    malformedEnabledPasswordHashes,
    invalidActiveRefreshTokens: numberFrom(invalidActiveRefreshTokens[0]?.count),
    invalidUnusedPasswordResets: numberFrom(invalidUnusedPasswordResets[0]?.count),
    duplicateUnusedPasswordResetOwners: numberFrom(duplicateUnusedPasswordResetOwners[0]?.count),
    invalidActiveClientLoginTokens: numberFrom(invalidActiveClientLoginTokens[0]?.count),
    duplicateActiveClientLoginTokenOwners: numberFrom(duplicateActiveClientLoginTokenOwners[0]?.count),
    invalidActiveClientSessions: numberFrom(invalidActiveClientSessions[0]?.count),
    missingEnabledAdministrator: enabledAdmins > 0 ? 0 : 1,
  };

  return {
    inventory,
    blockers,
    clean: Object.values(blockers).every((count) => count === 0),
  };
}

function printReport(audit: ProductionReadinessAudit): void {
  console.log('=== Production identity/session readiness audit (aggregate only) ===');
  console.log(JSON.stringify(audit, null, 2));
  console.log(audit.clean ? 'CLEAN — identity/session go-live gate passed.' : 'NOT CLEAN — blockers remain.');
}

if (require.main === module) {
  auditProductionReadiness()
    .then((audit) => {
      printReport(audit);
      if (!audit.clean) process.exitCode = 1;
    })
    .catch(() => {
      console.error('Production readiness audit failed; no row data was printed.');
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
