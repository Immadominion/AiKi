import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { CatalogDetail } from '@/components/catalog/CatalogDetail'

export const metadata: Metadata = {
  title: 'Use an external agent',
  description:
    'Explore a BNB Chain agent’s registration and available read-only connections in AiKi.',
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!/^(0|[1-9]\d{0,77})$/.test(id)) notFound()
  return <CatalogDetail key={id} agentId={id} />
}
