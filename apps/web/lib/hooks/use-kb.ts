'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { KBArticle, KBCategory, User } from '@/lib/types';

// ─── API response shapes (backend) → mapped to the frontend view models ───
interface ApiCategory {
  id: number;
  title: string;
  article_count?: number;
}
interface ApiArticle {
  id: number;
  title: string;
  slug: string;
  contents?: string;
  contentsText?: string;
  categoryId?: number | null;
  category?: { title: string } | null;
  views?: number;
  createdAt?: string;
  updatedAt?: string;
}

const PLACEHOLDER_AUTHOR = {
  id: 0,
  name: '23 Telecom',
  email: 'support@23telecom.example',
} as unknown as User;

function mapCategory(c: ApiCategory): KBCategory {
  return { id: c.id, name: c.title, description: '', article_count: c.article_count ?? 0 };
}

function mapArticle(a: ApiArticle): KBArticle {
  // List endpoint returns contentsText (plaintext). Detail endpoint returns contents (HTML).
  // body holds the HTML when available (for article detail rendering), or a plaintext
  // snippet (≤120 chars) when only contentsText is available (list card preview).
  const body = a.contents ?? (a.contentsText ? a.contentsText.slice(0, 120) : '');
  // Category name: real title when present, "Общее" as the default otherwise (KB-4 fix —
  // the previous logic was inverted: `a.categoryId ? '' : 'Общее'` blanked categorised
  // articles whenever the embedded category title wasn't expanded by the endpoint).
  const categoryName = a.category?.title ?? 'Общее';
  return {
    id: a.id,
    slug: a.slug,
    title: a.title,
    body,
    category: { id: a.categoryId ?? 0, name: categoryName, description: '', article_count: 0 },
    author: PLACEHOLDER_AUTHOR,
    created_at: a.createdAt ?? a.updatedAt ?? new Date().toISOString(),
    views: a.views ?? 0,
  };
}

export function useKBCategories() {
  return useQuery({
    queryKey: ['kb', 'categories'],
    queryFn: async () => {
      const data = await api.get<ApiCategory[]>('/kb/categories');
      return data.map(mapCategory);
    },
    staleTime: 5 * 60_000,
  });
}

export function useKBArticles(categoryId?: number, q?: string) {
  return useQuery({
    queryKey: ['kb', 'articles', { categoryId, q }],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (categoryId) params.set('categoryId', String(categoryId));
      if (q) params.set('q', q);
      params.set('publishedOnly', 'true');
      const res = await api.get<{ items: ApiArticle[] }>(`/kb/articles?${params}`);
      return (res.items ?? []).map(mapArticle);
    },
    staleTime: 5 * 60_000,
  });
}

export function useKBArticle(slug: string) {
  return useQuery({
    queryKey: ['kb', 'article', slug],
    queryFn: async () => mapArticle(await api.get<ApiArticle>(`/kb/articles/slug/${slug}`)),
    enabled: !!slug,
  });
}
