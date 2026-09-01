import type { Metadata } from 'next'
import { RegistryHire } from '@/components/registry/RegistryHire'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  return {
    title: `Hire agent #${id}`,
    description: 'Set the limits before anything is signed. Each one says who holds it.',
  }
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <RegistryHire agentId={id} />
}
