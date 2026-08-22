import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { AgentPassport } from '@/components/agent/AgentPassport'
import { AGENT_BY_KEY, type AgentKey } from '@/lib/agents'
import { DETAILS } from '@/lib/detail'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ key: string }>
}): Promise<Metadata> {
  const { key } = await params
  const d = key in DETAILS ? DETAILS[key as AgentKey] : null
  if (!d) return { title: 'Agent not found' }
  return { title: AGENT_BY_KEY[d.key].name, description: d.tagline }
}

export function generateStaticParams() {
  return Object.keys(DETAILS).map((key) => ({ key }))
}

export default async function Page({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params
  if (!(key in DETAILS)) notFound()
  return <AgentPassport agentKey={key as AgentKey} />
}
