import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { MandateBuilder } from '@/components/hire/MandateBuilder'
import { AGENT_BY_KEY, type AgentKey } from '@/lib/agents'
import { DETAILS } from '@/lib/detail'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ key: string }>
}): Promise<Metadata> {
  const { key } = await params
  if (!(key in DETAILS)) return { title: 'Agent not found' }
  return {
    title: `Hire ${AGENT_BY_KEY[key as AgentKey].name}`,
    description: 'Set the limits before anything is signed. Each one says who holds it.',
  }
}

export function generateStaticParams() {
  return Object.keys(DETAILS).map((key) => ({ key }))
}

export default async function Page({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params
  if (!(key in DETAILS)) notFound()
  return <MandateBuilder agentKey={key as AgentKey} />
}
