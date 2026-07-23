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
  DeleteEmailQueueSchema,
  ListCapturedInboundSchema,
  ListQuarantinedInboundSchema,
  PromoteCapturedInboundSchema,
  ReconcileEmailQueueSchema,
  ReplayQuarantinedInboundSchema,
  UpdateEmailQueueSchema,
  type CreateEmailQueueDto,
  type DeleteEmailQueueDto,
  type ListCapturedInboundDto,
  type ListQuarantinedInboundDto,
  type PromoteCapturedInboundDto,
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

  // Keep every literal inbound route before `:id`. Nest registers controller
  // methods in declaration order and the underlying Express router otherwise
  // treats "inbound" as an id, causing ParseIntPipe to return 400 before the
  // operational endpoint is reached.
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
  // A replay can create ticket/outbox work. The operator must first have the
  // metadata-view capability; an action-only role cannot replay a guessed id.
  @RequirePermissions(PERMISSIONS.MAIL_VIEW, PERMISSIONS.MAIL_REPLAY)
  @ApiOperation({ summary: 'Replay a quarantined inbound delivery (reset to ACCEPTED)' })
  replayQuarantined(
    @Param('deliveryId', ParseIntPipe) deliveryId: number,
    @Body(new ZodValidationPipe(ReplayQuarantinedInboundSchema)) dto: ReplayQuarantinedInboundDto,
    @CurrentStaff() staff: AuthStaff,
  ) {
    return this.emailQueueService.replayQuarantined(deliveryId, dto, staff);
  }

  @Get('inbound/captured')
  @RequirePermissions(PERMISSIONS.MAIL_VIEW)
  @ApiOperation({ summary: 'Paginated captured inbound metadata, filters and totals (never raw MIME)' })
  listCaptured(
    @Query(new ZodValidationPipe(ListCapturedInboundSchema)) query: ListCapturedInboundDto,
    @CurrentStaff() staff: AuthStaff,
  ) {
    return this.emailQueueService.listCaptured(query, staff);
  }

  @Get('inbound/captured/:deliveryId')
  @RequirePermissions(PERMISSIONS.MAIL_VIEW)
  @ApiOperation({ summary: 'Captured inbound metadata and audit history (never raw MIME)' })
  getCaptured(@Param('deliveryId', ParseIntPipe) deliveryId: number, @CurrentStaff() staff: AuthStaff) {
    return this.emailQueueService.getCaptured(deliveryId, staff);
  }

  @Post('inbound/captured/:deliveryId/promote')
  // Promotion can create ticket/outbox work. Require both the review surface and
  // the deliberately separate destructive capability: an action-only role must not
  // promote a guessed delivery id it could not inspect first.
  @RequirePermissions(PERMISSIONS.MAIL_VIEW, PERMISSIONS.MAIL_PROMOTE_CAPTURED)
  @ApiOperation({ summary: 'Promote a captured inbound delivery to normal processing' })
  promoteCaptured(
    @Param('deliveryId', ParseIntPipe) deliveryId: number,
    @Body(new ZodValidationPipe(PromoteCapturedInboundSchema)) dto: PromoteCapturedInboundDto,
    @CurrentStaff() staff: AuthStaff,
  ) {
    return this.emailQueueService.promoteCaptured(deliveryId, dto, staff);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.MAIL_VIEW)
  @ApiOperation({ summary: 'Get an email queue by ID (password excluded)' })
  get(@Param('id', ParseIntPipe) id: number, @CurrentStaff() staff: AuthStaff) {
    return this.emailQueueService.get(id, staff);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.MAIL_VIEW, PERMISSIONS.MAIL_CONFIGURE)
  @ApiOperation({ summary: 'Create an email queue' })
  create(
    @Body(new ZodValidationPipe(CreateEmailQueueSchema)) dto: CreateEmailQueueDto,
    @CurrentStaff() staff: AuthStaff,
  ) {
    return this.emailQueueService.create(dto, staff);
  }

  @Put(':id')
  @RequirePermissions(PERMISSIONS.MAIL_VIEW, PERMISSIONS.MAIL_CONFIGURE)
  @ApiOperation({ summary: 'Update an email queue (partial)' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(UpdateEmailQueueSchema)) dto: UpdateEmailQueueDto,
    @CurrentStaff() staff: AuthStaff,
  ) {
    return this.emailQueueService.update(id, dto, staff);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.MAIL_VIEW, PERMISSIONS.MAIL_CONFIGURE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an email queue' })
  delete(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(DeleteEmailQueueSchema)) dto: DeleteEmailQueueDto,
    @CurrentStaff() staff: AuthStaff,
  ) {
    return this.emailQueueService.delete(id, dto, staff);
  }

  @Post(':id/reconcile')
  @RequirePermissions(PERMISSIONS.MAIL_VIEW, PERMISSIONS.MAIL_RECONCILE)
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
}
