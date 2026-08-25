import type { Metadata } from 'next'
import Link from 'next/link'
import { VerifyReceipt } from '@/components/verify/VerifyReceipt'
import { route } from '@/lib/routes'

export const metadata: Metadata = {
  title: 'Verify a receipt',
  description:
    'Check an AiKi execution receipt in your own browser. The signature is verified locally; the server is not asked to vouch for itself.',
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[640px] flex-col px-5 py-[26px]">
      <header className="mb-[26px] flex items-center justify-between">
        <Link href={route('/')} className="text-[15px] font-extrabold tracking-[-0.02em]">
          AiKi
        </Link>
        <span className="text-muted text-[12.5px] font-semibold">Receipt verification</span>
      </header>
      <VerifyReceipt receiptId={id} />
    </main>
  )
}
