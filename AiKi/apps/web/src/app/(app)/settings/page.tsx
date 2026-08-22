import type { Metadata } from 'next'
import { SettingsView } from '@/components/shell/SettingsView'

export const metadata: Metadata = {
  title: 'Settings',
  description: 'What AiKi is connected to, what it tells you about, and what it keeps.',
}

export default function Page() {
  return <SettingsView />
}
