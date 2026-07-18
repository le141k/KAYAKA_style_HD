import { z } from 'zod';
import { normalizeEmail } from '../../common/email.util';

const NormalizedEmailSchema = z.string().transform(normalizeEmail).pipe(z.string().email());

export const CreateUserSchema = z.object({
  fullName: z.string().min(1).max(200),
  primaryEmail: NormalizedEmailSchema,
  additionalEmails: z.array(NormalizedEmailSchema).default([]),
  phone: z.string().default(''),
  designation: z.string().default(''),
  organizationId: z.number().int().positive().optional(),
  userGroupId: z.number().int().positive().optional(),
  timezone: z.string().default('UTC'),
  customFields: z.record(z.unknown()).default({}),
});
export type CreateUserDto = z.infer<typeof CreateUserSchema>;

export const UpdateUserSchema = z.object({
  fullName: z.string().min(1).max(200).optional(),
  phone: z.string().optional(),
  designation: z.string().optional(),
  organizationId: z.number().int().positive().nullable().optional(),
  userGroupId: z.number().int().positive().nullable().optional(),
  timezone: z.string().optional(),
  isEnabled: z.boolean().optional(),
  isValidated: z.boolean().optional(),
  customFields: z.record(z.unknown()).optional(),
});
export type UpdateUserDto = z.infer<typeof UpdateUserSchema>;

export const ListUsersQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  search: z.string().trim().max(200).optional(),
  organizationId: z.coerce.number().int().positive().optional(),
  email: NormalizedEmailSchema.optional(),
});
export type ListUsersQueryDto = z.infer<typeof ListUsersQuerySchema>;

export const AddEmailSchema = z.object({
  email: NormalizedEmailSchema,
  isPrimary: z.boolean().default(false),
});
export type AddEmailDto = z.infer<typeof AddEmailSchema>;
