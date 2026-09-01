import type { Metadata } from 'next'
import { WorkBoard } from '@/components/work/WorkBoard'

export const metadata: Metadata = {
  title: 'Work',
  description:
    'Work somebody has posted and already paid for, that anybody can claim. The money is held before the task appears, so it is there whether or not the poster changes their mind.',
}

export default function Page() {
  return <WorkBoard />
}
