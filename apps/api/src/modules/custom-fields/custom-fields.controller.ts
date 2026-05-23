import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CustomFieldsService } from './custom-fields.service';
import { Public } from '../../auth/auth.decorators';
import type { CustomFieldScope } from '@prisma/client';

const VALID_SCOPES = ['TICKET', 'USER', 'STAFF', 'ORGANIZATION'] as const;

@ApiTags('custom-fields')
@Controller('custom-fields')
export class CustomFieldsController {
  constructor(private readonly customFields: CustomFieldsService) {}

  /**
   * Public, read-only custom-field groups for a scope (default TICKET). Lets the
   * staff-create and unauthenticated client-submit forms render required custom
   * fields (previously they were never fetched, so required fields silently 400'd).
   */
  @Get('public')
  @Public()
  @ApiOperation({ summary: 'Public custom-field groups for a scope (default TICKET)' })
  listPublic(@Query('scope') scope?: string) {
    const normalized = (scope ?? 'TICKET').toUpperCase();
    const safeScope = (VALID_SCOPES as readonly string[]).includes(normalized)
      ? (normalized as CustomFieldScope)
      : 'TICKET';
    return this.customFields.listByScope(safeScope);
  }
}
