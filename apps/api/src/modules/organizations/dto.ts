import { z } from 'zod';

export const CreateOrganizationSchema = z.object({
  name: z.string().min(1).max(200),
  address: z.string().default(''),
  city: z.string().default(''),
  state: z.string().default(''),
  postalCode: z.string().default(''),
  country: z.string().default(''),
  phone: z.string().default(''),
  website: z.string().default(''),
  slaPlanId: z.number().int().positive().optional(),
  customFields: z.record(z.unknown()).default({}),
});
export type CreateOrganizationDto = z.infer<typeof CreateOrganizationSchema>;

export const UpdateOrganizationSchema = CreateOrganizationSchema.partial();
export type UpdateOrganizationDto = z.infer<typeof UpdateOrganizationSchema>;

export const ListOrganizationsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  search: z.string().trim().max(200).optional(),
});
export type ListOrganizationsQueryDto = z.infer<typeof ListOrganizationsQuerySchema>;
