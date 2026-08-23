import type { Metadata } from 'next'
import { ReceiptView } from '@/components/job/ReceiptView'

export const metadata: Metadata = {
  title: 'Receipt',
  description:
    'What an agent did, what it cost, what it was allowed to do, and how to check all of it without going through AiKi.',
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <ReceiptView receiptId={id} />
}
