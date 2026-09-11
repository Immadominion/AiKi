'use client'

import { History, Plus, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Bar } from '@/components/ui/Skeleton'
import { api, type FastConversationSummary } from '@/lib/api'

export function HistoryRail({
  onResume,
  onNew,
  authenticated,
  activeId,
  inline = false,
}: {
  onResume: (id: string) => void
  onNew: () => void
  authenticated: boolean
  activeId?: string
  inline?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<FastConversationSummary[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const generation = useRef(0)

  const load = useCallback(async (before?: string) => {
    const current = ++generation.current
    setLoading(true)
    setError(null)
    try {
      const result = await api.conversations(before)
      if (current !== generation.current) return
      setItems((previous) =>
        before
          ? [
              ...previous,
              ...result.conversations.filter((item) => !previous.some((old) => old.id === item.id)),
            ]
          : result.conversations,
      )
      setCursor(result.nextCursor)
    } catch (failure) {
      if (current === generation.current) setError((failure as Error).message)
    } finally {
      if (current === generation.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) {
      dialog.current?.showModal()
      if (authenticated) void load()
    } else dialog.current?.close()
    return () => {
      generation.current += 1
    }
  }, [open, authenticated, load])
  useEffect(() => {
    if (!authenticated) {
      setItems([])
      setCursor(null)
      setOpen(false)
    }
  }, [authenticated])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === '/') {
        event.preventDefault()
        setOpen((value) => !value)
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])

  const close = () => {
    setOpen(false)
    trigger.current?.focus()
  }
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        title="History (⌘ /)"
        className={`${inline ? '' : 'absolute bottom-4 left-4 z-40'} flex min-h-10 items-center gap-2 rounded-full border border-[rgb(26_26_25_/_0.12)] bg-white px-4 text-[12px] font-semibold text-ink-app hover:bg-surface-sunk focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-app`}
      >
        <History size={16} strokeWidth={1.8} aria-hidden="true" /> History
      </button>
      <dialog
        ref={dialog}
        aria-labelledby="fast-history-title"
        onCancel={close}
        onClose={() => setOpen(false)}
        className="fixed inset-y-4 right-4 left-4 m-0 max-h-none max-w-none rounded-[26px] border-0 bg-white p-0 text-ink-app shadow-xl backdrop:bg-black/15 sm:right-auto sm:left-[88px] sm:w-[320px]"
      >
        <div className="flex h-full min-h-0 flex-col">
          <header className="flex shrink-0 items-center justify-between gap-4 px-5 pt-4 pb-3">
            <div>
              <h2 id="fast-history-title" className="m-0 text-[18px] font-bold tracking-tight">
                History
              </h2>
              <p className="mt-1 mb-0 text-[12px] text-muted">
                Your conversations, saved to your wallet.
              </p>
            </div>
            <button
              type="button"
              onClick={close}
              aria-label="Close history"
              className="flex size-10 shrink-0 items-center justify-center rounded-full hover:bg-surface-sunk focus-visible:outline-2 focus-visible:outline-orange-app"
            >
              <X size={18} aria-hidden="true" />
            </button>
          </header>
          <button
            type="button"
            disabled={!authenticated}
            onClick={() => {
              close()
              onNew()
            }}
            className="mx-5 mb-3 flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-[14px] bg-ink-app px-4 text-[13px] font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-app disabled:opacity-40"
          >
            <Plus size={16} aria-hidden="true" /> New conversation
          </button>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-4">
            {!authenticated ? (
              <p className="px-2 text-[13px] leading-relaxed text-muted">
                Sign in with your wallet to see your conversations.
              </p>
            ) : null}
            {loading && items.length === 0 ? <ConversationSkeleton /> : null}
            {error ? (
              <div role="alert" className="px-2 text-[13px]">
                <p>{error}</p>
                <button
                  type="button"
                  onClick={() => void load()}
                  className="min-h-10 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-orange-app"
                >
                  Try again
                </button>
              </div>
            ) : null}
            {authenticated && !loading && !error && items.length === 0 ? (
              <div className="px-2 py-8">
                <History
                  size={24}
                  strokeWidth={1.5}
                  className="mb-3 text-muted"
                  aria-hidden="true"
                />
                <p className="mb-1 text-[14px] font-semibold">
                  Your first conversation starts here.
                </p>
                <p className="m-0 text-[13px] leading-relaxed text-muted">
                  Ask for what you need. You can come back to the conversation on any device.
                </p>
              </div>
            ) : null}
            <ul className="m-0 list-none space-y-1 p-0">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    aria-current={item.id === activeId ? 'page' : undefined}
                    onClick={() => {
                      close()
                      onResume(item.id)
                    }}
                    className={`w-full rounded-[16px] px-3 py-3 text-left focus-visible:outline-2 focus-visible:outline-orange-app ${item.id === activeId ? 'bg-surface-sunk' : 'hover:bg-surface-sunk'}`}
                  >
                    <span className="block line-clamp-2 text-[13px] leading-[1.45] font-semibold [overflow-wrap:anywhere]">
                      {item.title}
                    </span>
                    <span className="mt-1.5 flex items-center justify-between gap-2 text-[12px] text-muted">
                      <span>{item.messageCount} messages</span>
                      <time dateTime={item.updatedAt}>
                        {new Date(item.updatedAt).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                        })}
                      </time>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {cursor ? (
              <button
                type="button"
                disabled={loading}
                onClick={() => void load(cursor)}
                className="mt-3 min-h-11 w-full rounded-[14px] text-[13px] font-semibold focus-visible:outline-2 focus-visible:outline-orange-app disabled:opacity-40"
              >
                {loading ? 'Loading…' : 'Older conversations'}
              </button>
            ) : null}
          </div>
        </div>
      </dialog>
    </>
  )
}

const CONVERSATION_SKELETONS = ['conversation-a', 'conversation-b', 'conversation-c'] as const

function ConversationSkeleton() {
  return (
    <div role="status" aria-label="Loading conversations" className="space-y-1 px-1">
      {CONVERSATION_SKELETONS.map((id, index) => (
        <div key={id} aria-hidden className="rounded-[16px] px-3 py-3">
          <Bar w={index === 1 ? '86%' : '68%'} h={11} />
          <span className="mt-2 flex items-center justify-between">
            <Bar w={74} h={9} />
            <Bar w={44} h={9} />
          </span>
        </div>
      ))}
    </div>
  )
}
