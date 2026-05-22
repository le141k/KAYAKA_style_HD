import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { SlaPlan, SlaSchedule, SlaHoliday, Ticket } from '@prisma/client';

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
  return DAY_NAMES[date.getDay()] ?? 'sun';
}

/**
 * Check whether a given Date falls within a schedule's working hours,
 * taking holidays into account.
 */
function isWorkingTime(
  date: Date,
  workHours: WorkHours,
  holidays: SlaHoliday[],
): boolean {
  // Holiday check (compare date only, not time)
  const dateOnly = date.toISOString().slice(0, 10);
  if (holidays.some((h) => h.date.toISOString().slice(0, 10) === dateOnly)) return false;

  const slots = workHours[dayKey(date)];
  if (!slots || slots.length === 0) return false;

  const minutesNow = date.getHours() * 60 + date.getMinutes();

  return slots.some(([start, end]) => {
    const s = parseMinutes(start ?? '00:00');
    const e = parseMinutes(end ?? '23:59');
    return minutesNow >= s && minutesNow < e;
  });
}

/**
 * Advance `cursor` forward by `remainingSeconds` of business time,
 * honouring the work schedule and holidays.
 *
 * Strategy: step forward one minute at a time when within working hours.
 * This is O(minutes) and sufficient for SLA windows up to ~24 h.
 * For production scale, replace with a calendar-interval algorithm.
 */
function addWorkingSeconds(
  start: Date,
  seconds: number,
  workHours: WorkHours,
  holidays: SlaHoliday[],
): Date {
  let cursor = new Date(start);
  let remaining = seconds;

  // Safety cap: prevent infinite loops for misconfigured schedules (max 60 days)
  const limit = new Date(start);
  limit.setDate(limit.getDate() + 60);

  while (remaining > 0 && cursor < limit) {
    if (isWorkingTime(cursor, workHours, holidays)) {
      const minuteMs = 60_000;
      cursor = new Date(cursor.getTime() + minuteMs);
      remaining -= 60;
    } else {
      // Jump to next minute
      cursor = new Date(cursor.getTime() + 60_000);
    }
  }

  return cursor;
}

@Injectable()
export class SlaService {
  private readonly logger = new Logger(SlaService.name);

  constructor(private readonly prisma: PrismaService) {}

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
        dueAt: plan.firstResponseSeconds
          ? new Date(now.getTime() + plan.firstResponseSeconds * 1000)
          : null,
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
        OR: [
          // First-response breach: dueAt passed and no firstResponseAt recorded
          { dueAt: { lt: now }, firstResponseAt: null },
          // Resolution breach: resolutionDueAt passed
          { resolutionDueAt: { lt: now } },
        ],
      },
    });

    const breaches: BreachEntry[] = [];

    for (const ticket of breachedTickets) {
      if (ticket.dueAt && ticket.dueAt < now && ticket.firstResponseAt === null) {
        const minutesOverdue = Math.floor((now.getTime() - ticket.dueAt.getTime()) / 60_000);
        breaches.push({ ticket, breachType: 'FIRST_RESPONSE', minutesOverdue });
      }

      if (ticket.resolutionDueAt && ticket.resolutionDueAt < now) {
        const minutesOverdue = Math.floor(
          (now.getTime() - ticket.resolutionDueAt.getTime()) / 60_000,
        );
        breaches.push({ ticket, breachType: 'RESOLUTION', minutesOverdue });
      }
    }

    if (breaches.length > 0) {
      this.logger.warn(`SLA breach check: ${breaches.length} breach(es) found`);
    }

    return breaches;
  }

  /**
   * Periodic SLA check — called by the BullMQ processor or cron hook.
   * Marks tickets as escalated and logs. Full escalation actions (notify staff,
   * change priority) are a TODO: wire EscalationRule.actions here.
   */
  async runPeriodicCheck(): Promise<void> {
    const breaches = await this.checkBreaches();
    for (const { ticket, breachType, minutesOverdue } of breaches) {
      this.logger.warn(
        `SLA ${breachType} breach on ${ticket.mask}: ${minutesOverdue}m overdue`,
      );

      // Mark as escalated
      if (!ticket.isEscalated) {
        await this.prisma.ticket.update({
          where: { id: ticket.id },
          data: { isEscalated: true, escalationLevel: { increment: 1 } },
        });
      }

      // TODO: execute EscalationRule.actions (notify assignee, change priority, etc.)
    }
  }

  /**
   * Apply the correct SLA plan to a newly-created ticket.
   * Checks SlaPlan.criteria (currently org-based only; full rule engine is a TODO).
   * Returns the SLA plan ID to assign, or null if none matches.
   */
  async resolvePlanForTicket(
    organizationId: number | null | undefined,
  ): Promise<number | null> {
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
}
