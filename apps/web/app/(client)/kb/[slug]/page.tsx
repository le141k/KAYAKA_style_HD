import type { Metadata } from "next";
import { KBArticleContent } from "./kb-article-content";

export const metadata: Metadata = { title: "Статья" };

export default async function KBArticlePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <KBArticleContent slug={slug} />;
}
