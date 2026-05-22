"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { KBArticle, KBCategory } from "@/lib/types";
import { MOCK_KB_ARTICLES, MOCK_KB_CATEGORIES } from "@/lib/mock-data";

export function useKBCategories() {
  return useQuery({
    queryKey: ["kb", "categories"],
    queryFn: async () => {
      try {
        return await api.get<KBCategory[]>("/kb/categories");
      } catch {
        return MOCK_KB_CATEGORIES;
      }
    },
    staleTime: 5 * 60_000,
  });
}

export function useKBArticles(categoryId?: number, q?: string) {
  return useQuery({
    queryKey: ["kb", "articles", { categoryId, q }],
    queryFn: async () => {
      try {
        const params = new URLSearchParams();
        if (categoryId) params.set("category_id", String(categoryId));
        if (q) params.set("q", q);
        return await api.get<KBArticle[]>(`/kb/articles?${params}`);
      } catch {
        let data = [...MOCK_KB_ARTICLES];
        if (categoryId) data = data.filter((a) => a.category.id === categoryId);
        if (q) {
          const lq = q.toLowerCase();
          data = data.filter((a) => a.title.toLowerCase().includes(lq));
        }
        return data;
      }
    },
    staleTime: 5 * 60_000,
  });
}

export function useKBArticle(slug: string) {
  return useQuery({
    queryKey: ["kb", "article", slug],
    queryFn: async () => {
      try {
        return await api.get<KBArticle>(`/kb/articles/${slug}`);
      } catch {
        return MOCK_KB_ARTICLES.find((a) => a.slug === slug) ?? null;
      }
    },
    enabled: !!slug,
  });
}
