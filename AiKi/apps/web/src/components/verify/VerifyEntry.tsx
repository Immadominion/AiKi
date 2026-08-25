'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { route } from '@/lib/routes'

/** Paste a receipt id; verification happens on the next page, in the browser. */
export function VerifyEntry() {
  const [id, setId] = useState('')
  const router = useRouter()
  const clean = id.trim().toLowerCase()
  const valid = /^[0-9a-f]{32}$/.test(clean)

  return (
    <form
      className="rounded-[20px] border border-[rgb(26_26_25_/_0.08)] bg-white px-[22px] py-[20px]"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid) router.push(route(`/verify/${clean}`))
      }}
    >
      <div className="text-[15px] font-bold">Check an execution receipt</div>
      <p className="text-muted mt-[6px] mb-0 text-[13px] leading-[1.55] text-pretty">
        Every completed job prints a receipt id. Your browser rebuilds the signed bytes and checks
        the signature itself — the server is not asked to vouch for its own work.
      </p>
      <div className="mt-[14px] flex gap-[8px]">
        <input
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder="32 hex characters"
          aria-label="Receipt id"
          className="h-[42px] min-w-0 flex-1 rounded-[12px] border border-[rgb(26_26_25_/_0.1)] px-[13px] font-mono text-[13px] outline-none focus:border-[rgb(255_77_0_/_0.5)]"
        />
        <button
          type="submit"
          disabled={!valid}
          className="h-[42px] flex-none rounded-[12px] border-0 bg-[linear-gradient(135deg,#FF4D00,#FF7A2E)] px-[18px] text-[13px] font-bold text-white disabled:opacity-40"
        >
          Verify
        </button>
      </div>
    </form>
  )
}
