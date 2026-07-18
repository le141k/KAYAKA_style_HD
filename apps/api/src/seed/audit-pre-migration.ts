/**
 * Read-only checks that must pass against the current production schema before
 * migrations are allowed to start. Output is aggregate-only.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const REQUIRED_TEMPLATES = [
  { key: 'password_reset', locale: 'en', placeholder: '{{resetUrl}}' },
  { key: 'client_login_link', locale: 'en', placeholder: '{{verifyUrl}}' },
] as const;

export interface PreMigrationAudit {
  existingTemplates: number;
  templatesProvisionedByMigration: number;
  invalidExistingTemplates: number;
  duplicateMessageIdGroups: number;
  clean: boolean;
}

export async function auditPreMigration(db: PrismaClient = prisma): Promise<PreMigrationAudit> {
  let existingTemplates = 0;
  let templatesProvisionedByMigration = 0;
  let invalidExistingTemplates = 0;

  for (const requirement of REQUIRED_TEMPLATES) {
    const template = await db.emailTemplate.findUnique({
      where: { key_locale: { key: requirement.key, locale: requirement.locale } },
      select: { htmlBody: true, textBody: true },
    });
    if (!template) {
      templatesProvisionedByMigration += 1;
      continue;
    }
    existingTemplates += 1;
    if (
      !template.htmlBody.includes(requirement.placeholder) ||
      !template.textBody.includes(requirement.placeholder)
    ) {
      invalidExistingTemplates += 1;
    }
  }

  const [messageIdAudit] = await db.$queryRaw<Array<{ duplicateGroups: number }>>`
    SELECT COUNT(*)::integer AS "duplicateGroups"
    FROM (
      SELECT BTRIM("messageId")
      FROM "TicketPost"
      WHERE NULLIF(BTRIM("messageId"), '') IS NOT NULL
      GROUP BY BTRIM("messageId")
      HAVING COUNT(*) > 1
    ) AS duplicate_message_ids
  `;
  const duplicateMessageIdGroups = messageIdAudit?.duplicateGroups ?? 0;

  return {
    existingTemplates,
    templatesProvisionedByMigration,
    invalidExistingTemplates,
    duplicateMessageIdGroups,
    clean: invalidExistingTemplates === 0 && duplicateMessageIdGroups === 0,
  };
}

if (require.main === module) {
  auditPreMigration()
    .then((audit) => {
      console.log('=== Pre-migration template audit (aggregate only) ===');
      console.log(JSON.stringify(audit, null, 2));
      console.log(
        audit.clean ? 'CLEAN — pre-migration template gate passed.' : 'NOT CLEAN — blockers remain.',
      );
      if (!audit.clean) process.exitCode = 1;
    })
    .catch(() => {
      console.error('Pre-migration audit failed; no row data was printed.');
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
