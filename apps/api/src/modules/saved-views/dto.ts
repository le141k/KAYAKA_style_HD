import { z } from 'zod';

// Free-form list-filter state, e.g. { status, priority, departmentId, ... }.
// Kept permissive: any JSON-serialisable record of values.
export const CreateSavedViewSchema = z.object({
  name: z.string().min(1).max(120),
  filters: z.record(z.unknown()),
});
export type CreateSavedViewDto = z.infer<typeof CreateSavedViewSchema>;
