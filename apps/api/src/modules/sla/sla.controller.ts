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
import { SlaService } from './sla.service';
import { RequirePermissions } from '../../auth/auth.decorators';
import { PERMISSIONS } from '../../auth/permissions';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import {
  CreateSlaPlanSchema,
  UpdateSlaPlanSchema,
  CreateSlaScheduleSchema,
  UpdateSlaScheduleSchema,
  CreateSlaHolidaySchema,
  UpdateSlaHolidaySchema,
  CreateEscalationRuleSchema,
  UpdateEscalationRuleSchema,
  type CreateSlaPlanDto,
  type UpdateSlaPlanDto,
  type CreateSlaScheduleDto,
  type UpdateSlaScheduleDto,
  type CreateSlaHolidayDto,
  type UpdateSlaHolidayDto,
  type CreateEscalationRuleDto,
  type UpdateEscalationRuleDto,
} from './dto';

// ─────────────────── SlaSchedule ───────────────────

@ApiTags('admin/sla')
@Controller('admin/sla/schedules')
export class SlaScheduleController {
  constructor(private readonly slaService: SlaService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ADMIN_SLA)
  @ApiOperation({ summary: 'List SLA schedules' })
  list() {
    return this.slaService.listSchedules();
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_SLA)
  @ApiOperation({ summary: 'Get an SLA schedule by ID' })
  get(@Param('id', ParseIntPipe) id: number) {
    return this.slaService.getSchedule(id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.ADMIN_SLA)
  @ApiOperation({ summary: 'Create an SLA schedule' })
  create(@Body(new ZodValidationPipe(CreateSlaScheduleSchema)) dto: CreateSlaScheduleDto) {
    return this.slaService.createSchedule(dto);
  }

  @Put(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_SLA)
  @ApiOperation({ summary: 'Update an SLA schedule' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(UpdateSlaScheduleSchema)) dto: UpdateSlaScheduleDto,
  ) {
    return this.slaService.updateSchedule(id, dto);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_SLA)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an SLA schedule' })
  delete(@Param('id', ParseIntPipe) id: number) {
    return this.slaService.deleteSchedule(id);
  }

  // ─── Holidays nested under schedule ───

  @Get(':scheduleId/holidays')
  @RequirePermissions(PERMISSIONS.ADMIN_SLA)
  @ApiOperation({ summary: 'List holidays for an SLA schedule' })
  listHolidays(@Param('scheduleId', ParseIntPipe) scheduleId: number) {
    return this.slaService.listHolidays(scheduleId);
  }

  @Post(':scheduleId/holidays')
  @RequirePermissions(PERMISSIONS.ADMIN_SLA)
  @ApiOperation({ summary: 'Add a holiday to an SLA schedule' })
  createHoliday(
    @Param('scheduleId', ParseIntPipe) scheduleId: number,
    @Body(new ZodValidationPipe(CreateSlaHolidaySchema)) dto: CreateSlaHolidayDto,
  ) {
    return this.slaService.createHoliday(scheduleId, dto);
  }

  @Put(':scheduleId/holidays/:id')
  @RequirePermissions(PERMISSIONS.ADMIN_SLA)
  @ApiOperation({ summary: 'Update a holiday' })
  updateHoliday(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(UpdateSlaHolidaySchema)) dto: UpdateSlaHolidayDto,
  ) {
    return this.slaService.updateHoliday(id, dto);
  }

  @Delete(':scheduleId/holidays/:id')
  @RequirePermissions(PERMISSIONS.ADMIN_SLA)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a holiday' })
  deleteHoliday(@Param('id', ParseIntPipe) id: number) {
    return this.slaService.deleteHoliday(id);
  }
}

// ─────────────────── SlaPlan ───────────────────

@ApiTags('admin/sla')
@Controller('admin/sla/plans')
export class SlaPlansController {
  constructor(private readonly slaService: SlaService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ADMIN_SLA)
  @ApiOperation({ summary: 'List SLA plans' })
  list() {
    return this.slaService.listPlans();
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_SLA)
  @ApiOperation({ summary: 'Get an SLA plan by ID' })
  get(@Param('id', ParseIntPipe) id: number) {
    return this.slaService.getPlan(id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.ADMIN_SLA)
  @ApiOperation({ summary: 'Create an SLA plan' })
  create(@Body(new ZodValidationPipe(CreateSlaPlanSchema)) dto: CreateSlaPlanDto) {
    return this.slaService.createPlan(dto);
  }

  @Put(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_SLA)
  @ApiOperation({ summary: 'Update an SLA plan' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(UpdateSlaPlanSchema)) dto: UpdateSlaPlanDto,
  ) {
    return this.slaService.updatePlan(id, dto);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_SLA)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an SLA plan' })
  delete(@Param('id', ParseIntPipe) id: number) {
    return this.slaService.deletePlan(id);
  }

  // ─── Escalation rules nested under plan ───

  @Get(':planId/escalation-rules')
  @RequirePermissions(PERMISSIONS.ADMIN_SLA)
  @ApiOperation({ summary: 'List escalation rules for an SLA plan' })
  listRules(@Param('planId', ParseIntPipe) planId: number) {
    return this.slaService.listRules(planId);
  }

  @Post(':planId/escalation-rules')
  @RequirePermissions(PERMISSIONS.ADMIN_SLA)
  @ApiOperation({ summary: 'Create an escalation rule' })
  createRule(
    @Param('planId', ParseIntPipe) planId: number,
    @Body(new ZodValidationPipe(CreateEscalationRuleSchema)) dto: CreateEscalationRuleDto,
  ) {
    return this.slaService.createRule(planId, dto);
  }

  @Put(':planId/escalation-rules/:id')
  @RequirePermissions(PERMISSIONS.ADMIN_SLA)
  @ApiOperation({ summary: 'Update an escalation rule' })
  updateRule(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(UpdateEscalationRuleSchema)) dto: UpdateEscalationRuleDto,
  ) {
    return this.slaService.updateRule(id, dto);
  }

  @Delete(':planId/escalation-rules/:id')
  @RequirePermissions(PERMISSIONS.ADMIN_SLA)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an escalation rule' })
  deleteRule(@Param('id', ParseIntPipe) id: number) {
    return this.slaService.deleteRule(id);
  }
}
