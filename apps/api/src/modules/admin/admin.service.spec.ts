import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminService } from './admin.service';
import type { PrismaService } from '../../prisma/prisma.service';

function makePrismaMock() {
  return {
    customFieldGroup: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    customField: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    emailTemplate: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  } as unknown as PrismaService;
}

const MOCK_GROUP = {
  id: 1,
  title: 'Ticket Fields',
  scope: 'TICKET',
  displayOrder: 1,
  fields: [],
  createdAt: new Date(),
  updatedAt: new Date(),
};

const MOCK_FIELD = {
  id: 1,
  fieldKey: 'account_number',
  label: 'Account Number',
  type: 'TEXT',
  isRequired: false,
  defaultValue: null,
  options: [],
  displayOrder: 1,
  groupId: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const MOCK_TEMPLATE = {
  id: 1,
  key: 'ticket_created',
  locale: 'en',
  subject: 'Ticket {{mask}} created',
  htmlBody: '<p>Hello {{name}}</p>',
  textBody: 'Hello {{name}}',
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('AdminService', () => {
  let service: AdminService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new AdminService(prisma as unknown as PrismaService);
  });

  // ─── Custom field groups ──────────────────────────────────────────────────────

  describe('listGroups', () => {
    it('returns all groups with their fields', async () => {
      (prisma.customFieldGroup.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([MOCK_GROUP]);
      const result = await service.listGroups();
      expect(result).toHaveLength(1);
      expect(prisma.customFieldGroup.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ include: { fields: expect.any(Object) } }),
      );
    });
  });

  describe('createGroup', () => {
    it('creates a new custom field group', async () => {
      (prisma.customFieldGroup.create as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_GROUP);
      const result = await service.createGroup({
        title: 'Ticket Fields',
        scope: 'TICKET' as any,
        displayOrder: 1,
      });
      expect(result.title).toBe('Ticket Fields');
    });
  });

  describe('updateGroup', () => {
    it('updates group when found', async () => {
      (prisma.customFieldGroup.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_GROUP);
      (prisma.customFieldGroup.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...MOCK_GROUP,
        title: 'Updated',
      });

      const result = await service.updateGroup(1, { title: 'Updated' } as any);
      expect(result.title).toBe('Updated');
    });

    it('throws NotFoundException when group not found', async () => {
      (prisma.customFieldGroup.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.updateGroup(99, { title: 'X' } as any)).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteGroup', () => {
    it('deletes group when found', async () => {
      (prisma.customFieldGroup.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_GROUP);
      (prisma.customFieldGroup.delete as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_GROUP);

      await service.deleteGroup(1);
      expect(prisma.customFieldGroup.delete).toHaveBeenCalledWith({ where: { id: 1 } });
    });

    it('throws NotFoundException when group not found', async () => {
      (prisma.customFieldGroup.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.deleteGroup(99)).rejects.toThrow(NotFoundException);
    });
  });

  // ─── Custom fields ────────────────────────────────────────────────────────────

  describe('createField', () => {
    it('creates a custom field in the group', async () => {
      (prisma.customField.create as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_FIELD);
      const result = await service.createField(1, {
        fieldKey: 'account_number',
        label: 'Account Number',
        type: 'TEXT',
        isRequired: false,
        displayOrder: 1,
      } as any);
      expect(result.fieldKey).toBe('account_number');
    });
  });

  describe('updateField', () => {
    it('updates field when found', async () => {
      (prisma.customField.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_FIELD);
      (prisma.customField.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...MOCK_FIELD,
        label: 'Updated Label',
      });

      const result = await service.updateField(1, { label: 'Updated Label' } as any);
      expect((result as any).label).toBe('Updated Label');
    });

    it('throws NotFoundException when field not found', async () => {
      (prisma.customField.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.updateField(99, {} as any)).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteField', () => {
    it('deletes field when found', async () => {
      (prisma.customField.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_FIELD);
      (prisma.customField.delete as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_FIELD);

      await service.deleteField(1);
      expect(prisma.customField.delete).toHaveBeenCalledWith({ where: { id: 1 } });
    });

    it('throws NotFoundException when field not found', async () => {
      (prisma.customField.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.deleteField(99)).rejects.toThrow(NotFoundException);
    });
  });

  // ─── validateCustomFields ─────────────────────────────────────────────────────

  describe('validateCustomFields', () => {
    it('passes validation when all required fields are present with correct types', async () => {
      (prisma.customField.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { ...MOCK_FIELD, isRequired: true, type: 'TEXT' },
      ]);

      await expect(
        service.validateCustomFields('TICKET', { account_number: 'ACC-123' }),
      ).resolves.toBeUndefined();
    });

    it('throws BadRequestException when required field is missing', async () => {
      (prisma.customField.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { ...MOCK_FIELD, isRequired: true, type: 'TEXT' },
      ]);

      await expect(service.validateCustomFields('TICKET', {})).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when required field is empty string', async () => {
      (prisma.customField.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { ...MOCK_FIELD, isRequired: true, type: 'TEXT' },
      ]);

      await expect(service.validateCustomFields('TICKET', { account_number: '' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException when required field is null', async () => {
      (prisma.customField.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { ...MOCK_FIELD, isRequired: true, type: 'TEXT' },
      ]);

      await expect(service.validateCustomFields('TICKET', { account_number: null })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException on type mismatch (CHECKBOX expects boolean)', async () => {
      (prisma.customField.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { ...MOCK_FIELD, fieldKey: 'agreed', isRequired: false, type: 'CHECKBOX' },
      ]);

      await expect(service.validateCustomFields('TICKET', { agreed: 'yes' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException on type mismatch (DATE expects date string)', async () => {
      (prisma.customField.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { ...MOCK_FIELD, fieldKey: 'due_date', isRequired: false, type: 'DATE' },
      ]);

      await expect(service.validateCustomFields('TICKET', { due_date: 'not-a-date' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('passes for DATE type with a valid date string', async () => {
      (prisma.customField.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { ...MOCK_FIELD, fieldKey: 'due_date', isRequired: false, type: 'DATE' },
      ]);

      await expect(
        service.validateCustomFields('TICKET', { due_date: '2025-12-31' }),
      ).resolves.toBeUndefined();
    });

    it('throws BadRequestException on type mismatch (NUMBER expects numeric)', async () => {
      (prisma.customField.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { ...MOCK_FIELD, fieldKey: 'amount', isRequired: false, type: 'NUMBER' },
      ]);

      await expect(service.validateCustomFields('TICKET', { amount: 'abc' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('passes for NUMBER type with a numeric string or number', async () => {
      (prisma.customField.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { ...MOCK_FIELD, fieldKey: 'amount', isRequired: false, type: 'NUMBER' },
      ]);

      await expect(service.validateCustomFields('TICKET', { amount: '42.5' })).resolves.toBeUndefined();
      await expect(service.validateCustomFields('TICKET', { amount: 7 })).resolves.toBeUndefined();
    });

    it('throws BadRequestException on type mismatch (MULTISELECT expects array)', async () => {
      (prisma.customField.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { ...MOCK_FIELD, fieldKey: 'tags', isRequired: false, type: 'MULTISELECT' },
      ]);

      await expect(service.validateCustomFields('TICKET', { tags: 'vip' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('passes for MULTISELECT type with an array', async () => {
      (prisma.customField.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { ...MOCK_FIELD, fieldKey: 'tags', isRequired: false, type: 'MULTISELECT' },
      ]);

      await expect(
        service.validateCustomFields('TICKET', { tags: ['vip', 'priority'] }),
      ).resolves.toBeUndefined();
    });

    it('passes validation when no fields are defined', async () => {
      (prisma.customField.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await expect(service.validateCustomFields('TICKET', {})).resolves.toBeUndefined();
    });

    it('skips type check when field value is null (optional field)', async () => {
      (prisma.customField.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { ...MOCK_FIELD, fieldKey: 'optional_field', isRequired: false, type: 'CHECKBOX' },
      ]);

      // null should skip type check for optional fields
      await expect(service.validateCustomFields('TICKET', { optional_field: null })).resolves.toBeUndefined();
    });
  });

  // ─── Email templates ──────────────────────────────────────────────────────────

  describe('listTemplates', () => {
    it('returns all email templates', async () => {
      (prisma.emailTemplate.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([MOCK_TEMPLATE]);
      const result = await service.listTemplates();
      expect(result).toHaveLength(1);
    });
  });

  describe('createTemplate', () => {
    it('creates a new email template', async () => {
      (prisma.emailTemplate.create as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_TEMPLATE);
      const result = await service.createTemplate({
        key: 'ticket_created',
        locale: 'en',
        subject: 'Ticket {{mask}} created',
        htmlBody: '<p>Hello {{name}}</p>',
        textBody: 'Hello {{name}}',
      } as any);
      expect(result.key).toBe('ticket_created');
    });
  });

  describe('updateTemplate', () => {
    it('updates template when found', async () => {
      (prisma.emailTemplate.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_TEMPLATE);
      (prisma.emailTemplate.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...MOCK_TEMPLATE,
        subject: 'Updated',
      });

      const result = await service.updateTemplate(1, { subject: 'Updated' } as any);
      expect(result.subject).toBe('Updated');
    });

    it('throws NotFoundException when template not found', async () => {
      (prisma.emailTemplate.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.updateTemplate(99, {} as any)).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteTemplate', () => {
    it('deletes template when found', async () => {
      (prisma.emailTemplate.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_TEMPLATE);
      (prisma.emailTemplate.delete as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_TEMPLATE);

      await service.deleteTemplate(1);
      expect(prisma.emailTemplate.delete).toHaveBeenCalledWith({ where: { id: 1 } });
    });

    it('throws NotFoundException when template not found', async () => {
      (prisma.emailTemplate.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.deleteTemplate(99)).rejects.toThrow(NotFoundException);
    });
  });

  // ─── encrypt / decrypt custom fields ──────────────────────────────────────────

  describe('encryptCustomFields / decryptCustomFields', () => {
    const KEY = 'a'.repeat(64); // 64 hex chars → 256-bit key
    let prevKey: string | undefined;

    beforeEach(() => {
      prevKey = process.env['TELECOM_HD_FIELD_ENCRYPTION_KEY'];
      process.env['TELECOM_HD_FIELD_ENCRYPTION_KEY'] = KEY;
    });
    afterEach(() => {
      if (prevKey === undefined) delete process.env['TELECOM_HD_FIELD_ENCRYPTION_KEY'];
      else process.env['TELECOM_HD_FIELD_ENCRYPTION_KEY'] = prevKey;
    });

    it('encrypts only fields flagged isEncrypted and round-trips on decrypt', async () => {
      (prisma.customField.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ fieldKey: 'secret' }]);

      const values = { secret: 'p@ss', plain: 'visible' };
      const encrypted = await service.encryptCustomFields('TICKET', values);

      // Encrypted field is no longer plaintext; non-encrypted field is untouched.
      expect(typeof encrypted['secret']).toBe('string');
      expect(encrypted['secret']).not.toBe('p@ss');
      expect(encrypted['secret']).toMatch(/^v1:/);
      expect(encrypted['plain']).toBe('visible');

      const decrypted = await service.decryptCustomFields('TICKET', encrypted);
      expect(decrypted).toEqual(values);
    });

    it('is a no-op when no fields are encrypted', async () => {
      (prisma.customField.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      const values = { a: '1' };
      expect(await service.encryptCustomFields('TICKET', values)).toEqual(values);
    });

    // D9 — list endpoints decrypt a whole page in one definition lookup.
    it('decryptCustomFieldsMany decrypts every row with a single field-def query', async () => {
      (prisma.customField.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ fieldKey: 'secret' }]);

      const enc1 = await service.encryptCustomFields('TICKET', { secret: 'one', plain: 'a' });
      const enc2 = await service.encryptCustomFields('TICKET', { secret: 'two', plain: 'b' });
      (prisma.customField.findMany as ReturnType<typeof vi.fn>).mockClear();

      const rows = [
        { id: 1, customFields: enc1 },
        { id: 2, customFields: enc2 },
      ];
      const out = await service.decryptCustomFieldsMany('TICKET', rows);

      expect((out[0]!.customFields as Record<string, unknown>)['secret']).toBe('one');
      expect((out[1]!.customFields as Record<string, unknown>)['secret']).toBe('two');
      expect((out[0]!.customFields as Record<string, unknown>)['plain']).toBe('a');
      // One definition query for the whole page, not one-per-row.
      expect(prisma.customField.findMany).toHaveBeenCalledTimes(1);
    });

    it('decryptCustomFieldsMany is a no-op on an empty page (no query)', async () => {
      (prisma.customField.findMany as ReturnType<typeof vi.fn>).mockClear();
      const out = await service.decryptCustomFieldsMany('TICKET', []);
      expect(out).toEqual([]);
      expect(prisma.customField.findMany).not.toHaveBeenCalled();
    });
  });
});
