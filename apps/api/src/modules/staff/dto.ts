import { z } from 'zod';

export const CreateStaffGroupSchema = z.object({
  title: z.string().min(1).max(100),
  isAdmin: z.boolean().default(false),
  permissions: z.array(z.string()).default([]),
});
export type CreateStaffGroupDto = z.infer<typeof CreateStaffGroupSchema>;

export const UpdateStaffGroupSchema = CreateStaffGroupSchema.partial();
export type UpdateStaffGroupDto = z.infer<typeof UpdateStaffGroupSchema>;

export const CreateStaffSchema = z.object({
  email: z.string().email(),
  username: z.string().min(2).max(50),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  password: z.string().min(8),
  staffGroupId: z.number().int().positive(),
  designation: z.string().default(''),
  signature: z.string().default(''),
  mobileNumber: z.string().default(''),
  timezone: z.string().default('UTC'),
  departmentIds: z.array(z.number().int().positive()).default([]),
});
export type CreateStaffDto = z.infer<typeof CreateStaffSchema>;

export const UpdateStaffSchema = z.object({
  email: z.string().email().optional(),
  username: z.string().min(2).max(50).optional(),
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  password: z.string().min(8).optional(),
  staffGroupId: z.number().int().positive().optional(),
  designation: z.string().optional(),
  signature: z.string().optional(),
  mobileNumber: z.string().optional(),
  timezone: z.string().optional(),
  departmentIds: z.array(z.number().int().positive()).optional(),
});
export type UpdateStaffDto = z.infer<typeof UpdateStaffSchema>;

export const ListStaffQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  groupId: z.coerce.number().int().positive().optional(),
  search: z.string().optional(),
  enabled: z.coerce.boolean().optional(),
});
export type ListStaffQueryDto = z.infer<typeof ListStaffQuerySchema>;
