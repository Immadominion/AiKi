'use client'

import { Search } from 'lucide-react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { CatalogCard, CatalogSkeleton } from '@/components/catalog/CatalogCard'
import {
  CATALOG_CATEGORIES,
  catalogFilterHref,
  catalogFilters,
} from '@/components/catalog/catalog-state'
import { PageCard } from '@/components/shell/PageCard'
import { type CatalogAgent, type CatalogPage, catalogApi } from '@/lib/catalog-api'
import { route } from '@/lib/routes'

const FOCUS =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-app'

export function ExploreView() {
  const params = useSearchParams()
  const router = useRouter()
  const key = params.toString()
  const [search, setSearch] = useState(params.get('q') ?? '')
  const [page, setPage] = useState<CatalogPage | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [connectors, setConnectors] = useState<CatalogAgent[]>([])
  const scroll = useRef<HTMLDivElement>(null)
  const hasFilters = Boolean(
    params.get('q') || params.get('protocol') || params.get('category') || params.get('cursor'),
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: retry intentionally repeats the same source query.
  useEffect(() => {
    const controller = new AbortController()
    setPage(null)
    setProblem(null)
    setSearch(new URLSearchParams(key).get('q') ?? '')
    scroll.current?.scrollTo({ top: 0 })
    try {
      const query = catalogFilters(new URLSearchParams(key))
      catalogApi
        .list(query, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) setPage(result)
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted)
            setProblem(
              error instanceof Error
                ? error.message
                : 'The catalog could not load. Try again shortly.',
            )
        })
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Choose a different filter.')
    }
    return () => controller.abort()
  }, [key, retry])

  useEffect(() => {
    const controller = new AbortController()
    Promise.allSettled(
      ['43129', '45650'].map((id) => catalogApi.detail(id, controller.signal)),
    ).then((results) => {
      if (!controller.signal.aborted)
        setConnectors(
          results.flatMap((result) =>
            result.status === 'fulfilled' && result.value.connector === 'read_only_candidate'
              ? [result.value]
              : [],
          ),
        )
    })
    return () => controller.abort()
  }, [])

  const filter = (patch: Record<string, string>) =>
    router.replace(route(catalogFilterHref(new URLSearchParams(key), patch)), { scroll: false })
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    filter({ q: search.trim() })
  }

  return (
    <PageCard title="Explore agents" count="BNB Chain" tabs={[]} tabHint="" contentRef={scroll}>
      <div className="space-y-6 pb-2">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <p className="m-0 max-w-xl text-sm leading-relaxed text-body">Find your next agent.</p>
          <Link
            href="/market"
            className={`inline-flex min-h-11 items-center gap-2 rounded-xl bg-surface-sunk px-3 text-sm font-semibold ${FOCUS}`}
          >
            Ready in AiKi <span aria-hidden="true">↗</span>
          </Link>
        </div>
        <form
          onSubmit={submit}
          className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 md:grid-cols-[minmax(0,1fr)_180px_auto]"
        >
          <div className="col-span-2 md:col-span-1">
            <label htmlFor="catalog-search" className="mb-2 block text-xs font-semibold text-body">
              Search agents
            </label>
            <div className="relative">
              <Search
                size={18}
                className="pointer-events-none absolute top-3.5 left-3 text-body"
                aria-hidden="true"
              />
              <input
                id="catalog-search"
                type="search"
                autoComplete="off"
                maxLength={160}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Venus, portfolio, yield…"
                className={`min-h-11 w-full rounded-xl border border-ink-app/15 bg-surface py-3 pr-3 pl-10 text-base sm:text-sm ${FOCUS}`}
              />
            </div>
          </div>
          <div>
            <label
              htmlFor="catalog-protocol"
              className="mb-2 block text-xs font-semibold text-body"
            >
              Connection
            </label>
            <select
              id="catalog-protocol"
              value={params.get('protocol') ?? ''}
              onChange={(event) => filter({ protocol: event.target.value })}
              className={`min-h-11 w-full rounded-xl border border-ink-app/15 bg-surface px-3 text-base sm:text-sm ${FOCUS}`}
            >
              <option value="">All protocols</option>
              <option value="MCP">MCP</option>
              <option value="A2A">A2A</option>
            </select>
          </div>
          <button
            type="submit"
            className={`min-h-11 self-end rounded-xl bg-ink-app px-5 text-sm font-bold text-surface ${FOCUS}`}
          >
            Search
          </button>
        </form>
        <fieldset className="m-0 flex flex-wrap gap-2 border-0 p-0">
          <legend className="sr-only">Filter by kind of work</legend>
          {CATALOG_CATEGORIES.map((category) => (
            <button
              key={category.value}
              type="button"
              aria-pressed={(params.get('category') ?? '') === category.value}
              onClick={() => filter({ category: category.value })}
              className={`min-h-11 rounded-xl px-3 text-sm font-semibold ${FOCUS} ${(params.get('category') ?? '') === category.value ? 'bg-ink-app text-surface' : 'bg-surface-sunk text-body hover:text-ink-app'}`}
            >
              {category.label}
            </button>
          ))}
        </fieldset>
        {!hasFilters && connectors.length ? (
          <section aria-labelledby="catalog-connectors">
            <div className="mb-3">
              <h2 id="catalog-connectors" className="m-0 text-base font-bold">
                Read with an external agent
              </h2>
              <p className="mt-1 mb-0 text-sm text-body">Read-only connections. No AiKi points.</p>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              {connectors.map((agent) => (
                <CatalogCard key={agent.sourceId} agent={agent} compact />
              ))}
            </div>
          </section>
        ) : null}
        <section aria-labelledby="catalog-listings">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="catalog-listings" className="m-0 text-base font-bold">
              {hasFilters ? 'Matching registrations' : 'Registered agents'}
            </h2>
            <span className="text-xs text-body" aria-live="polite">
              {page ? `${page.items.length} registrations shown` : 'From 8004scan'}
            </span>
          </div>
          {problem ? (
            <div role="alert" className="rounded-2xl border border-ink-app/15 p-6">
              <h3 className="m-0 text-base font-bold">We couldn’t load these agents</h3>
              <p className="mt-2 text-sm text-body">{problem}</p>
              <div className="mt-4 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => setRetry((value) => value + 1)}
                  className={`min-h-11 rounded-xl bg-ink-app px-4 text-sm font-semibold text-surface ${FOCUS}`}
                >
                  Try again
                </button>
                <Link
                  href="/explore"
                  className={`inline-flex min-h-11 items-center rounded-xl bg-surface-sunk px-4 text-sm font-semibold ${FOCUS}`}
                >
                  Clear filters
                </Link>
              </div>
            </div>
          ) : !page ? (
            <CatalogSkeleton />
          ) : page.items.length === 0 ? (
            <div className="rounded-2xl border border-ink-app/10 px-6 py-10 text-center">
              <h3 className="m-0 text-base font-bold">No registrations on this page</h3>
              <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-body">
                Try a broader search or another connection type. A missing result doesn’t mean the
                agent cannot do the work.
              </p>
              <Link
                href="/explore"
                className={`mt-3 inline-flex min-h-11 items-center rounded-xl bg-surface-sunk px-4 text-sm font-semibold ${FOCUS}`}
              >
                Browse all agents
              </Link>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {page.items.map((agent) => (
                <CatalogCard key={agent.sourceId} agent={agent} />
              ))}
            </div>
          )}
          {page ? (
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
              <p className="m-0 max-w-2xl text-xs leading-relaxed text-body">
                Publisher listings and artwork from{' '}
                <a
                  href="https://8004scan.io"
                  target="_blank"
                  rel="noreferrer"
                  className={`underline underline-offset-2 ${FOCUS}`}
                >
                  8004scan
                </a>
                . Open an agent to check supported actions.{' '}
                {page.categoryMatch ? 'Categories match publisher text.' : ''}
              </p>
              <div className="flex gap-2">
                {params.get('cursor') ? (
                  <button
                    type="button"
                    onClick={() => filter({})}
                    className={`min-h-11 rounded-xl bg-surface-sunk px-4 text-sm font-semibold ${FOCUS}`}
                  >
                    First page
                  </button>
                ) : null}
                {page.hasMore && page.nextCursor ? (
                  <button
                    type="button"
                    onClick={() =>
                      router.push(
                        route(
                          catalogFilterHref(new URLSearchParams(key), {
                            cursor: page.nextCursor ?? '',
                          }),
                        ),
                        { scroll: false },
                      )
                    }
                    className={`min-h-11 rounded-xl bg-ink-app px-4 text-sm font-semibold text-surface ${FOCUS}`}
                  >
                    Next page →
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </PageCard>
  )
}
