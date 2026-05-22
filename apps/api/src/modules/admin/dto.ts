import { z } from 'zod';

// ─────────────────── CustomFieldGroup ───────────────────

export const CreateCustomFieldGroupSchema = z.object({
  title: z.string().min(1).max(200),
  scope: z.enum(['TICKET', 'USER', 'STAFF', 'ORGANIZATION']),
  displayOrder: z.number().int().nonnegative().default(0),
});
export type CreateCustomFieldGroupDto = z.infer<typeof CreateCustomFieldGroupSchema>;

export const UpdateCustomFieldGroupSchema = CreateCustomFieldGroupSchema.partial();
export type UpdateCustomFieldGroupDto = z.infer<typeof UpdateCustomFieldGroupSchema>;

// ─────────────────── CustomField ───────────────────

export const CreateCustomFieldSchema = z.object({
  fieldKey: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9_]+$/, 'fieldKey must be lowercase alphanumeric or underscore'),
  title: z.string().min(1).max(200),
  type: z.enum([
    'TEXT',
    'TEXTAREA',
    'PASSWORD',
    'CHECKBOX',
    'RADIO',
    'SELECT',
    'MULTISELECT',
    'DATE',
    'FILE',
    'CUSTOM',
  ]),
  isRequired: z.boolean().default(false),
  isEncrypted: z.boolean().default(false),
  options: z.array(z.unknown()).default([]),
  displayOrder: z.number().int().nonnegative().default(0),
});
export type CreateCustomFieldDto = z.infer<typeof CreateCustomFieldSchema>;

export const UpdateCustomFieldSchema = CreateCustomFieldSchema.partial().omit({ fieldKey: true });
export type UpdateCustomFieldDto = z.infer<typeof UpdateCustomFieldSchema>;

// ─────────────────── EmailTemplate ───────────────────

export const CreateEmailTemplateSchema = z.object({
  key: z.string().min(1).max(100),
  locale: z.string().min(2).max(10).default('en'),
  subject: z.string().min(1),
  htmlBody: z.string().min(1),
  textBody: z.string().default(''),
});
export type CreateEmailTemplateDto = z.infer<typeof CreateEmailTemplateSchema>;

export const UpdateEmailTemplateSchema = CreateEmailTemplateSchema.partial().omit({
  key: true,
  locale: true,
});
export type UpdateEmailTemplateDto = z.infer<typeof UpdateEmailTemplateSchema>;
