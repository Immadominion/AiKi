import { notFound } from 'next/navigation'
import { MandateBuilder } from '@/components/hire/MandateBuilder'
import type { AgentKey } from '@/lib/agents'
import { DETAILS } from '@/lib/detail'

export function generateStaticParams() {
  return Object.keys(DETAILS).map((key) => ({ key }))
}

export default async function Page({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params
  if (!(key in DETAILS)) notFound()
  return <MandateBuilder agentKey={key as AgentKey} />
}
