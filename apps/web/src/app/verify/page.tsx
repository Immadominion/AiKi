import type { Metadata } from 'next'
import Link from 'next/link'
import { VerifyEntry } from '@/components/verify/VerifyEntry'
import { route } from '@/lib/routes'

export const metadata: Metadata = {
  title: 'Verify a receipt',
  description: 'Paste a receipt id and check it in your own browser.',
}

export default function Page() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[640px] flex-col px-5 py-[26px]">
      <header className="mb-[26px] flex items-center justify-between">
        <Link href={route('/')} className="text-[15px] font-extrabold tracking-[-0.02em]">
          AiKi
        </Link>
        <span className="text-muted text-[12.5px] font-semibold">Receipt verification</span>
      </header>
      <VerifyEntry />
    </main>
  )
}
