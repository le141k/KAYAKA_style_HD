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
  Query,
  Put,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions, CurrentStaff, type AuthStaff } from '../../auth/auth.decorators';
import { PERMISSIONS } from '../../auth/permissions';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import {
  CreateEmailQueueSchema,
  ListQuarantinedInboundSchema,
  ReconcileEmailQueueSchema,
  ReplayQuarantinedInboundSchema,
  UpdateEmailQueueSchema,
  type CreateEmailQueueDto,
  type ListQuarantinedInboundDto,
  type ReconcileEmailQueueDto,
  type ReplayQuarantinedInboundDto,
  type UpdateEmailQueueDto,
} from './dto';
import { EmailQueueService } from './email-queue.service';

@ApiTags('admin/email-queues')
@Controller('admin/email-queues')
export class EmailQueueController {
  constructor(private readonly emailQueueService: EmailQueueService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.MAIL_VIEW)
  @ApiOperation({ summary: 'List all email queues (password excluded)' })
  list(@CurrentStaff() staff: AuthStaff) {
    return this.emailQueueService.list(staff);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.MAIL_VIEW)
  @ApiOperation({ summary: 'Get an email queue by ID (password excluded)' })
  get(@Param('id', ParseIntPipe) id: number, @CurrentStaff() staff: AuthStaff) {
    return this.emailQueueService.get(id, staff);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.MAIL_CONFIGURE)
  @ApiOperation({ summary: 'Create an email queue' })
  create(
    @Body(new ZodValidationPipe(CreateEmailQueueSchema)) dto: CreateEmailQueueDto,
    @CurrentStaff() staff: AuthStaff,
  ) {
    return this.emailQueueService.create(dto, staff);
  }

  @Put(':id')
  @RequirePermissions(PERMISSIONS.MAIL_CONFIGURE)
  @ApiOperation({ summary: 'Update an email queue (partial)' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(UpdateEmailQueueSchema)) dto: UpdateEmailQueueDto,
    @CurrentStaff() staff: AuthStaff,
  ) {
    return this.emailQueueService.update(id, dto, staff);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.MAIL_CONFIGURE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an email queue' })
  delete(@Param('id', ParseIntPipe) id: number, @CurrentStaff() staff: AuthStaff) {
    return this.emailQueueService.delete(id, staff);
  }

  @Post(':id/reconcile')
  @RequirePermissions(PERMISSIONS.MAIL_RECONCILE)
  @ApiOperation({
    summary: 'Cutover / reconcile a halted IMAP queue (RESUME_MIGRATED / FROM_NOW / BACKFILL)',
  })
  reconcile(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(ReconcileEmailQueueSchema)) dto: ReconcileEmailQueueDto,
    @CurrentStaff() staff: AuthStaff,
  ) {
    return this.emailQueueService.reconcile(id, dto, staff);
  }

  @Get('inbound/health')
  @RequirePermissions(PERMISSIONS.MAIL_VIEW)
  @ApiOperation({ summary: 'Inbound health: per-queue sync state, ledger backlog + staleness, alerts' })
  health(@CurrentStaff() staff: AuthStaff) {
    return this.emailQueueService.health(staff);
  }

  @Get('inbound/quarantine')
  @RequirePermissions(PERMISSIONS.MAIL_VIEW)
  @ApiOperation({ summary: 'Paginated inbound quarantine metadata, filters and totals' })
  listQuarantined(
    @Query(new ZodValidationPipe(ListQuarantinedInboundSchema)) query: ListQuarantinedInboundDto,
    @CurrentStaff() staff: AuthStaff,
  ) {
    return this.emailQueueService.listQuarantined(query, staff);
  }

  @Get('inbound/quarantine/:deliveryId')
  @RequirePermissions(PERMISSIONS.MAIL_VIEW)
  @ApiOperation({ summary: 'Inbound quarantine metadata and audit history (never raw MIME)' })
  getQuarantined(@Param('deliveryId', ParseIntPipe) deliveryId: number, @CurrentStaff() staff: AuthStaff) {
    return this.emailQueueService.getQuarantined(deliveryId, staff);
  }

  @Post('inbound/quarantine/:deliveryId/replay')
  @RequirePermissions(PERMISSIONS.MAIL_REPLAY)
  @ApiOperation({ summary: 'Replay a quarantined inbound delivery (reset to ACCEPTED)' })
  replayQuarantined(
    @Param('deliveryId', ParseIntPipe) deliveryId: number,
    @Body(new ZodValidationPipe(ReplayQuarantinedInboundSchema)) dto: ReplayQuarantinedInboundDto,
    @CurrentStaff() staff: AuthStaff,
  ) {
    return this.emailQueueService.replayQuarantined(deliveryId, dto, staff);
  }
}
