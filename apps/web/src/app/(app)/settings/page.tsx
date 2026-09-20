import type { Metadata } from 'next'
import { SettingsView } from '@/components/shell/SettingsView'

export const metadata: Metadata = {
  title: 'Settings',
  description: 'How AiKi behaves, what it tells you, and what it keeps.',
}

export default function Page() {
  return <SettingsView />
}
