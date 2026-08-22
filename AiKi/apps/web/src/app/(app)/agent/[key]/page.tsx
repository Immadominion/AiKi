import { notFound } from 'next/navigation'
import { AgentPassport } from '@/components/agent/AgentPassport'
import type { AgentKey } from '@/lib/agents'
import { DETAILS } from '@/lib/detail'

export function generateStaticParams() {
  return Object.keys(DETAILS).map((key) => ({ key }))
}

export default async function Page({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params
  if (!(key in DETAILS)) notFound()
  return <AgentPassport agentKey={key as AgentKey} />
}
