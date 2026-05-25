'use client';

import Link from 'next/link';
import DOMPurify from 'isomorphic-dompurify';
import { ArrowLeft, Eye, Calendar } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useKBArticle } from '@/lib/hooks/use-kb';
import { QueryError } from '@/components/QueryError';
import { formatDate } from '@/lib/utils';

export function KBArticleContent({ slug, basePath = '/kb' }: { slug: string; basePath?: string }) {
  const { data: article, isLoading, isError, refetch } = useKBArticle(slug);

  if (isError) {
    return <QueryError message="Не удалось загрузить статью." onRetry={() => void refetch()} />;
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-7 w-2/3" />
        <div className="flex gap-4">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-20" />
        </div>
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!article) {
    return (
      <div className="text-center py-16">
        <p className="text-muted-foreground">Статья не найдена</p>
        <Button asChild className="mt-4" variant="outline">
          <Link href={basePath}>В базу знаний</Link>
        </Button>
      </div>
    );
  }

  return (
    <article className="mx-auto max-w-2xl space-y-6">
      <Button variant="ghost" size="sm" asChild>
        <Link href={basePath}>
          <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
          База знаний
        </Link>
      </Button>

      <div>
        {/* show category label only when we have a name (KB-4) */}
        {article.category.name ? (
          <span className="text-xs text-primary font-medium">{article.category.name}</span>
        ) : null}
        <h1 className="mt-1 text-2xl font-bold">{article.title}</h1>
        <div className="mt-2 flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Calendar className="h-3.5 w-3.5" />
            {formatDate(article.created_at)}
          </span>
          <span className="flex items-center gap-1">
            <Eye className="h-3.5 w-3.5" />
            {article.views.toLocaleString()} просмотров
          </span>
          <span>Автор: {article.author.name}</span>
        </div>
      </div>

      {/* body is staff-authored HTML — sanitized client-side as defense-in-depth
          (the API also sanitizes on write) before rendering as markup (KB-3) */}
      <div
        className="prose prose-sm max-w-none text-foreground"
        dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(article.body) }}
      />

      <div className="rounded-xl border border-border bg-card p-5">
        <p className="text-sm font-semibold">Не нашли ответ?</p>
        <p className="mt-1 text-xs text-muted-foreground">Наши специалисты помогут разобраться</p>
        <Button asChild className="mt-3" size="sm">
          <Link href="/submit">Создать обращение</Link>
        </Button>
      </div>
    </article>
  );
}
