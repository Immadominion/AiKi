import type { Metadata } from 'next'
import { RegistryPassport } from '@/components/registry/RegistryPassport'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  return {
    title: `Agent #${id}`,
    description: 'Evidence AiKi collected about this registry agent, and nothing else.',
  }
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <RegistryPassport agentId={id} />
}
