import type { Metadata } from 'next'
import { DOC_BY_SLUG, DOCS } from '@/components/docs/content'
import { DocsArticle } from '@/components/docs/DocsArticle'

export function generateStaticParams() {
  return [...DOCS.map((d) => ({ slug: d.slug })), { slug: 'how-we-test' }]
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  if (slug === 'how-we-test')
    return {
      title: 'How we test',
      description:
        'Our own probe sweep of the BNB Chain registry, the detection rules in plain language, and why a score is never a raw percentage.',
    }
  const d = DOC_BY_SLUG[slug]
  return d ? { title: d.title, description: d.summary } : { title: 'Docs' }
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  return <DocsArticle slug={slug} />
}
