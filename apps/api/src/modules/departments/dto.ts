import { z } from 'zod';

export const CreateDepartmentSchema = z.object({
  title: z.string().min(1).max(200),
  type: z.enum(['PUBLIC', 'PRIVATE']).default('PUBLIC'),
  app: z.string().default('tickets'),
  isDefault: z.boolean().default(false),
  displayOrder: z.number().int().default(0),
  parentId: z.number().int().positive().optional(),
});
export type CreateDepartmentDto = z.infer<typeof CreateDepartmentSchema>;

export const UpdateDepartmentSchema = CreateDepartmentSchema.partial();
export type UpdateDepartmentDto = z.infer<typeof UpdateDepartmentSchema>;
