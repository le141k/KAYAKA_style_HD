import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service';
import { RequireGlobalAdmin, RequirePermissions } from '../../auth/auth.decorators';
import { PERMISSIONS } from '../../auth/permissions';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

const ParserCriterionSchema = z.object({
  field: z.enum(['subject', 'sender', 'sendername', 'recipient', 'body']),
  op: z.enum(['contains', 'not_contains', 'eq', 'starts_with', 'ends_with', 'regex']),
  value: z.string(),
});

const ParserActionSchema = z.object({
  type: z.enum(['ignore', 'route_dept', 'set_priority', 'assign_staff', 'add_tag']),
  value: z.union([z.string(), z.number()]).optional(),
});

const CreateParserRuleSchema = z.object({
  title: z.string().min(1).max(200),
  ruleType: z.enum(['PRE_PARSE', 'POST_PARSE']).default('PRE_PARSE'),
  matchType: z.enum(['ALL', 'ANY']).default('ALL'),
  stopProcessing: z.boolean().default(false),
  isEnabled: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
  criteria: z.array(ParserCriterionSchema).default([]),
  actions: z.array(ParserActionSchema).default([]),
});

const UpdateParserRuleSchema = CreateParserRuleSchema.partial();

const ReorderSchema = z.object({
  /** Array of {id, sortOrder} pairs to update */
  items: z.array(z.object({ id: z.number().int().positive(), sortOrder: z.number().int() })),
});

type CreateParserRuleDto = z.infer<typeof CreateParserRuleSchema>;
type UpdateParserRuleDto = z.infer<typeof UpdateParserRuleSchema>;
type ReorderDto = z.infer<typeof ReorderSchema>;

@ApiTags('admin/parser-rules')
@Controller('admin/parser-rules')
@RequirePermissions(PERMISSIONS.MAIL_CONFIGURE)
@RequireGlobalAdmin()
export class ParserRulesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'List all email parser rules ordered by sortOrder' })
  list() {
    return this.prisma.emailParserRule.findMany({ orderBy: { sortOrder: 'asc' } });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single parser rule by ID' })
  async get(@Param('id', ParseIntPipe) id: number) {
    const rule = await this.prisma.emailParserRule.findUnique({ where: { id } });
    if (!rule) throw new NotFoundException(`Parser rule ${id} not found`);
    return rule;
  }

  @Post()
  @ApiOperation({ summary: 'Create a new parser rule' })
  create(@Body(new ZodValidationPipe(CreateParserRuleSchema)) dto: CreateParserRuleDto) {
    return this.prisma.emailParserRule.create({
      data: {
        title: dto.title,
        ruleType: dto.ruleType,
        matchType: dto.matchType,
        stopProcessing: dto.stopProcessing,
        isEnabled: dto.isEnabled,
        sortOrder: dto.sortOrder,
        criteria: dto.criteria as object,
        actions: dto.actions as object,
      },
    });
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a parser rule (partial)' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(UpdateParserRuleSchema)) dto: UpdateParserRuleDto,
  ) {
    await this.get(id); // throws NotFoundException when missing
    return this.prisma.emailParserRule.update({
      where: { id },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.ruleType !== undefined && { ruleType: dto.ruleType }),
        ...(dto.matchType !== undefined && { matchType: dto.matchType }),
        ...(dto.stopProcessing !== undefined && { stopProcessing: dto.stopProcessing }),
        ...(dto.isEnabled !== undefined && { isEnabled: dto.isEnabled }),
        ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
        ...(dto.criteria !== undefined && { criteria: dto.criteria as object }),
        ...(dto.actions !== undefined && { actions: dto.actions as object }),
      },
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a parser rule' })
  async delete(@Param('id', ParseIntPipe) id: number) {
    await this.get(id); // throws NotFoundException when missing
    await this.prisma.emailParserRule.delete({ where: { id } });
  }

  @Post('reorder')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Bulk update sortOrder for multiple rules' })
  async reorder(@Body(new ZodValidationPipe(ReorderSchema)) dto: ReorderDto) {
    await Promise.all(
      dto.items.map(({ id, sortOrder }) =>
        this.prisma.emailParserRule.update({ where: { id }, data: { sortOrder } }),
      ),
    );
  }
}
