import { z } from 'zod';

export const CreateCategorySchema = z.object({
  title: z.string().min(1),
  parentId: z.number().int().positive().optional(),
  displayOrder: z.number().int().default(0),
  isPublished: z.boolean().default(true),
});
export type CreateCategoryDto = z.infer<typeof CreateCategorySchema>;

export const CreateArticleSchema = z.object({
  title: z.string().min(1),
  categoryId: z.number().int().positive().optional(),
  contents: z.string().min(1),
  isPublished: z.boolean().default(false),
});
export type CreateArticleDto = z.infer<typeof CreateArticleSchema>;

export const UpdateArticleSchema = CreateArticleSchema.partial();
export type UpdateArticleDto = z.infer<typeof UpdateArticleSchema>;

export const ListArticlesSchema = z.object({
  q: z.string().optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  publishedOnly: z.coerce.boolean().default(false),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListArticlesDto = z.infer<typeof ListArticlesSchema>;
