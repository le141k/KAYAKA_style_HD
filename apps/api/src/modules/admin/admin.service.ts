import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { encryptField, decryptField } from '../../common/field-encrypt.util';
import type {
  CreateCustomFieldGroupDto,
  UpdateCustomFieldGroupDto,
  CreateCustomFieldDto,
  UpdateCustomFieldDto,
  CreateEmailTemplateDto,
  UpdateEmailTemplateDto,
} from './dto';
import type { CustomFieldScope } from '@prisma/client';

/**
 * Admin domain: custom-field definitions (groups + fields) and email templates.
 * Also exposes validateCustomFields() so owning entities can enforce values
 * against their field definitions.
 */
@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Custom field groups ──
  listGroups() {
    return this.prisma.customFieldGroup.findMany({
      orderBy: { displayOrder: 'asc' },
      include: { fields: { orderBy: { displayOrder: 'asc' } } },
    });
  }

  createGroup(dto: CreateCustomFieldGroupDto) {
    return this.prisma.customFieldGroup.create({ data: dto });
  }

  async updateGroup(id: number, dto: UpdateCustomFieldGroupDto) {
    await this.getGroupOrThrow(id);
    return this.prisma.customFieldGroup.update({ where: { id }, data: dto });
  }

  async deleteGroup(id: number) {
    await this.getGroupOrThrow(id);
    await this.prisma.customFieldGroup.delete({ where: { id } });
  }

  private async getGroupOrThrow(id: number) {
    const g = await this.prisma.customFieldGroup.findUnique({ where: { id } });
    if (!g) throw new NotFoundException(`CustomFieldGroup ${id} not found`);
    return g;
  }

  // ── Custom fields ──
  createField(groupId: number, dto: CreateCustomFieldDto) {
    return this.prisma.customField.create({
      data: { ...dto, groupId } as Parameters<typeof this.prisma.customField.create>[0]['data'],
    });
  }

  async updateField(id: number, dto: UpdateCustomFieldDto) {
    await this.getFieldOrThrow(id);
    return this.prisma.customField.update({
      where: { id },
      data: dto as Parameters<typeof this.prisma.customField.update>[0]['data'],
    });
  }

  async deleteField(id: number) {
    await this.getFieldOrThrow(id);
    await this.prisma.customField.delete({ where: { id } });
  }

  private async getFieldOrThrow(id: number) {
    const f = await this.prisma.customField.findUnique({ where: { id } });
    if (!f) throw new NotFoundException(`CustomField ${id} not found`);
    return f;
  }

  /**
   * Validate a JSON `customFields` object against the field definitions for a scope.
   * Throws BadRequestException on missing-required or type mismatch.
   */
  async validateCustomFields(scope: CustomFieldScope, values: Record<string, unknown>): Promise<void> {
    const fields = await this.prisma.customField.findMany({ where: { group: { scope } } });
    for (const f of fields) {
      const present = Object.prototype.hasOwnProperty.call(values ?? {}, f.fieldKey);
      const value = (values ?? {})[f.fieldKey];
      if (f.isRequired && (!present || value === null || value === '' || value === undefined)) {
        throw new BadRequestException(`Custom field "${f.fieldKey}" is required`);
      }
      if (present && value !== null && value !== undefined) {
        const ok = this.checkType(f.type, value);
        if (!ok)
          throw new BadRequestException(`Custom field "${f.fieldKey}" has invalid type (expected ${f.type})`);
      }
    }
  }

  /**
   * Return a copy of `values` with every field flagged `isEncrypted` encrypted
   * at rest (AES-256-GCM). Call at write time, AFTER validateCustomFields().
   * No-op for values whose field is not encrypted or that are non-string.
   */
  async encryptCustomFields(
    scope: CustomFieldScope,
    values: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!values || typeof values !== 'object') return values;
    const encryptedFields = await this.prisma.customField.findMany({
      where: { group: { scope }, isEncrypted: true },
      select: { fieldKey: true },
    });
    if (encryptedFields.length === 0) return values;
    const out = { ...values };
    for (const { fieldKey } of encryptedFields) {
      const v = out[fieldKey];
      if (typeof v === 'string' && v !== '') out[fieldKey] = encryptField(v);
    }
    return out;
  }

  /**
   * Inverse of encryptCustomFields — decrypt `isEncrypted` values for an
   * authorized staff read. Plaintext/legacy values pass through unchanged.
   */
  async decryptCustomFields(
    scope: CustomFieldScope,
    values: Record<string, unknown> | null | undefined,
  ): Promise<Record<string, unknown> | null | undefined> {
    if (!values || typeof values !== 'object') return values;
    const encryptedFields = await this.prisma.customField.findMany({
      where: { group: { scope }, isEncrypted: true },
      select: { fieldKey: true },
    });
    if (encryptedFields.length === 0) return values;
    const out = { ...values };
    for (const { fieldKey } of encryptedFields) {
      const v = out[fieldKey];
      if (typeof v === 'string' && v !== '') out[fieldKey] = decryptField(v);
    }
    return out;
  }

  /**
   * Batch variant of decryptCustomFields for list endpoints (D9): resolves the
   * scope's encrypted field keys ONCE, then decrypts each row's customFields
   * in-memory — so a page of N rows costs one definition query, not N. Mutates
   * each entity's `customFields` in place and returns the same array.
   */
  async decryptCustomFieldsMany<T extends { customFields?: unknown }>(
    scope: CustomFieldScope,
    rows: T[],
  ): Promise<T[]> {
    if (rows.length === 0) return rows;
    const encryptedFields = await this.prisma.customField.findMany({
      where: { group: { scope }, isEncrypted: true },
      select: { fieldKey: true },
    });
    if (encryptedFields.length === 0) return rows;
    const keys = encryptedFields.map((f) => f.fieldKey);
    for (const row of rows) {
      const values = row.customFields;
      if (!values || typeof values !== 'object') continue;
      const out = { ...(values as Record<string, unknown>) };
      for (const fieldKey of keys) {
        const v = out[fieldKey];
        if (typeof v === 'string' && v !== '') out[fieldKey] = decryptField(v);
      }
      row.customFields = out;
    }
    return rows;
  }

  private checkType(type: string, value: unknown): boolean {
    switch (type) {
      case 'CHECKBOX':
        return typeof value === 'boolean';
      case 'DATE':
        return typeof value === 'string' && !Number.isNaN(Date.parse(value));
      case 'MULTISELECT':
        return Array.isArray(value);
      case 'NUMBER':
        return (
          typeof value === 'number' ||
          (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value)))
        );
      case 'TEXT':
      case 'TEXTAREA':
      case 'PASSWORD':
      case 'RADIO':
      case 'SELECT':
      case 'FILE':
      case 'CUSTOM':
        return typeof value === 'string' || typeof value === 'number';
      default:
        return true;
    }
  }

  // ── Email templates ──
  listTemplates() {
    return this.prisma.emailTemplate.findMany({ orderBy: [{ key: 'asc' }, { locale: 'asc' }] });
  }

  createTemplate(dto: CreateEmailTemplateDto) {
    return this.prisma.emailTemplate.create({ data: dto });
  }

  async updateTemplate(id: number, dto: UpdateEmailTemplateDto) {
    const t = await this.prisma.emailTemplate.findUnique({ where: { id } });
    if (!t) throw new NotFoundException(`EmailTemplate ${id} not found`);
    return this.prisma.emailTemplate.update({ where: { id }, data: dto });
  }

  async deleteTemplate(id: number) {
    const t = await this.prisma.emailTemplate.findUnique({ where: { id } });
    if (!t) throw new NotFoundException(`EmailTemplate ${id} not found`);
    await this.prisma.emailTemplate.delete({ where: { id } });
  }
}
