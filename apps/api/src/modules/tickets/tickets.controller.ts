import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UsePipes,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { TicketsService } from './tickets.service';
import { RequirePermissions, CurrentStaff, Public } from '../../auth/auth.decorators';
import type { AuthStaff } from '../../auth/auth.decorators';
import { PERMISSIONS } from '../../auth/permissions';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import {
  CreateTicketSchema,
  ReplyTicketSchema,
  AssignTicketSchema,
  ChangeStatusSchema,
  ChangePrioritySchema,
  ChangeTypeSchema,
  MergeTicketSchema,
  SplitTicketSchema,
  TagSchema,
  WatcherSchema,
  ListTicketsQuerySchema,
  PublicCreateTicketSchema,
  ApplyMacroSchema,
  ChangeDepartmentSchema,
  type CreateTicketDto,
  type ReplyTicketDto,
  type AssignTicketDto,
  type ChangeStatusDto,
  type ChangePriorityDto,
  type ChangeTypeDto,
  type MergeTicketDto,
  type SplitTicketDto,
  type TagDto,
  type WatcherDto,
  type ListTicketsQueryDto,
  type PublicCreateTicketDto,
  PublicReplySchema,
  type PublicReplyDto,
  type ApplyMacroDto,
  type ChangeDepartmentDto,
} from './dto';

@ApiTags('tickets')
@Controller('tickets')
export class TicketsController {
  constructor(private readonly ticketsService: TicketsService) {}

  // ─────────────────── Public submission (client portal) ───────────────────

  @Public()
  @Post('public')
  @UsePipes(new ZodValidationPipe(PublicCreateTicketSchema))
  @ApiOperation({ summary: 'Submit a ticket from the client portal (no auth required)' })
  async publicCreate(@Body() dto: PublicCreateTicketDto) {
    // TODO: rate-limit by IP
    return this.ticketsService.createTicket({
      ...dto,
      contents: dto.contents,
      departmentId: dto.departmentId ?? 1,
      isHtml: false,
      creationMode: 'WEB',
      ipAddress: '0.0.0.0',
      tags: [],
      customFields: dto.customFields,
    });
  }

  // ─────────────────── Client: my tickets ───────────────────

  @Public()
  @Get('my')
  @ApiOperation({ summary: "List the current requester's tickets by email (client portal)" })
  listMy(@Query('email') email: string | undefined) {
    if (!email) {
      throw new BadRequestException('Query parameter "email" is required');
    }
    return this.ticketsService.listMyTickets(email);
  }

  // ─────────────────── Client: public ticket detail ───────────────────

  @Public()
  @Get('public/:id')
  @ApiOperation({
    summary:
      'Get a single ticket (no auth) with public posts only — no internal notes. Requires ?email= matching the ticket requester.',
  })
  getPublic(@Param('id', ParseIntPipe) id: number, @Query('email') email: string | undefined) {
    if (!email) {
      throw new BadRequestException('Query parameter "email" is required');
    }
    return this.ticketsService.getPublicTicket(id, email);
  }

  // ─────────────────── Client: public reply ───────────────────

  @Public()
  @Post('public/:id/reply')
  @ApiOperation({ summary: 'Add a user reply to a ticket from the client portal (no auth required)' })
  publicReply(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(PublicReplySchema)) dto: PublicReplyDto,
  ) {
    return this.ticketsService.publicReply(id, dto);
  }

  // ─────────────────── Staff routes ───────────────────

  @Get()
  @RequirePermissions(PERMISSIONS.TICKET_VIEW)
  @ApiOperation({ summary: 'List tickets with filters and pagination' })
  list(@Query(new ZodValidationPipe(ListTicketsQuerySchema)) query: ListTicketsQueryDto) {
    return this.ticketsService.listTickets(query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.TICKET_VIEW)
  @ApiOperation({ summary: 'Get a ticket by numeric ID (with posts, notes, watchers, tags)' })
  get(@Param('id', ParseIntPipe) id: number) {
    return this.ticketsService.getTicket(id);
  }

  @Get('by-mask/:mask')
  @RequirePermissions(PERMISSIONS.TICKET_VIEW)
  @ApiOperation({ summary: 'Get a ticket by its human-readable mask (e.g. TT-000042)' })
  getByMask(@Param('mask') mask: string) {
    return this.ticketsService.getTicketByMask(mask);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.TICKET_CREATE)
  @UsePipes(new ZodValidationPipe(CreateTicketSchema))
  @ApiOperation({ summary: 'Create a ticket (staff)' })
  create(@Body() dto: CreateTicketDto, @CurrentStaff() staff: AuthStaff) {
    return this.ticketsService.createTicket(dto, staff.staffId);
  }

  @Post(':id/reply')
  @RequirePermissions(PERMISSIONS.TICKET_REPLY)
  @ApiOperation({ summary: 'Add a reply post to a ticket' })
  reply(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(ReplyTicketSchema)) dto: ReplyTicketDto,
    @CurrentStaff() staff: AuthStaff,
  ) {
    return this.ticketsService.reply(id, dto, staff.staffId);
  }

  @Post(':id/notes')
  @RequirePermissions(PERMISSIONS.TICKET_NOTE)
  @ApiOperation({ summary: 'Add an internal note to a ticket' })
  addNote(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(ReplyTicketSchema)) dto: ReplyTicketDto,
    @CurrentStaff() staff: AuthStaff,
  ) {
    // Force isNote=true regardless of body
    return this.ticketsService.addNote(id, dto.contents, staff.staffId);
  }

  @Patch(':id/assign')
  @RequirePermissions(PERMISSIONS.TICKET_ASSIGN)
  @ApiOperation({ summary: 'Assign (or unassign) a ticket to a staff member' })
  assign(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(AssignTicketSchema)) dto: AssignTicketDto,
    @CurrentStaff() staff: AuthStaff,
  ) {
    return this.ticketsService.assign(id, dto, staff.staffId);
  }

  @Patch(':id/status')
  @RequirePermissions(PERMISSIONS.TICKET_EDIT)
  @ApiOperation({ summary: 'Change ticket status' })
  changeStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(ChangeStatusSchema)) dto: ChangeStatusDto,
    @CurrentStaff() staff: AuthStaff,
  ) {
    return this.ticketsService.changeStatus(id, dto, staff.staffId);
  }

  @Patch(':id/priority')
  @RequirePermissions(PERMISSIONS.TICKET_EDIT)
  @ApiOperation({ summary: 'Change ticket priority' })
  changePriority(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(ChangePrioritySchema)) dto: ChangePriorityDto,
    @CurrentStaff() staff: AuthStaff,
  ) {
    return this.ticketsService.changePriority(id, dto, staff.staffId);
  }

  @Patch(':id/type')
  @RequirePermissions(PERMISSIONS.TICKET_EDIT)
  @ApiOperation({ summary: 'Change ticket type' })
  changeType(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(ChangeTypeSchema)) dto: ChangeTypeDto,
    @CurrentStaff() staff: AuthStaff,
  ) {
    return this.ticketsService.changeType(id, dto, staff.staffId);
  }

  @Post(':id/merge')
  @RequirePermissions(PERMISSIONS.TICKET_MERGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Merge this ticket into a target ticket' })
  merge(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(MergeTicketSchema)) dto: MergeTicketDto,
    @CurrentStaff() staff: AuthStaff,
  ) {
    return this.ticketsService.merge(id, dto, staff.staffId);
  }

  @Post(':id/split')
  @RequirePermissions(PERMISSIONS.TICKET_MERGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Split selected posts out of a ticket into a new ticket' })
  split(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(SplitTicketSchema)) dto: SplitTicketDto,
    @CurrentStaff() staff: AuthStaff,
  ) {
    return this.ticketsService.split(id, dto, staff.staffId);
  }

  @Post(':id/apply-macro')
  @RequirePermissions(PERMISSIONS.TICKET_EDIT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Apply a macro to a ticket (posts reply text and executes actions)' })
  applyMacro(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(ApplyMacroSchema)) dto: ApplyMacroDto,
    @CurrentStaff() staff: AuthStaff,
  ) {
    return this.ticketsService.applyMacro(id, dto, staff.staffId);
  }

  @Patch(':id/department')
  @RequirePermissions(PERMISSIONS.TICKET_EDIT)
  @ApiOperation({ summary: 'Change the department of a ticket' })
  changeDepartment(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(ChangeDepartmentSchema)) dto: ChangeDepartmentDto,
    @CurrentStaff() staff: AuthStaff,
  ) {
    return this.ticketsService.changeDepartment(id, dto, staff.staffId);
  }

  // ─────────────────── Watchers ───────────────────

  @Post(':id/watchers')
  @RequirePermissions(PERMISSIONS.TICKET_EDIT)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Add a watcher to a ticket' })
  addWatcher(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(WatcherSchema)) dto: WatcherDto,
  ) {
    return this.ticketsService.addWatcher(id, dto);
  }

  @Delete(':id/watchers/:staffId')
  @RequirePermissions(PERMISSIONS.TICKET_EDIT)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a watcher from a ticket' })
  removeWatcher(@Param('id', ParseIntPipe) id: number, @Param('staffId', ParseIntPipe) staffId: number) {
    return this.ticketsService.removeWatcher(id, staffId);
  }

  // ─────────────────── Tags ───────────────────

  @Post(':id/tags')
  @RequirePermissions(PERMISSIONS.TICKET_EDIT)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Add a tag to a ticket' })
  addTag(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(TagSchema)) dto: TagDto) {
    return this.ticketsService.addTag(id, dto);
  }

  @Delete(':id/tags/:name')
  @RequirePermissions(PERMISSIONS.TICKET_EDIT)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a tag from a ticket' })
  removeTag(@Param('id', ParseIntPipe) id: number, @Param('name') name: string) {
    return this.ticketsService.removeTag(id, name);
  }
}
