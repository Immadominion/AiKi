import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { SettingsView } from '@/components/shell/SettingsView'
import { isSettingsTab, TAB_KEYS, TAB_LABELS } from '@/components/shell/settings-tabs'

export function generateStaticParams() {
  return TAB_KEYS.map((tab) => ({ tab }))
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ tab: string }>
}): Promise<Metadata> {
  const { tab } = await params
  return { title: `${isSettingsTab(tab) ? TAB_LABELS[tab] : 'Settings'} · Settings` }
}

export default async function Page({ params }: { params: Promise<{ tab: string }> }) {
  const { tab } = await params
  if (!isSettingsTab(tab)) notFound()
  return <SettingsView tab={tab} />
}
