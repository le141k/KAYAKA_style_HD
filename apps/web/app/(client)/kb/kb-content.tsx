'use client';

import { useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import { Search, BookOpen, Eye, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useKBCategories, useKBArticles } from '@/lib/hooks/use-kb';
import { QueryError } from '@/components/QueryError';
import { formatDate } from '@/lib/utils';

export function KBContent() {
  const [inputValue, setInputValue] = useState('');
  // Debounced value sent to the API — updated ~300 ms after the user stops typing.
  const [query, setQuery] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [selectedCategory, setSelectedCategory] = useState<number | undefined>();

  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setInputValue(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setQuery(value);
    }, 300);
  }, []);

  const { data: categories, isLoading: catLoading } = useKBCategories();
  const {
    data: articles,
    isLoading: artLoading,
    isError: artError,
    refetch: refetchArticles,
  } = useKBArticles(selectedCategory, query || undefined);

  const activeCategory = categories?.find((c) => c.id === selectedCategory);

  return (
    <div className="space-y-8">
      {/* Hero search */}
      <div className="rounded-2xl bg-gradient-brand p-8 text-center text-white">
        <BookOpen className="mx-auto mb-3 h-10 w-10 opacity-80" />
        <h1 className="text-2xl font-bold">База знаний</h1>
        <p className="mt-1 text-sm text-white/75">Найдите ответ на свой вопрос самостоятельно</p>
        <div className="relative mx-auto mt-5 max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Поиск по статьям..."
            value={inputValue}
            onChange={handleSearchChange}
            className="pl-9 bg-background text-foreground"
            aria-label="Поиск по базе знаний"
            data-testid="kb-search-input"
          />
        </div>
      </div>

      {/* Active filter indicator */}
      {(query || selectedCategory) && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>Фильтры:</span>
          {query && (
            <span className="flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
              Поиск: «{query}»
              <button
                type="button"
                onClick={() => {
                  setInputValue('');
                  setQuery('');
                }}
                className="ml-0.5 hover:text-primary/70"
                aria-label="Очистить поиск"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          )}
          {activeCategory && (
            <span className="flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium">
              Раздел: {activeCategory.name}
              <button
                type="button"
                onClick={() => setSelectedCategory(undefined)}
                className="ml-0.5 hover:text-foreground/70"
                aria-label="Очистить фильтр раздела"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          )}
        </div>
      )}

      {/* Categories */}
      {!query && (
        <div>
          <h2 className="mb-4 text-lg font-semibold">Разделы</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {catLoading
              ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)
              : categories?.map((cat) => (
                  <button
                    key={cat.id}
                    onClick={() => setSelectedCategory(selectedCategory === cat.id ? undefined : cat.id)}
                    className={`rounded-xl border p-4 text-left transition-all hover:border-primary/40 hover:bg-primary/5 ${
                      selectedCategory === cat.id ? 'border-primary bg-primary/10' : 'border-border bg-card'
                    }`}
                    aria-pressed={selectedCategory === cat.id}
                  >
                    <p className="font-semibold text-sm">{cat.name}</p>
                    <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{cat.description}</p>
                    <p className="mt-2 text-xs text-primary">{cat.article_count} статей</p>
                  </button>
                ))}
          </div>
        </div>
      )}

      {/* Articles */}
      <div>
        <h2 className="mb-4 text-lg font-semibold">
          {query
            ? `Результаты поиска: «${query}»`
            : activeCategory
              ? `Раздел: ${activeCategory.name}`
              : 'Статьи'}
        </h2>
        {artError ? (
          <QueryError message="Не удалось загрузить статьи." onRetry={() => void refetchArticles()} />
        ) : artLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-20 rounded-xl" />
            ))}
          </div>
        ) : articles?.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            Статьи не найдены
          </div>
        ) : (
          <div className="space-y-3">
            {articles?.map((article) => (
              <Link
                key={article.id}
                href={`/kb/${article.slug}`}
                className="block rounded-xl border border-border bg-card p-4 transition-all hover:border-primary/30 hover:shadow-sm"
                data-testid="kb-article-link"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-sm hover:text-primary">{article.title}</p>
                    <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{article.body}</p>
                    <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
                      {/* hide category chip when name is not resolved (KB-4) */}
                      {article.category.name ? (
                        <>
                          <span>{article.category.name}</span>
                          <span>·</span>
                        </>
                      ) : null}
                      <span>{formatDate(article.created_at)}</span>
                    </div>
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-1 text-xs text-muted-foreground">
                    <Eye className="h-3.5 w-3.5" />
                    {article.views.toLocaleString()}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
