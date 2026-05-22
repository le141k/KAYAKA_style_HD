import { z } from 'zod';

// ─────────────────── SlaSchedule ───────────────────

export const CreateSlaScheduleSchema = z.object({
  title: z.string().min(1).max(200),
  workHours: z.record(z.array(z.tuple([z.string(), z.string()]))).default({}),
});
export type CreateSlaScheduleDto = z.infer<typeof CreateSlaScheduleSchema>;

export const UpdateSlaScheduleSchema = CreateSlaScheduleSchema.partial();
export type UpdateSlaScheduleDto = z.infer<typeof UpdateSlaScheduleSchema>;

// ─────────────────── SlaHoliday ───────────────────

export const CreateSlaHolidaySchema = z.object({
  title: z.string().min(1).max(200),
  date: z.coerce.date(),
});
export type CreateSlaHolidayDto = z.infer<typeof CreateSlaHolidaySchema>;

export const UpdateSlaHolidaySchema = CreateSlaHolidaySchema.partial();
export type UpdateSlaHolidayDto = z.infer<typeof UpdateSlaHolidaySchema>;

// ─────────────────── SlaPlan ───────────────────

export const CreateSlaPlanSchema = z.object({
  title: z.string().min(1).max(200),
  isEnabled: z.boolean().default(true),
  criteria: z.array(z.unknown()).default([]),
  firstResponseSeconds: z.number().int().positive().nullable().optional(),
  resolutionSeconds: z.number().int().positive().nullable().optional(),
  scheduleId: z.number().int().positive().nullable().optional(),
});
export type CreateSlaPlanDto = z.infer<typeof CreateSlaPlanSchema>;

export const UpdateSlaPlanSchema = CreateSlaPlanSchema.partial();
export type UpdateSlaPlanDto = z.infer<typeof UpdateSlaPlanSchema>;

// ─────────────────── EscalationRule ───────────────────

export const CreateEscalationRuleSchema = z.object({
  name: z.string().min(1).max(200),
  targetType: z.enum(['FIRST_RESPONSE', 'RESOLUTION']),
  thresholdSeconds: z.number().int().nonnegative(),
  actions: z.array(z.unknown()).default([]),
  isEnabled: z.boolean().default(true),
});
export type CreateEscalationRuleDto = z.infer<typeof CreateEscalationRuleSchema>;

export const UpdateEscalationRuleSchema = CreateEscalationRuleSchema.partial();
export type UpdateEscalationRuleDto = z.infer<typeof UpdateEscalationRuleSchema>;
