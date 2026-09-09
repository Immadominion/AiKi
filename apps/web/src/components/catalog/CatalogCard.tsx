import { ArrowUpRight } from 'lucide-react'
import Link from 'next/link'
import { AgentAvatar } from '@/components/ui/Avatar'
import type { CatalogAgent } from '@/lib/catalog-api'
import { briefText } from '@/lib/identity'
import { route } from '@/lib/routes'

export function CatalogCard({
  agent,
  compact = false,
}: {
  agent: CatalogAgent
  compact?: boolean
}) {
  return (
    <Link
      href={route(`/catalog/${agent.id}`)}
      className={`group flex min-w-0 flex-col rounded-2xl border border-ink-app/10 bg-surface p-5 transition-colors hover:border-orange-app/50 hover:bg-work-bg/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-app ${compact ? '' : 'min-h-60'}`}
    >
      <div className="flex items-start gap-3">
        <AgentAvatar identity={agent.sourceId} name={agent.name} src={agent.imageUrl} size={48} />
        <div className="min-w-0 flex-1">
          <h3 className="m-0 break-words text-base leading-snug font-bold text-ink-app">
            {briefText(agent.name, 90)}
          </h3>
          <p className="mt-1 mb-0 text-xs text-body">BNB Chain · #{agent.id}</p>
        </div>
        <ArrowUpRight size={17} className="shrink-0 text-body" aria-hidden="true" />
      </div>
      <p className="mt-4 mb-4 text-sm leading-relaxed text-body">
        {briefText(agent.description, compact ? 110 : 180) ||
          'The publisher has not added a description.'}
      </p>
      <div className="mt-auto flex flex-wrap items-center gap-2">
        {agent.declaredProtocols.slice(0, 3).map((protocol) => (
          <span
            key={protocol}
            className="rounded-lg bg-surface-sunk px-2 py-1 text-xs font-semibold text-ink-app"
          >
            {protocol}
          </span>
        ))}
        <span className="ml-auto text-xs font-semibold text-body">
          {compact ? 'Read-only connector' : 'View agent'}
        </span>
      </div>
    </Link>
  )
}

export function CatalogSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div
      role="status"
      aria-label="Loading agent registrations"
      className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
    >
      {['first', 'second', 'third', 'fourth', 'fifth', 'sixth'].slice(0, count).map((key) => (
        <div
          key={key}
          aria-hidden="true"
          className="min-h-60 space-y-5 rounded-2xl border border-ink-app/10 p-5"
        >
          <div className="flex gap-3">
            <div className="size-12 rounded-xl bg-surface-sunk motion-safe:animate-pulse" />
            <div className="flex-1 space-y-2 pt-1">
              <div className="h-4 w-3/4 rounded bg-surface-sunk motion-safe:animate-pulse" />
              <div className="h-3 w-1/2 rounded bg-surface-sunk motion-safe:animate-pulse" />
            </div>
          </div>
          <div className="space-y-2">
            <div className="h-3 rounded bg-surface-sunk motion-safe:animate-pulse" />
            <div className="h-3 w-4/5 rounded bg-surface-sunk motion-safe:animate-pulse" />
            <div className="h-3 w-2/3 rounded bg-surface-sunk motion-safe:animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  )
}
