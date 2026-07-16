import { z } from 'zod';
import { optionalBoolParam } from '../../common/zod-bool.util';
import { unknownPermissions } from '../../auth/permissions';

/**
 * A list of RBAC permission keys, each of which must exist in the catalog
 * (`apps/api/src/auth/permissions.ts`). An unknown key is a client error (400)
 * rather than a silently-stored dead permission.
 */
const PermissionsArray = z
  .array(z.string())
  .default([])
  .superRefine((keys, ctx) => {
    const unknown = unknownPermissions(keys);
    if (unknown.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unknown permission key(s): ${unknown.join(', ')}`,
      });
    }
});

export const CreateStaffGroupSchema = z.object({
  title: z.string().min(1).max(100),
  isAdmin: z.boolean().default(false),
  permissions: PermissionsArray,
});
export type CreateStaffGroupDto = z.infer<typeof CreateStaffGroupSchema>;

// `isAdmin` is intentionally NOT updatable here — allowing it would let any
// holder of staff.manage escalate a group to admin (privilege escalation).
export const UpdateStaffGroupSchema = CreateStaffGroupSchema.partial().omit({ isAdmin: true });
export type UpdateStaffGroupDto = z.infer<typeof UpdateStaffGroupSchema>;

export const CreateStaffSchema = z.object({
  email: z.string().email(),
  username: z.string().min(2).max(50),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  password: z.string().min(8).max(200),
  staffGroupId: z.number().int().positive(),
  designation: z.string().max(200).default(''),
  signature: z.string().max(10_000).default(''),
  mobileNumber: z.string().max(50).default(''),
  timezone: z.string().max(64).default('UTC'),
  departmentIds: z.array(z.number().int().positive()).max(200).default([]),
});
export type CreateStaffDto = z.infer<typeof CreateStaffSchema>;

export const UpdateStaffSchema = z.object({
  email: z.string().email().optional(),
  username: z.string().min(2).max(50).optional(),
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  password: z.string().min(8).max(200).optional(),
  staffGroupId: z.number().int().positive().optional(),
  designation: z.string().max(200).optional(),
  signature: z.string().max(10_000).optional(),
  mobileNumber: z.string().max(50).optional(),
  timezone: z.string().max(64).optional(),
  departmentIds: z.array(z.number().int().positive()).max(200).optional(),
  isEnabled: z.boolean().optional(),
});
export type UpdateStaffDto = z.infer<typeof UpdateStaffSchema>;

export const ListStaffQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  groupId: z.coerce.number().int().positive().optional(),
  search: z.string().trim().max(200).optional(),
  enabled: optionalBoolParam(),
});
export type ListStaffQueryDto = z.infer<typeof ListStaffQuerySchema>;

export const ListAuditQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
});
export type ListAuditQueryDto = z.infer<typeof ListAuditQuerySchema>;
