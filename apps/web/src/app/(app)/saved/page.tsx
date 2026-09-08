import type { Metadata } from 'next'
import { SavedView } from '@/components/limits/SavedView'

export const metadata: Metadata = {
  title: 'Saved',
  description: 'Agents you wanted to come back to, kept in this browser and nowhere else.',
}

export default function Page() {
  return <SavedView />
}
