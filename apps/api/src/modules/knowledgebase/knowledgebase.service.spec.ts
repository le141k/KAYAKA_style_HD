import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { KnowledgebaseService } from './knowledgebase.service';
import type { PrismaService } from '../../prisma/prisma.service';

function makePrismaMock() {
  return {
    kbCategory: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    kbArticle: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    kbArticleRevision: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
  } as unknown as PrismaService;
}

const MOCK_ARTICLE = {
  id: 1,
  title: 'Getting Started',
  slug: 'getting-started',
  categoryId: 1,
  contents: '<p>Hello <b>World</b></p>',
  contentsText: 'Hello World',
  isPublished: true,
  views: 0,
  authorStaffId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const MOCK_CATEGORY = {
  id: 1,
  title: 'General',
  displayOrder: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('KnowledgebaseService', () => {
  let service: KnowledgebaseService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new KnowledgebaseService(prisma as unknown as PrismaService);
  });

  // ─── listCategories ──────────────────────────────────────────────────────────

  describe('listCategories', () => {
    it('returns all categories ordered by displayOrder', async () => {
      (prisma.kbCategory.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([MOCK_CATEGORY]);
      const result = await service.listCategories();
      expect(result).toHaveLength(1);
      expect(prisma.kbCategory.findMany).toHaveBeenCalledWith({ orderBy: { displayOrder: 'asc' } });
    });
  });

  // ─── createCategory ──────────────────────────────────────────────────────────

  describe('createCategory', () => {
    it('creates a new category', async () => {
      (prisma.kbCategory.create as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_CATEGORY);
      const result = await service.createCategory({ title: 'General', displayOrder: 1 } as any);
      expect(result.title).toBe('General');
    });
  });

  // ─── listArticles ────────────────────────────────────────────────────────────

  describe('listArticles', () => {
    it('returns paginated articles with total', async () => {
      (prisma.kbArticle.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([MOCK_ARTICLE]);
      (prisma.kbArticle.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

      const result = await service.listArticles({ page: 1, pageSize: 10 } as any);
      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
    });

    it('filters by categoryId when provided', async () => {
      (prisma.kbArticle.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.kbArticle.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      await service.listArticles({ page: 1, pageSize: 10, categoryId: 5 } as any);

      expect(prisma.kbArticle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ categoryId: 5 }) }),
      );
    });

    it('filters published-only when publishedOnly is true', async () => {
      (prisma.kbArticle.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.kbArticle.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      await service.listArticles({ page: 1, pageSize: 10, publishedOnly: true } as any);

      expect(prisma.kbArticle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ isPublished: true }) }),
      );
    });

    it('applies full-text search query when q is provided', async () => {
      (prisma.kbArticle.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.kbArticle.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      await service.listArticles({ page: 1, pageSize: 10, q: 'getting started' } as any);

      expect(prisma.kbArticle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ OR: expect.any(Array) }) }),
      );
    });
  });

  // ─── getArticle ──────────────────────────────────────────────────────────────

  describe('getArticle', () => {
    it('returns article when found', async () => {
      (prisma.kbArticle.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_ARTICLE);
      const result = await service.getArticle(1);
      expect(result.slug).toBe('getting-started');
    });

    it('throws NotFoundException when article not found', async () => {
      (prisma.kbArticle.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.getArticle(99)).rejects.toThrow(NotFoundException);
    });
  });

  // ─── getArticleBySlug ────────────────────────────────────────────────────────

  describe('getArticleBySlug', () => {
    it('increments view counter and returns article', async () => {
      (prisma.kbArticle.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_ARTICLE);
      (prisma.kbArticle.update as ReturnType<typeof vi.fn>).mockResolvedValue({ ...MOCK_ARTICLE, views: 1 });

      const result = await service.getArticleBySlug('getting-started');
      expect(result.id).toBe(1);
      expect(prisma.kbArticle.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { views: { increment: 1 } } }),
      );
    });

    it('throws NotFoundException when slug not found', async () => {
      (prisma.kbArticle.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.getArticleBySlug('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── createArticle ───────────────────────────────────────────────────────────

  describe('createArticle', () => {
    it('creates an article with computed slug and plain-text content', async () => {
      (prisma.kbArticle.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null); // no slug collision
      (prisma.kbArticle.create as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_ARTICLE);

      const result = await service.createArticle(
        { title: 'Getting Started', categoryId: 1, contents: '<p>Hello <b>World</b></p>', isPublished: true },
        42,
      );

      expect(result.id).toBe(1);
      expect(prisma.kbArticle.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            slug: expect.stringContaining('getting-started'),
            contentsText: expect.stringContaining('Hello'),
            authorStaffId: 42,
          }),
        }),
      );
    });

    it('appends timestamp suffix when slug is already taken', async () => {
      // First findUnique (slug check) returns existing article (collision)
      // Then create is called
      (prisma.kbArticle.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 99,
        slug: 'getting-started',
      }); // slug taken
      (prisma.kbArticle.create as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_ARTICLE);

      await service.createArticle({
        title: 'Getting Started',
        categoryId: 1,
        contents: '<p>text</p>',
        isPublished: true,
      });

      const callArg = (prisma.kbArticle.create as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      // slug should have a suffix appended
      expect(callArg.data.slug).toMatch(/getting-started-.+/);
    });

    it('strips HTML tags for contentsText', async () => {
      (prisma.kbArticle.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (prisma.kbArticle.create as ReturnType<typeof vi.fn>).mockImplementation(({ data }) =>
        Promise.resolve({ ...MOCK_ARTICLE, contentsText: data.contentsText }),
      );

      const result = await service.createArticle({
        title: 'Test',
        categoryId: 1,
        contents: '<style>body{}</style><p>Plain <b>text</b> here</p>',
        isPublished: false,
      });

      const callArg = (prisma.kbArticle.create as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(callArg.data.contentsText).not.toContain('<');
      expect(callArg.data.contentsText).not.toContain('body{}');
    });
  });

  // ─── updateArticle ───────────────────────────────────────────────────────────

  describe('updateArticle', () => {
    it('snapshots previous content as revision, then updates', async () => {
      (prisma.kbArticle.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_ARTICLE);
      (prisma.kbArticleRevision.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (prisma.kbArticle.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...MOCK_ARTICLE,
        title: 'Updated',
      });

      const result = await service.updateArticle(1, { title: 'Updated' }, 5);

      expect(prisma.kbArticleRevision.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ articleId: 1, editedByStaffId: 5 }),
        }),
      );
      expect(result.title).toBe('Updated');
    });

    it('throws NotFoundException when article not found', async () => {
      (prisma.kbArticle.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.updateArticle(99, { title: 'X' })).rejects.toThrow(NotFoundException);
    });

    it('updates contentsText when new contents provided', async () => {
      (prisma.kbArticle.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_ARTICLE);
      (prisma.kbArticleRevision.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (prisma.kbArticle.update as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_ARTICLE);

      await service.updateArticle(1, { contents: '<p>New content</p>' });

      expect(prisma.kbArticle.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ contentsText: expect.stringContaining('New content') }),
        }),
      );
    });
  });

  // ─── listRevisions ───────────────────────────────────────────────────────────

  describe('listRevisions', () => {
    it('returns revisions for an existing article', async () => {
      (prisma.kbArticle.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_ARTICLE);
      (prisma.kbArticleRevision.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 1 }]);

      const result = await service.listRevisions(1);
      expect(result).toHaveLength(1);
    });

    it('throws NotFoundException when article does not exist', async () => {
      (prisma.kbArticle.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.listRevisions(99)).rejects.toThrow(NotFoundException);
    });
  });
});
