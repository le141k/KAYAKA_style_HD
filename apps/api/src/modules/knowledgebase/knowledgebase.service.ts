import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { sanitizeRichHtml } from '../../common/html-sanitize.util';
import type { CreateArticleDto, CreateCategoryDto, ListArticlesDto, UpdateArticleDto } from './dto';

/** Strips HTML to a plaintext blob used for search + previews. */
function toPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9Ѐ-ӿ]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return base || 'article';
}

@Injectable()
export class KnowledgebaseService {
  constructor(private readonly prisma: PrismaService) {}

  // ── categories ──
  async listCategories(publishedOnly = false) {
    const rows = await this.prisma.kbCategory.findMany({
      // Public callers must not see unpublished/draft categories.
      where: publishedOnly ? { isPublished: true } : {},
      orderBy: { displayOrder: 'asc' },
      include: {
        _count: {
          select: { articles: publishedOnly ? { where: { isPublished: true } } : true },
        },
      },
    });
    return rows.map((c) => ({
      id: c.id,
      title: c.title,
      displayOrder: c.displayOrder,
      isPublished: c.isPublished,
      parentId: c.parentId,
      article_count: c._count.articles,
    }));
  }

  createCategory(dto: CreateCategoryDto) {
    return this.prisma.kbCategory.create({ data: dto });
  }

  // ── articles ──
  async listArticles(dto: ListArticlesDto) {
    const where = {
      ...(dto.categoryId ? { categoryId: dto.categoryId } : {}),
      ...(dto.publishedOnly ? { isPublished: true } : {}),
      ...(dto.q
        ? {
            OR: [
              { title: { contains: dto.q, mode: 'insensitive' as const } },
              { contentsText: { contains: dto.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.kbArticle.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (dto.page - 1) * dto.pageSize,
        take: dto.pageSize,
        select: {
          id: true,
          title: true,
          slug: true,
          categoryId: true,
          category: { select: { title: true } },
          isPublished: true,
          views: true,
          updatedAt: true,
          contentsText: true,
        },
      }),
      this.prisma.kbArticle.count({ where }),
    ]);
    return { items, total, page: dto.page, pageSize: dto.pageSize };
  }

  async getArticle(id: number) {
    const article = await this.prisma.kbArticle.findUnique({
      where: { id },
      include: { category: { select: { title: true } } },
    });
    if (!article) throw new NotFoundException('Article not found');
    return article;
  }

  async getArticleBySlug(slug: string) {
    const article = await this.prisma.kbArticle.findUnique({
      where: { slug },
      include: { category: { select: { title: true } } },
    });
    if (!article || !article.isPublished) throw new NotFoundException('Article not found');
    await this.prisma.kbArticle.update({ where: { id: article.id }, data: { views: { increment: 1 } } });
    return article;
  }

  async createArticle(dto: CreateArticleDto, authorStaffId?: number) {
    let slug = slugify(dto.title);
    // ensure unique slug
    if (await this.prisma.kbArticle.findUnique({ where: { slug } }))
      slug = `${slug}-${Date.now().toString(36)}`;
    // Sanitize the staff-authored HTML before storing (stored-XSS defense).
    const contents = sanitizeRichHtml(dto.contents);
    return this.prisma.kbArticle.create({
      data: {
        title: dto.title,
        slug,
        categoryId: dto.categoryId,
        contents,
        contentsText: toPlainText(contents),
        isPublished: dto.isPublished,
        authorStaffId,
      },
    });
  }

  async updateArticle(id: number, dto: UpdateArticleDto, editedByStaffId?: number) {
    const existing = await this.getArticle(id);
    // snapshot previous content as a revision
    await this.prisma.kbArticleRevision.create({
      data: { articleId: id, contents: existing.contents, editedByStaffId },
    });
    const sanitized = dto.contents !== undefined ? sanitizeRichHtml(dto.contents) : undefined;
    return this.prisma.kbArticle.update({
      where: { id },
      data: {
        ...(dto.title ? { title: dto.title } : {}),
        ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId } : {}),
        ...(sanitized !== undefined ? { contents: sanitized, contentsText: toPlainText(sanitized) } : {}),
        ...(dto.isPublished !== undefined ? { isPublished: dto.isPublished } : {}),
      },
    });
  }

  async listRevisions(articleId: number) {
    await this.getArticle(articleId);
    return this.prisma.kbArticleRevision.findMany({ where: { articleId }, orderBy: { createdAt: 'desc' } });
  }
}
