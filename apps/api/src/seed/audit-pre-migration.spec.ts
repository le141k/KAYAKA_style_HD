import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { auditPreMigration } from './audit-pre-migration';

describe('auditPreMigration', () => {
  it('allows absent templates because the migrations provision them', async () => {
    const db = {
      emailTemplate: { findUnique: vi.fn().mockResolvedValue(null) },
      $queryRaw: vi.fn().mockResolvedValue([{ duplicateGroups: 0 }]),
    } as unknown as PrismaClient;

    await expect(auditPreMigration(db)).resolves.toEqual({
      existingTemplates: 0,
      templatesProvisionedByMigration: 2,
      invalidExistingTemplates: 0,
      duplicateMessageIdGroups: 0,
      clean: true,
    });
  });

  it('fails when an existing customized template lost its security-link placeholder', async () => {
    const db = {
      emailTemplate: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({ htmlBody: '<p>No reset link</p>', textBody: 'No reset link' })
          .mockResolvedValueOnce({
            htmlBody: '<a href="{{verifyUrl}}">Sign in</a>',
            textBody: '{{verifyUrl}}',
          }),
      },
      $queryRaw: vi.fn().mockResolvedValue([{ duplicateGroups: 0 }]),
    } as unknown as PrismaClient;

    await expect(auditPreMigration(db)).resolves.toEqual({
      existingTemplates: 2,
      templatesProvisionedByMigration: 0,
      invalidExistingTemplates: 1,
      duplicateMessageIdGroups: 0,
      clean: false,
    });
  });

  it('fails before migration when trimming would collide inbound Message-IDs', async () => {
    const db = {
      emailTemplate: { findUnique: vi.fn().mockResolvedValue(null) },
      $queryRaw: vi.fn().mockResolvedValue([{ duplicateGroups: 2 }]),
    } as unknown as PrismaClient;

    await expect(auditPreMigration(db)).resolves.toEqual({
      existingTemplates: 0,
      templatesProvisionedByMigration: 2,
      invalidExistingTemplates: 0,
      duplicateMessageIdGroups: 2,
      clean: false,
    });
  });
});
