import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import type { SlaPlan, SlaSchedule, SlaHoliday, EscalationRule, Ticket } from '@prisma/client';
import type {
  CreateSlaPlanDto,
  UpdateSlaPlanDto,
  CreateSlaScheduleDto,
  UpdateSlaScheduleDto,
  CreateSlaHolidayDto,
  UpdateSlaHolidayDto,
  CreateEscalationRuleDto,
  UpdateEscalationRuleDto,
} from './dto';

export interface DueDates {
  dueAt: Date | null;
  resolutionDueAt: Date | null;
}

export interface BreachEntry {
  ticket: Ticket;
  breachType: 'FIRST_RESPONSE' | 'RESOLUTION';
  minutesOverdue: number;
}

type WorkHours = Record<string, Array<[string, string]>>;

/** Max breached tickets processed per periodic scan — bounds memory/CPU. */
const SLA_BREACH_SCAN_CAP = 1000;

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/**
 * Parse a time string "HH:MM" into minutes-since-midnight.
 */
function parseMinutes(time: string): number {
  const [h = '0', m = '0'] = time.split(':');
  return parseInt(h, 10) * 60 + parseInt(m, 10);
}

/**
 * Return the ISO weekday key for a given Date.
 * Uses the SlaSchedule workHours convention (mon, tue, …, sun).
 */
function dayKey(date: Date): string {
  // UTC weekday — the whole working-time calc is UTC-consistent (prod runs the
  // container in UTC) so it never mixes UTC and local bases (which mis-matched holidays).
  return DAY_NAMES[date.getUTCDay()] ?? 'sun';
}

/**
 * Advance `start` forward by `seconds` of business time, honouring the work
 * schedule and holidays.
 *
 * Calendar-interval algorithm: walks day-by-day and consumes whole working
 * slots at once (O(days), bounded to 60), instead of stepping minute-by-minute
 * (the old O(minutes) loop blocked the event loop on every ticket create/reply).
 */
function addWorkingSeconds(start: Date, seconds: number, workHours: WorkHours, holidays: SlaHoliday[]): Date {
  let remaining = seconds;
  const holidaySet = new Set(holidays.map((h) => h.date.toISOString().slice(0, 10)));

  let day = new Date(start);
  for (let d = 0; d < 60 && remaining > 0; d++) {
    const isHoliday = holidaySet.has(day.toISOString().slice(0, 10));
    const slots = isHoliday ? [] : (workHours[dayKey(day)] ?? []);

    for (const [startStr, endStr] of slots) {
      const sMin = parseMinutes(startStr ?? '00:00');
      const eMin = parseMinutes(endStr ?? '23:59');
      if (eMin <= sMin) continue;

      const slotStart = new Date(day);
      slotStart.setUTCHours(0, 0, 0, 0);
      slotStart.setUTCMinutes(sMin);
      const slotEnd = new Date(day);
      slotEnd.setUTCHours(0, 0, 0, 0);
      slotEnd.setUTCMinutes(eMin);

      // On the first day, never count time before `start`.
      const windowStart = d === 0 && start > slotStart ? start : slotStart;
      if (windowStart >= slotEnd) continue;

      const availSec = Math.floor((slotEnd.getTime() - windowStart.getTime()) / 1000);
      if (remaining <= availSec) {
        return new Date(windowStart.getTime() + remaining * 1000);
      }
      remaining -= availSec;
    }

    // Advance to 00:00 (UTC) of the next day.
    day = new Date(day);
    day.setUTCHours(0, 0, 0, 0);
    day.setUTCDate(day.getUTCDate() + 1);
  }

  // Budget not exhausted within the 60-day safety cap (e.g. empty/misconfigured
  // schedule) — return the cap, matching the previous loop's fail-safe.
  return day;
}

/** Escalation action shape stored in EscalationRule.actions JSON */
interface EscalationAction {
  type: 'notify' | 'change_priority' | 'assign' | 'add_note' | 'mark_escalated';
  /** staffId for notify/assign */
  staffId?: number;
  /** priorityId for change_priority */
  priorityId?: number;
  /** note text for add_note */
  note?: string;
}

@Injectable()
export class SlaService {
  private readonly logger = new Logger(SlaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
  ) {}

  // ─────────────────── computeDueDates ───────────────────

  /**
   * Compute first-response and resolution due dates for a ticket
   * given the SLA plan and creation time.
   *
   * If the plan has no associated schedule, due dates are wall-clock (no business hours).
   */
  async computeDueDates(slaPlanId: number, now: Date): Promise<DueDates> {
    const plan = await this.prisma.slaPlan.findUnique({
      where: { id: slaPlanId },
      include: {
        schedule: {
          include: { holidays: true },
        },
      },
    });

    if (!plan || !plan.isEnabled) return { dueAt: null, resolutionDueAt: null };

    const schedule = plan.schedule;

    if (!schedule) {
      // No business-hours schedule → wall-clock offsets
      return {
        dueAt: plan.firstResponseSeconds ? new Date(now.getTime() + plan.firstResponseSeconds * 1000) : null,
        resolutionDueAt: plan.resolutionSeconds
          ? new Date(now.getTime() + plan.resolutionSeconds * 1000)
          : null,
      };
    }

    const workHours = schedule.workHours as WorkHours;
    const holidays = schedule.holidays;

    return {
      dueAt: plan.firstResponseSeconds
        ? addWorkingSeconds(now, plan.firstResponseSeconds, workHours, holidays)
        : null,
      resolutionDueAt: plan.resolutionSeconds
        ? addWorkingSeconds(now, plan.resolutionSeconds, workHours, holidays)
        : null,
    };
  }

  // ─────────────────── checkBreaches ───────────────────

  /**
   * Find all open, non-escalated tickets that have breached their SLA targets.
   * Returns a list of breach entries for the caller to act on (notify, escalate).
   *
   * Only checks tickets that are not already resolved or escalated.
   */
  async checkBreaches(): Promise<BreachEntry[]> {
    const now = new Date();

    const breachedTickets = await this.prisma.ticket.findMany({
      where: {
        isResolved: false,
        mergedIntoId: null,
        // Already-escalated tickets must be excluded, otherwise every 60s scan
        // re-fires their escalation rule actions (notify/note/assign) indefinitely.
        isEscalated: false,
        OR: [
          // First-response breach: dueAt passed and no firstResponseAt recorded
          { dueAt: { lt: now }, firstResponseAt: null },
          // Resolution breach: resolutionDueAt passed
          { resolutionDueAt: { lt: now } },
        ],
      },
      // Bound the working set so a large breach backlog can't OOM the worker;
      // the remainder is drained on subsequent scans as tickets get escalated.
      orderBy: { id: 'asc' },
      take: SLA_BREACH_SCAN_CAP,
    });

    const breaches: BreachEntry[] = [];

    for (const ticket of breachedTickets) {
      if (ticket.dueAt && ticket.dueAt < now && ticket.firstResponseAt === null) {
        const minutesOverdue = Math.floor((now.getTime() - ticket.dueAt.getTime()) / 60_000);
        breaches.push({ ticket, breachType: 'FIRST_RESPONSE', minutesOverdue });
      }

      if (ticket.resolutionDueAt && ticket.resolutionDueAt < now) {
        const minutesOverdue = Math.floor((now.getTime() - ticket.resolutionDueAt.getTime()) / 60_000);
        breaches.push({ ticket, breachType: 'RESOLUTION', minutesOverdue });
      }
    }

    if (breaches.length > 0) {
      this.logger.warn(`SLA breach check: ${breaches.length} breach(es) found`);
    }

    return breaches;
  }

  // ─────────────────── runPeriodicCheck ───────────────────

  /**
   * Periodic SLA check — called by the BullMQ processor every 60 seconds.
   * Marks tickets as escalated, then executes EscalationRule.actions.
   */
  async runPeriodicCheck(): Promise<void> {
    const breaches = await this.checkBreaches();

    // C4 — batch-load all escalation rules for the breached plans ONCE (was a
    // per-ticket query inside the loop = N+1 over up to 1000 tickets).
    const planIds = [...new Set(breaches.map((b) => b.ticket.slaPlanId).filter((id): id is number => !!id))];
    const allRules = planIds.length
      ? await this.prisma.escalationRule.findMany({
          where: { slaPlanId: { in: planIds }, isEnabled: true },
          orderBy: { thresholdSeconds: 'asc' },
        })
      : [];
    const rulesByPlan = new Map<number, EscalationRule[]>();
    for (const r of allRules) {
      const list = rulesByPlan.get(r.slaPlanId) ?? [];
      list.push(r);
      rulesByPlan.set(r.slaPlanId, list);
    }

    for (const { ticket, breachType, minutesOverdue } of breaches) {
      this.logger.warn(`SLA ${breachType} breach on ${ticket.mask}: ${minutesOverdue}m overdue`);

      // Mark as escalated
      if (!ticket.isEscalated) {
        await this.prisma.ticket.update({
          where: { id: ticket.id },
          data: { isEscalated: true, escalationLevel: { increment: 1 } },
        });
      }

      // Execute EscalationRule.actions for this ticket's SLA plan
      if (ticket.slaPlanId) {
        await this.executeEscalationRules(
          ticket,
          breachType,
          minutesOverdue,
          rulesByPlan.get(ticket.slaPlanId) ?? [],
        );
      }
    }
  }

  /**
   * Execute EscalationRule.actions for a ticket that has breached its SLA.
   * `planRules` is the pre-loaded, enabled rule set for the ticket's SLA plan.
   */
  private async executeEscalationRules(
    ticket: Ticket,
    breachType: 'FIRST_RESPONSE' | 'RESOLUTION',
    minutesOverdue: number,
    planRules: EscalationRule[],
  ): Promise<void> {
    if (!ticket.slaPlanId) return;

    const slaTargetType = breachType === 'FIRST_RESPONSE' ? 'FIRST_RESPONSE' : 'RESOLUTION';
    const thresholdSeconds = minutesOverdue * 60;

    const rules = planRules.filter(
      (r) => r.targetType === slaTargetType && r.thresholdSeconds <= thresholdSeconds,
    );

    for (const rule of rules) {
      const actions = rule.actions as unknown as EscalationAction[];
      for (const action of actions) {
        await this.executeAction(ticket, action, rule);
      }
    }
  }

  private async executeAction(ticket: Ticket, action: EscalationAction, rule: EscalationRule): Promise<void> {
    try {
      switch (action.type) {
        case 'notify': {
          // Send email notification to a specific staff member
          const staffId = action.staffId ?? ticket.ownerStaffId;
          if (staffId) {
            const staff = await this.prisma.staff.findUnique({
              where: { id: staffId },
              select: { email: true, firstName: true },
            });
            if (staff) {
              await this.mailService.sendTemplate(staff.email, 'sla_breach_internal', 'en', {
                mask: ticket.mask,
                subject: ticket.subject,
                rule: rule.name,
                staff: staff.firstName,
              });
            }
          }
          break;
        }
        case 'change_priority': {
          if (action.priorityId) {
            await this.prisma.ticket.update({
              where: { id: ticket.id },
              data: { priorityId: action.priorityId },
            });
          }
          break;
        }
        case 'assign': {
          if (action.staffId) {
            await this.prisma.ticket.update({
              where: { id: ticket.id },
              data: { ownerStaffId: action.staffId },
            });
          }
          break;
        }
        case 'add_note': {
          if (action.note) {
            await this.prisma.ticketNote.create({
              data: {
                ticketId: ticket.id,
                contents: `[SLA Escalation: ${rule.name}] ${action.note}`,
              },
            });
          }
          break;
        }
        case 'mark_escalated': {
          await this.prisma.ticket.update({
            where: { id: ticket.id },
            data: { isEscalated: true, escalationLevel: { increment: 1 } },
          });
          break;
        }
      }
    } catch (err) {
      this.logger.error(`Error executing escalation action ${action.type} on ${ticket.mask}: ${String(err)}`);
    }
  }

  // ─────────────────── resolvePlanForTicket ───────────────────

  /**
   * Apply the correct SLA plan to a newly-created ticket.
   * Checks SlaPlan.criteria (currently org-based only; full rule engine is a TODO).
   * Returns the SLA plan ID to assign, or null if none matches.
   */
  async resolvePlanForTicket(organizationId: number | null | undefined): Promise<number | null> {
    if (organizationId) {
      // Check if the org has a dedicated SLA plan
      const org = await this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { slaPlanId: true },
      });
      if (org?.slaPlanId) return org.slaPlanId;
    }

    // Fall back to the first enabled plan with empty criteria
    const defaultPlan = await this.prisma.slaPlan.findFirst({
      where: { isEnabled: true },
      orderBy: { id: 'asc' },
    });

    return defaultPlan?.id ?? null;
  }

  // ─────────────────── SlaSchedule CRUD ───────────────────

  async listSchedules(): Promise<SlaSchedule[]> {
    return this.prisma.slaSchedule.findMany({ include: { holidays: true } });
  }

  async getSchedule(id: number): Promise<SlaSchedule & { holidays: SlaHoliday[] }> {
    const s = await this.prisma.slaSchedule.findUnique({ where: { id }, include: { holidays: true } });
    if (!s) throw new NotFoundException(`SlaSchedule ${id} not found`);
    return s;
  }

  async createSchedule(dto: CreateSlaScheduleDto): Promise<SlaSchedule> {
    return this.prisma.slaSchedule.create({ data: dto });
  }

  async updateSchedule(id: number, dto: UpdateSlaScheduleDto): Promise<SlaSchedule> {
    await this.getSchedule(id);
    return this.prisma.slaSchedule.update({ where: { id }, data: dto });
  }

  async deleteSchedule(id: number): Promise<void> {
    await this.getSchedule(id);
    await this.prisma.slaSchedule.delete({ where: { id } });
  }

  // ─────────────────── SlaHoliday CRUD ───────────────────

  async listHolidays(scheduleId: number): Promise<SlaHoliday[]> {
    await this.getSchedule(scheduleId); // 404 if the parent schedule doesn't exist
    return this.prisma.slaHoliday.findMany({ where: { scheduleId } });
  }

  async createHoliday(scheduleId: number, dto: CreateSlaHolidayDto): Promise<SlaHoliday> {
    await this.getSchedule(scheduleId);
    return this.prisma.slaHoliday.create({ data: { ...dto, scheduleId } });
  }

  async updateHoliday(id: number, dto: UpdateSlaHolidayDto): Promise<SlaHoliday> {
    const h = await this.prisma.slaHoliday.findUnique({ where: { id } });
    if (!h) throw new NotFoundException(`SlaHoliday ${id} not found`);
    return this.prisma.slaHoliday.update({ where: { id }, data: dto });
  }

  async deleteHoliday(id: number): Promise<void> {
    const h = await this.prisma.slaHoliday.findUnique({ where: { id } });
    if (!h) throw new NotFoundException(`SlaHoliday ${id} not found`);
    await this.prisma.slaHoliday.delete({ where: { id } });
  }

  // ─────────────────── SlaPlan CRUD ───────────────────

  async listPlans(): Promise<SlaPlan[]> {
    return this.prisma.slaPlan.findMany({ include: { escalationRules: true } });
  }

  async getPlan(id: number): Promise<SlaPlan & { escalationRules: EscalationRule[] }> {
    const p = await this.prisma.slaPlan.findUnique({
      where: { id },
      include: { escalationRules: true },
    });
    if (!p) throw new NotFoundException(`SlaPlan ${id} not found`);
    return p;
  }

  async createPlan(dto: CreateSlaPlanDto): Promise<SlaPlan> {
    return this.prisma.slaPlan.create({
      data: {
        title: dto.title,
        isEnabled: dto.isEnabled,
        criteria: dto.criteria as object,
        firstResponseSeconds: dto.firstResponseSeconds ?? null,
        resolutionSeconds: dto.resolutionSeconds ?? null,
        scheduleId: dto.scheduleId ?? null,
      },
    });
  }

  async updatePlan(id: number, dto: UpdateSlaPlanDto): Promise<SlaPlan> {
    await this.getPlan(id);
    return this.prisma.slaPlan.update({
      where: { id },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.isEnabled !== undefined && { isEnabled: dto.isEnabled }),
        ...(dto.criteria !== undefined && { criteria: dto.criteria as object }),
        ...(dto.firstResponseSeconds !== undefined && { firstResponseSeconds: dto.firstResponseSeconds }),
        ...(dto.resolutionSeconds !== undefined && { resolutionSeconds: dto.resolutionSeconds }),
        ...(dto.scheduleId !== undefined && { scheduleId: dto.scheduleId }),
      },
    });
  }

  async deletePlan(id: number): Promise<void> {
    await this.getPlan(id);
    await this.prisma.slaPlan.delete({ where: { id } });
  }

  // ─────────────────── EscalationRule CRUD ───────────────────

  async listRules(slaPlanId: number): Promise<EscalationRule[]> {
    await this.getPlan(slaPlanId); // 404 if the parent plan doesn't exist
    return this.prisma.escalationRule.findMany({ where: { slaPlanId } });
  }

  async getRule(id: number): Promise<EscalationRule> {
    const r = await this.prisma.escalationRule.findUnique({ where: { id } });
    if (!r) throw new NotFoundException(`EscalationRule ${id} not found`);
    return r;
  }

  async createRule(slaPlanId: number, dto: CreateEscalationRuleDto): Promise<EscalationRule> {
    await this.getPlan(slaPlanId);
    return this.prisma.escalationRule.create({
      data: { ...dto, slaPlanId, actions: dto.actions as object },
    });
  }

  async updateRule(id: number, dto: UpdateEscalationRuleDto): Promise<EscalationRule> {
    await this.getRule(id);
    return this.prisma.escalationRule.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.targetType !== undefined && { targetType: dto.targetType }),
        ...(dto.thresholdSeconds !== undefined && { thresholdSeconds: dto.thresholdSeconds }),
        ...(dto.actions !== undefined && { actions: dto.actions as object }),
        ...(dto.isEnabled !== undefined && { isEnabled: dto.isEnabled }),
      },
    });
  }

  async deleteRule(id: number): Promise<void> {
    await this.getRule(id);
    await this.prisma.escalationRule.delete({ where: { id } });
  }
}
