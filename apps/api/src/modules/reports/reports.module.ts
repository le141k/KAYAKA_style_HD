import { Body, Controller, Get, Injectable, Module, Param, ParseIntPipe, Post, UsePipes } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { RequirePermissions } from '../../auth/auth.decorators';
import { PERMISSIONS } from '../../auth/permissions';

/**
 * "KQL-lite" report definition. A safe, declarative subset of Kayako's KQL:
 *   { source: 'tickets', groupBy?: <field>, filters?: {field: value}, metric: 'count' }
 * Full KQL (lexer/parser/compiler) is a future enhancement (see docs/adr).
 */
const GROUPABLE = ['statusId', 'priorityId', 'departmentId', 'typeId', 'ownerStaffId', 'creationMode'] as const;
const DefinitionSchema = z.object({
  source: z.literal('tickets').default('tickets'),
  groupBy: z.enum(GROUPABLE).optional(),
  filters: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  metric: z.literal('count').default('count'),
});
type Definition = z.infer<typeof DefinitionSchema>;

const ReportSchema = z.object({
  title: z.string().min(1),
  kind: z.enum(['TABULAR', 'SUMMARY', 'MATRIX']).default('SUMMARY'),
  definition: DefinitionSchema,
});

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.report.findMany({ orderBy: { createdAt: 'desc' } });
  }

  create(dto: z.infer<typeof ReportSchema>) {
    return this.prisma.report.create({ data: { title: dto.title, kind: dto.kind, definition: dto.definition } });
  }

  /** Executes a stored report's definition and returns aggregated rows. */
  async run(id: number) {
    const report = await this.prisma.report.findUniqueOrThrow({ where: { id } });
    return this.execute(report.definition as Definition);
  }

  /** Ad-hoc execution of a definition (used by dashboards). */
  async execute(def: Definition) {
    const where = def.filters as Record<string, unknown>;
    if (def.groupBy) {
      const rows = await this.prisma.ticket.groupBy({
        by: [def.groupBy],
        where,
        _count: { _all: true },
      });
      return rows.map((r) => ({ key: r[def.groupBy as keyof typeof r], count: r._count._all }));
    }
    const total = await this.prisma.ticket.count({ where });
    return [{ key: 'total', count: total }];
  }

  /** Convenience dashboard summary used by the staff home screen. */
  async dashboard() {
    const [byStatus, byPriority, total, resolved] = await Promise.all([
      this.execute({ source: 'tickets', groupBy: 'statusId', filters: {}, metric: 'count' }),
      this.execute({ source: 'tickets', groupBy: 'priorityId', filters: {}, metric: 'count' }),
      this.prisma.ticket.count(),
      this.prisma.ticket.count({ where: { isResolved: true } }),
    ]);
    return { total, resolved, byStatus, byPriority };
  }
}

@ApiTags('reports')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @RequirePermissions(PERMISSIONS.TICKET_VIEW) @Get('dashboard') @ApiOperation({ summary: 'Dashboard summary metrics' })
  dashboard() { return this.reports.dashboard(); }

  @RequirePermissions(PERMISSIONS.TICKET_VIEW) @Get()
  list() { return this.reports.list(); }

  @RequirePermissions(PERMISSIONS.TICKET_VIEW) @Get(':id/run')
  run(@Param('id', ParseIntPipe) id: number) { return this.reports.run(id); }

  @RequirePermissions(PERMISSIONS.ADMIN_SETTINGS) @Post() @UsePipes(new ZodValidationPipe(ReportSchema))
  create(@Body() dto: z.infer<typeof ReportSchema>) { return this.reports.create(dto); }
}

@Module({
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
