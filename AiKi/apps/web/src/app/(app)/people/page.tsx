import type { Metadata } from 'next'
import { People } from '@/components/people/People'

export const metadata: Metadata = {
  title: 'People',
  description:
    'People who can be hired for work no agent measurably does, with what each has actually delivered here counted rather than claimed.',
}

export default function Page() {
  return <People />
}
