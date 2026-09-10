import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { StrategySetup } from '@/components/strategies/StrategySetup'

export const metadata: Metadata = {
  title: 'Set up an automated strategy',
  description: 'Review immutable limits, deploy, fund, sign and start separately.',
}
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ kind: string }>
  searchParams: Promise<{ setup?: string }>
}) {
  const { kind } = await params,
    { setup } = await searchParams
  if (kind !== 'yield' && kind !== 'grid' && kind !== 'lp') notFound()
  return <StrategySetup kind={kind} initialSetupId={setup} />
}
