import { KBArticleContent } from '../../../../(client)/kb/[slug]/kb-article-content';

// Staff-scoped KB article view — inside the staff shell, back-links to /staff/kb.
export default async function StaffKBArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <KBArticleContent slug={slug} basePath="/staff/kb" />;
}
