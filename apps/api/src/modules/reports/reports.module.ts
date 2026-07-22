import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Module,
  OnModuleInit,
  Logger,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Delete,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { BullModule, InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { Response } from 'express';
import { CurrentStaff, RequirePermissions, type AuthStaff } from '../../auth/auth.decorators';
import { PERMISSIONS } from '../../auth/permissions';
import {
  ReportsService,
  ReportCreateSchema,
  ReportUpdateSchema,
  ScheduleCreateSchema,
} from './reports.service';
import { ReportCompiler } from './report-compiler';
import { toCsv } from './reports.utils';
import { ReportScheduleProcessor } from './report-schedule.processor';
import { MailModule } from '../mail/mail.module';
import { TicketAccessModule } from '../tickets/ticket-access.module';

// Re-export service for existing imports
export { ReportsService } from './reports.service';

// ─── Controller ───────────────────────────────────────────────────────────────

@ApiTags('reports')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @RequirePermissions(PERMISSIONS.TICKET_VIEW)
  @Get('dashboard')
  @ApiOperation({ summary: 'Dashboard summary metrics' })
  dashboard(@CurrentStaff() staff: AuthStaff) {
    return this.reports.dashboard(staff);
  }

  @RequirePermissions(PERMISSIONS.REPORT_RUN)
  @Get()
  list() {
    return this.reports.list();
  }

  @RequirePermissions(PERMISSIONS.REPORT_RUN)
  @Get(':id/run')
  async run(
    @Param('id', ParseIntPipe) id: number,
    @Query('format') format: string,
    @Res({ passthrough: true }) res: Response,
    @CurrentStaff() staff: AuthStaff,
  ) {
    const rows = await this.reports.run(id, staff);
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="report-${id}.csv"`);
      return res.send(toCsv(rows as Record<string, unknown>[]));
    }
    return rows;
  }

  @RequirePermissions(PERMISSIONS.REPORT_RUN)
  @Get(':id/runs')
  listRuns(@Param('id', ParseIntPipe) id: number) {
    return this.reports.listRuns(id);
  }

  @RequirePermissions(PERMISSIONS.REPORT_MANAGE)
  @Post()
  async create(@Body() body: unknown) {
    const parsed = ReportCreateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.reports.create(parsed.data);
  }

  @RequirePermissions(PERMISSIONS.REPORT_MANAGE)
  @Put(':id')
  async update(@Param('id', ParseIntPipe) id: number, @Body() body: unknown) {
    const parsed = ReportUpdateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.reports.update(id, parsed.data);
  }

  @RequirePermissions(PERMISSIONS.REPORT_MANAGE)
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.reports.remove(id);
  }

  // ─── Schedule endpoints ─────────────────────────────────────────────────

  @RequirePermissions(PERMISSIONS.REPORT_MANAGE)
  @Get(':id/schedules')
  listSchedules(@Param('id', ParseIntPipe) id: number, @CurrentStaff() staff: AuthStaff) {
    return this.reports.listSchedules(id, staff);
  }

  @RequirePermissions(PERMISSIONS.REPORT_MANAGE)
  @Post(':id/schedules')
  async createSchedule(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
    @CurrentStaff() staff: AuthStaff,
  ) {
    const parsed = ScheduleCreateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.reports.createSchedule(id, parsed.data, staff);
  }

  @RequirePermissions(PERMISSIONS.REPORT_MANAGE)
  @Put('schedules/:scheduleId')
  async updateSchedule(
    @Param('scheduleId', ParseIntPipe) scheduleId: number,
    @Body() body: unknown,
    @CurrentStaff() staff: AuthStaff,
  ) {
    const parsed = ScheduleCreateSchema.partial().safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.reports.updateSchedule(scheduleId, parsed.data, staff);
  }

  @RequirePermissions(PERMISSIONS.REPORT_MANAGE)
  @Delete('schedules/:scheduleId')
  removeSchedule(@Param('scheduleId', ParseIntPipe) scheduleId: number, @CurrentStaff() staff: AuthStaff) {
    return this.reports.removeSchedule(scheduleId, staff);
  }
}

// ─── Module ───────────────────────────────────────────────────────────────────

@Module({
  imports: [BullModule.registerQueue({ name: 'reports' }), MailModule, TicketAccessModule],
  controllers: [ReportsController],
  providers: [ReportsService, ReportCompiler, ReportScheduleProcessor],
  exports: [ReportsService],
})
export class ReportsModule implements OnModuleInit {
  private readonly logger = new Logger(ReportsModule.name);

  constructor(@InjectQueue('reports') private readonly reportsQueue: Queue) {}

  async onModuleInit(): Promise<void> {
    await this.reportsQueue.add(
      'schedule-scan',
      {},
      {
        jobId: 'reports-schedule-scan-repeatable',
        repeat: { every: 5 * 60_000 }, // every 5 minutes
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
    this.logger.log('Reports schedule-scan job registered (every 5min)');
  }
}
