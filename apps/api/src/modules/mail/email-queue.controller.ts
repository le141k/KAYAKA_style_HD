import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Put,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions, CurrentStaff, type AuthStaff } from '../../auth/auth.decorators';
import { PERMISSIONS } from '../../auth/permissions';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import {
  CreateEmailQueueSchema,
  ReconcileEmailQueueSchema,
  UpdateEmailQueueSchema,
  type CreateEmailQueueDto,
  type ReconcileEmailQueueDto,
  type UpdateEmailQueueDto,
} from './dto';
import { EmailQueueService } from './email-queue.service';

@ApiTags('admin/email-queues')
@Controller('admin/email-queues')
export class EmailQueueController {
  constructor(private readonly emailQueueService: EmailQueueService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ADMIN_MAIL)
  @ApiOperation({ summary: 'List all email queues (password excluded)' })
  list() {
    return this.emailQueueService.list();
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_MAIL)
  @ApiOperation({ summary: 'Get an email queue by ID (password excluded)' })
  get(@Param('id', ParseIntPipe) id: number) {
    return this.emailQueueService.get(id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.ADMIN_MAIL)
  @ApiOperation({ summary: 'Create an email queue' })
  create(@Body(new ZodValidationPipe(CreateEmailQueueSchema)) dto: CreateEmailQueueDto) {
    return this.emailQueueService.create(dto);
  }

  @Put(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_MAIL)
  @ApiOperation({ summary: 'Update an email queue (partial)' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(UpdateEmailQueueSchema)) dto: UpdateEmailQueueDto,
  ) {
    return this.emailQueueService.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_MAIL)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an email queue' })
  delete(@Param('id', ParseIntPipe) id: number) {
    return this.emailQueueService.delete(id);
  }

  @Post(':id/reconcile')
  @RequirePermissions(PERMISSIONS.ADMIN_MAIL)
  @ApiOperation({
    summary: 'Cutover / reconcile a halted IMAP queue (RESUME_MIGRATED / FROM_NOW / BACKFILL)',
  })
  reconcile(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(ReconcileEmailQueueSchema)) dto: ReconcileEmailQueueDto,
    @CurrentStaff() staff: AuthStaff,
  ) {
    return this.emailQueueService.reconcile(id, dto, staff.staffId);
  }

  @Get('inbound/health')
  @RequirePermissions(PERMISSIONS.ADMIN_MAIL)
  @ApiOperation({ summary: 'Inbound health: per-queue sync state, ledger backlog + staleness, alerts' })
  health() {
    return this.emailQueueService.health();
  }

  @Get('inbound/quarantine')
  @RequirePermissions(PERMISSIONS.ADMIN_MAIL)
  @ApiOperation({ summary: 'List quarantined inbound deliveries (metadata only)' })
  listQuarantined() {
    return this.emailQueueService.listQuarantined();
  }

  @Post('inbound/quarantine/:deliveryId/replay')
  @RequirePermissions(PERMISSIONS.ADMIN_MAIL)
  @ApiOperation({ summary: 'Replay a quarantined inbound delivery (reset to ACCEPTED)' })
  replayQuarantined(@Param('deliveryId', ParseIntPipe) deliveryId: number) {
    return this.emailQueueService.replayQuarantined(deliveryId);
  }
}
