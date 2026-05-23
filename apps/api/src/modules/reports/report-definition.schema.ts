/**
 * Safe, declarative report definition schema (Zod).
 * All field names are whitelist-checked — no raw SQL or injection possible.
 */
import { z } from 'zod';

// ─── Sources ──────────────────────────────────────────────────────────────────

export const SOURCES = ['tickets', 'ticketPosts', 'ticketAuditLogs'] as const;
export type ReportSource = (typeof SOURCES)[number];

// ─── Filterable fields per source ─────────────────────────────────────────────

export const FILTERABLE_FIELDS: Record<ReportSource, readonly string[]> = {
  tickets: [
    'statusId',
    'priorityId',
    'departmentId',
    'typeId',
    'ownerStaffId',
    'userId',
    'creationMode',
    'isResolved',
    'isEscalated',
    'createdAt',
    'resolvedAt',
    'firstResponseAt',
    'lastActivityAt',
    'dueAt',
  ],
  ticketPosts: ['ticketId', 'staffId', 'userId', 'authorType', 'creationMode', 'createdAt'],
  ticketAuditLogs: ['ticketId', 'staffId', 'actorType', 'action', 'createdAt'],
};

// ─── Groupable fields per source (with bucket notation) ───────────────────────

export const GROUPABLE_FIELDS: Record<ReportSource, readonly string[]> = {
  tickets: [
    'statusId',
    'priorityId',
    'departmentId',
    'typeId',
    'ownerStaffId',
    'creationMode',
    'isResolved',
    'createdAt:day',
    'createdAt:week',
    'createdAt:month',
    'resolvedAt:day',
    'resolvedAt:week',
    'resolvedAt:month',
  ],
  ticketPosts: [
    'staffId',
    'authorType',
    'creationMode',
    'createdAt:day',
    'createdAt:week',
    'createdAt:month',
  ],
  ticketAuditLogs: ['staffId', 'actorType', 'action', 'createdAt:day', 'createdAt:week', 'createdAt:month'],
};

// ─── Numeric / aggregate-able fields ──────────────────────────────────────────

export const NUMERIC_FIELDS: readonly string[] = [
  'totalReplies',
  'escalationLevel',
  'firstResponseSeconds', // computed: firstResponseAt - createdAt
  'resolutionSeconds', // computed: resolvedAt - createdAt
];

export const COMPUTED_FIELDS: readonly string[] = ['firstResponseSeconds', 'resolutionSeconds'];

// ─── Filter operators ─────────────────────────────────────────────────────────

const RELATIVE_DATE_TOKENS = [
  'today',
  'yesterday',
  'thisWeek',
  'lastWeek',
  'thisMonth',
  'lastMonth',
  'last7days',
  'last30days',
  'last90days',
  'thisYear',
  'lastQuarter',
] as const;
export type RelativeDateToken = (typeof RELATIVE_DATE_TOKENS)[number];

// A date value: either a relative token or an ISO 8601 string
const DateValueSchema = z.union([z.enum(RELATIVE_DATE_TOKENS), z.string().datetime()]);

const FilterSchema = z.discriminatedUnion('op', [
  z.object({ field: z.string(), op: z.literal('eq'), value: z.union([z.string(), z.number(), z.boolean()]) }),
  z.object({
    field: z.string(),
    op: z.literal('neq'),
    value: z.union([z.string(), z.number(), z.boolean()]),
  }),
  z.object({ field: z.string(), op: z.literal('in'), value: z.array(z.union([z.string(), z.number()])) }),
  z.object({ field: z.string(), op: z.literal('notIn'), value: z.array(z.union([z.string(), z.number()])) }),
  z.object({ field: z.string(), op: z.literal('lt'), value: DateValueSchema }),
  z.object({ field: z.string(), op: z.literal('lte'), value: DateValueSchema }),
  z.object({ field: z.string(), op: z.literal('gt'), value: DateValueSchema }),
  z.object({ field: z.string(), op: z.literal('gte'), value: DateValueSchema }),
  z.object({
    field: z.string(),
    op: z.literal('between'),
    from: DateValueSchema,
    to: DateValueSchema,
  }),
]);

export type ReportFilter = z.infer<typeof FilterSchema>;

// ─── Aggregates ───────────────────────────────────────────────────────────────

const AggregateSchema = z
  .object({
    func: z.enum(['count', 'avg', 'sum', 'min', 'max']),
    field: z.string().optional(), // required for avg/sum/min/max
    alias: z.string().optional(),
  })
  .refine((a) => a.func === 'count' || (a.field !== undefined && a.field !== ''), {
    message: 'field is required for avg/sum/min/max aggregates',
  });

export type ReportAggregate = z.infer<typeof AggregateSchema>;

// ─── OrderBy ──────────────────────────────────────────────────────────────────

const OrderBySchema = z.object({
  field: z.string(),
  dir: z.enum(['asc', 'desc']).default('asc'),
});

// ─── Top-level definition ─────────────────────────────────────────────────────

export const ReportDefinitionSchema = z
  .object({
    source: z.enum(SOURCES),
    filters: z.array(FilterSchema).default([]),
    groupBy: z.array(z.string()).max(3, 'groupBy cannot have more than 3 fields').default([]),
    aggregates: z
      .array(AggregateSchema)
      .min(1)
      .max(5)
      .default([{ func: 'count' }]),
    orderBy: z.array(OrderBySchema).optional(),
    limit: z.number().int().min(1).max(1000).default(100),
  })
  .superRefine((def, ctx) => {
    // Validate each filter field against whitelist
    const allowed = FILTERABLE_FIELDS[def.source];
    for (const f of def.filters) {
      if (!allowed.includes(f.field)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Filter field "${f.field}" is not allowed for source "${def.source}"`,
          path: ['filters'],
        });
      }
    }
    // Validate groupBy fields
    const allowedGroup = GROUPABLE_FIELDS[def.source];
    for (const g of def.groupBy) {
      if (!allowedGroup.includes(g)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `groupBy field "${g}" is not allowed for source "${def.source}"`,
          path: ['groupBy'],
        });
      }
    }
    // Validate aggregate fields
    for (const agg of def.aggregates) {
      if (agg.func !== 'count' && agg.field) {
        if (!NUMERIC_FIELDS.includes(agg.field)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Aggregate field "${agg.field}" is not in the numeric fields whitelist`,
            path: ['aggregates'],
          });
        }
      }
    }
  });

export type ReportDefinition = z.infer<typeof ReportDefinitionSchema>;
