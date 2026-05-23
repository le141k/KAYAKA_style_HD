import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { CustomFieldScope } from '@prisma/client';

/** Public view of a custom field — no encryption/internal flags leaked. */
export interface PublicCustomField {
  id: number;
  fieldKey: string;
  title: string;
  type: string;
  isRequired: boolean;
  displayOrder: number;
  options: unknown;
}

export interface PublicCustomFieldGroup {
  id: number;
  title: string;
  scope: CustomFieldScope;
  displayOrder: number;
  fields: PublicCustomField[];
}

@Injectable()
export class CustomFieldsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Read-only custom-field groups for a given scope (defaults to TICKET), used by
   * the staff-create and unauthenticated client-submit forms to render dynamic
   * inputs. Returns only the fields needed to render + validate (no isEncrypted).
   */
  async listByScope(scope: CustomFieldScope = 'TICKET'): Promise<PublicCustomFieldGroup[]> {
    const groups = await this.prisma.customFieldGroup.findMany({
      where: { scope },
      orderBy: { displayOrder: 'asc' },
      include: { fields: { orderBy: { displayOrder: 'asc' } } },
    });
    return groups.map((g) => ({
      id: g.id,
      title: g.title,
      scope: g.scope,
      displayOrder: g.displayOrder,
      fields: g.fields.map((f) => ({
        id: f.id,
        fieldKey: f.fieldKey,
        title: f.title,
        type: f.type,
        isRequired: f.isRequired,
        displayOrder: f.displayOrder,
        options: f.options,
      })),
    }));
  }
}
