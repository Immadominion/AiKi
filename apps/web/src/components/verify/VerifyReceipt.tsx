'use client'

import { useEffect, useState } from 'react'
import { type Verdict, verifyReceipt, type WireReceipt } from '@/lib/receipts'

/**
 * Empty means this origin, which is how it is deployed: the app proxies /v1 to
 * the API so the session cookie is same-origin. Local development points at the
 * dev API on another port instead.
 */
const API = process.env.NEXT_PUBLIC_API_URL ?? ''

type State =
  | { kind: 'checking' }
  | { kind: 'missing' }
  | { kind: 'unreachable' }
  | { kind: 'done'; receipt: WireReceipt; verdict: Verdict; publicKey: string }

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

const VERDICT_COPY: Record<Verdict, { title: string; body: string; tone: string }> = {
  verified: {
    title: 'This receipt checks out.',
    body: 'Your browser rebuilt the signed bytes from the receipt itself and checked the Ed25519 signature locally. The server was not asked whether its own receipt is valid.',
    tone: '#00A092',
  },
  hash_mismatch: {
    title: 'The receipt does not match its own hash.',
    body: 'The contents have been altered since signing, or the canonical form is wrong. Do not rely on this receipt.',
    tone: '#DC2626',
  },
  bad_signature: {
    title: 'The signature does not verify.',
    body: 'The hash is intact but the signature was not made by the published key. Do not rely on this receipt.',
    tone: '#DC2626',
  },
  unsupported: {
    title: 'Your browser cannot verify this locally.',
    body: 'It lacks WebCrypto Ed25519 support. We will not substitute our own word for a check your browser cannot make. Try a current Chrome, Safari, or Firefox.',
    tone: '#B45309',
  },
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-[rgb(26_26_25_/_0.05)] py-[9px] last:border-0">
      <span className="text-muted flex-none text-[12.5px] font-semibold">{label}</span>
      <span
        className={`min-w-0 truncate text-right text-[12.5px] font-semibold ${mono ? 'font-mono text-[11.5px]' : ''}`}
      >
        {value}
      </span>
    </div>
  )
}

/** Verifies one execution receipt in the reader's own browser. */
export function VerifyReceipt({ receiptId }: { receiptId: string }) {
  const [state, setState] = useState<State>({ kind: 'checking' })

  useEffect(() => {
    let alive = true
    ;(async () => {
      let receiptRes: Response
      let keyRes: Response
      try {
        ;[receiptRes, keyRes] = await Promise.all([
          fetch(`${API}/v1/receipts/${encodeURIComponent(receiptId)}`, { cache: 'no-store' }),
          fetch(`${API}/v1/receipts/key`, { cache: 'no-store' }),
        ])
      } catch {
        if (alive) setState({ kind: 'unreachable' })
        return
      }
      if (!receiptRes.ok || !keyRes.ok) {
        if (alive) setState({ kind: receiptRes.status >= 500 ? 'unreachable' : 'missing' })
        return
      }
      const receipt = (await receiptRes.json()) as WireReceipt
      const { publicKey } = (await keyRes.json()) as { publicKey: string }
      const verdict = await verifyReceipt(receipt, publicKey)
      if (alive) setState({ kind: 'done', receipt, verdict, publicKey })
    })()
    return () => {
      alive = false
    }
  }, [receiptId])

  if (state.kind !== 'done') {
    return (
      <div className="rounded-[20px] border border-[rgb(26_26_25_/_0.08)] bg-white px-[22px] py-[20px]">
        <div className="text-[15px] font-bold">
          {state.kind === 'checking'
            ? 'Checking in your browser…'
            : state.kind === 'missing'
              ? 'No receipt with this id.'
              : 'The evidence API is not answering.'}
        </div>
        {state.kind === 'missing' ? (
          <p className="text-muted mt-[6px] mb-0 text-[13px] leading-[1.55]">
            Receipt ids are 32 hex characters, printed on every completed job.
          </p>
        ) : null}
      </div>
    )
  }

  const copy = VERDICT_COPY[state.verdict]
  const r = state.receipt

  return (
    <>
      <div
        className="rounded-[20px] px-[22px] py-[20px] text-white"
        style={{ background: copy.tone }}
      >
        <div className="text-[16.5px] font-extrabold tracking-[-0.01em]">{copy.title}</div>
        <p className="mt-[6px] mb-0 text-[13px] leading-[1.55] text-white/85 text-pretty">
          {copy.body}
        </p>
      </div>

      <div className="mt-[14px] rounded-[20px] border border-[rgb(26_26_25_/_0.08)] bg-white px-[22px] py-[16px]">
        <Row label="Receipt" value={r.receiptId} mono />
        <Row label="Job" value={r.jobId} mono />
        <Row label="Mandate hash" value={r.mandateHash} mono />
        <Row label="Actions recorded" value={String(r.actions.length)} />
        <Row label="Started" value={when(r.startedAt)} />
        <Row label="Completed" value={when(r.completedAt)} />
        <Row label="Profile" value={`${r.profile} · ${r.alg}`} />
        <Row label="Signing key" value={state.publicKey} mono />
      </div>

      <p className="text-muted mt-[14px] mb-0 text-[12px] leading-[1.55] text-pretty">
        The signing key above came from the same API that issued the receipt. For verification that
        survives the API itself misbehaving, pin the key from a second channel and compare.
      </p>
    </>
  )
}
