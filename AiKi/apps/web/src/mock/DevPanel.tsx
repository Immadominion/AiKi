'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { route } from '@/lib/routes'
import { useMock } from './store'
import { usd } from './types'

/**
 * Local control panel for walking the flow.
 *
 * Dev only, and deliberately ugly-adjacent: it is a tool, not a surface, and it
 * should never be mistaken for one. Opens on the corner tab or ⌘M.
 *
 * The JSON box is the point — paste any state in and the whole app renders it,
 * so shaping the data by hand is faster than clicking a flow forty times.
 */
export function DevPanel() {
  const { state, seed, advance, pause, resume, revoke } = useMock()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const router = useRouter()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'm' && (e.metaKey || e.ctrlKey) && e.shiftKey) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (open) setDraft(JSON.stringify(state, null, 2))
  }, [open, state])

  if (process.env.NODE_ENV === 'production') return null

  const running = state.jobs.filter((j) => j.status === 'RUNNING' || j.status === 'WAITING')

  const Btn = ({ label, onClick }: { label: string; onClick: () => void }) => (
    <button
      type="button"
      onClick={onClick}
      className="h-[30px] rounded-[9px] border-0 bg-[rgb(255_255_255_/_0.12)] px-[10px] text-[12px] font-semibold text-white hover:bg-[rgb(255_255_255_/_0.2)]"
    >
      {label}
    </button>
  )

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Mock controls (⌘⇧M)"
        className="fixed right-0 bottom-[30vh] z-200 flex h-[74px] w-[26px] items-center justify-center rounded-l-[10px] border-0 bg-[#141414] text-[10px] font-bold tracking-[0.1em] text-white/70 hover:text-white"
        style={{ writingMode: 'vertical-rl' }}
      >
        MOCK
      </button>

      {open ? (
        <div className="fixed right-3 bottom-3 z-200 flex max-h-[80vh] w-[min(400px,calc(100vw-24px))] flex-col overflow-hidden rounded-[16px] bg-[#141414] text-white shadow-[0_30px_70px_-20px_rgb(0_0_0_/_0.6)]">
          <div className="flex flex-none items-center justify-between px-[15px] pt-[13px] pb-[10px]">
            <span className="text-[13px] font-bold">Mock state</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="border-0 bg-none text-[13px] text-white/60 hover:text-white"
            >
              ×
            </button>
          </div>

          <div className="flex-none px-[15px] pb-[12px] text-[11.5px] text-white/60">
            {state.connected ? 'connected' : 'no wallet'} · {state.hires.length} hired ·{' '}
            {state.jobs.length} jobs · {state.events.length} events · {state.receipts.length}{' '}
            receipts
          </div>

          <div className="flex flex-none flex-wrap gap-[6px] px-[15px] pb-[12px]">
            <Btn label="Seed demo" onClick={() => seed('demo')} />
            <Btn label="Fresh (no agents)" onClick={() => seed('fresh')} />
            <Btn label="Wipe (no wallet)" onClick={() => seed('empty')} />
          </div>

          {running.length ? (
            <div className="flex-none border-t border-white/10 px-[15px] py-[12px]">
              <div className="mb-[8px] text-[11.5px] text-white/60">Jobs you can drive</div>
              <div className="flex flex-col gap-[6px]">
                {running.map((j) => (
                  <div key={j.id} className="flex items-center gap-[6px]">
                    <button
                      type="button"
                      onClick={() => router.push(route(`/jobs/${j.id}`))}
                      className="min-w-0 flex-1 truncate border-0 bg-none text-left text-[12px] font-semibold text-white/90 hover:underline"
                    >
                      {j.key} · {j.status} · step {j.step}
                    </button>
                    <Btn label="Step" onClick={() => advance(j.id)} />
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {state.hires.length ? (
            <div className="flex-none border-t border-white/10 px-[15px] py-[12px]">
              <div className="mb-[8px] text-[11.5px] text-white/60">Hired</div>
              <div className="flex flex-col gap-[6px]">
                {state.hires.map((h) => (
                  <div key={h.key} className="flex items-center gap-[6px]">
                    <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-white/90">
                      {h.key} · {h.status} · {usd(h.spentCents)} of {usd(h.mandate.capCents)}
                    </span>
                    <Btn
                      label={h.status === 'paused' ? 'Resume' : 'Pause'}
                      onClick={() => (h.status === 'paused' ? resume(h.key) : pause(h.key))}
                    />
                    <Btn label="Revoke" onClick={() => revoke(h.key)} />
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="flex min-h-0 flex-1 flex-col border-t border-white/10 px-[15px] py-[12px]">
            <div className="mb-[8px] text-[11.5px] text-white/60">
              State. Edit and apply to shape the data by hand
            </div>
            <textarea
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value)
                setError('')
              }}
              spellCheck={false}
              className="min-h-[120px] flex-1 resize-none rounded-[10px] border-0 bg-black/40 p-[10px] font-mono text-[11px] leading-[1.5] text-white/80 outline-none"
            />
            {error ? <div className="mt-[6px] text-[11.5px] text-[#FF8A3D]">{error}</div> : null}
            <div className="mt-[8px] flex gap-[6px]">
              <Btn
                label="Apply"
                onClick={() => {
                  try {
                    const parsed = JSON.parse(draft)
                    localStorage.setItem('aiki.mock.v1', JSON.stringify(parsed))
                    window.location.reload()
                  } catch (e) {
                    setError(e instanceof Error ? e.message : 'Could not parse that.')
                  }
                }}
              />
              <Btn
                label="Copy"
                onClick={() => {
                  navigator.clipboard?.writeText(draft).catch(() => setError('Clipboard refused.'))
                }}
              />
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
