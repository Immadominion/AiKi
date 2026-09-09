'use client'

import { ArrowUpRight, RefreshCw } from 'lucide-react'
import Link from 'next/link'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { PageCard } from '@/components/shell/PageCard'
import { useAccount } from '@/components/shell/prefs'
import { AgentAvatar } from '@/components/ui/Avatar'
import {
  type CatalogAgent,
  type CatalogCapabilities,
  type CatalogReadResult,
  catalogApi,
} from '@/lib/catalog-api'
import { briefText } from '@/lib/identity'
import { route } from '@/lib/routes'
import { CONNECT_TOAST } from '@/lib/wallet'
import { loadCatalogHireHref } from './catalog-hiring'
import { readArguments, resultText } from './catalog-state'

const FOCUS =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-app'
const FIELD = `mt-2 min-h-11 w-full rounded-xl border border-ink-app/15 bg-surface px-3 py-3 text-base sm:text-sm ${FOCUS}`

function ProviderResult({ result }: { result: CatalogReadResult }) {
  const structured = result.structuredContent
  const rawData = structured?.data
  const data =
    rawData && typeof rawData === 'object' && !Array.isArray(rawData)
      ? (rawData as Record<string, unknown>)
      : null
  const dex = result.tool === 'getDexInfo' && typeof data?.dex === 'string' ? data.dex : null
  const tiers = Array.isArray(data?.feeTiers)
    ? data.feeTiers.filter((value): value is string => typeof value === 'string')
    : []
  return (
    <section
      aria-label="Agent result"
      className="rounded-2xl border border-ink-app/10 bg-surface p-5"
      tabIndex={-1}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="m-0 text-base font-bold">
          {result.status === 'completed'
            ? 'Your result'
            : result.status === 'payment_required'
              ? 'The provider requires payment'
              : result.status === 'auth_required'
                ? 'The provider requires sign-in'
                : 'The provider could not complete this read'}
        </h2>
        <span className="text-xs text-body">
          {new Date(result.observedAt).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </span>
      </div>
      {dex && result.status === 'completed' ? (
        <div className="my-5">
          <p className="mb-1 text-xs font-semibold text-body">DEX on BNB Chain</p>
          <p className="m-0 text-2xl font-bold tracking-tight">{dex}</p>
          {tiers.length ? (
            <div className="mt-4">
              <p className="mb-2 text-xs font-semibold text-body">Supported fee tiers</p>
              <div className="flex flex-wrap gap-2">
                {tiers.map((tier) => (
                  <span
                    key={tier}
                    className="rounded-lg bg-surface-sunk px-3 py-2 text-sm font-semibold"
                  >
                    {tier}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <pre className="my-4 max-h-96 overflow-auto rounded-xl bg-surface-sunk p-4 text-sm leading-relaxed break-words whitespace-pre-wrap text-body">
          {resultText(result)}
        </pre>
      )}
      {dex ? (
        <details className="mt-4">
          <summary className={`cursor-pointer py-3 text-sm font-semibold ${FOCUS}`}>
            Full provider response
          </summary>
          <pre className="max-h-96 overflow-auto rounded-xl bg-surface-sunk p-4 text-xs leading-relaxed break-words whitespace-pre-wrap">
            {resultText(result)}
          </pre>
        </details>
      ) : null}
      <p className="mt-4 mb-0 text-xs leading-relaxed text-body">
        Returned by {result.source.name}. No payment was made. This read is not a paid job in Work.
      </p>
    </section>
  )
}

export function CatalogDetail({ agentId }: { agentId: string }) {
  const { authenticated, address, connect } = useAccount()
  const [agent, setAgent] = useState<CatalogAgent | null>(null)
  const [capabilities, setCapabilities] = useState<CatalogCapabilities | null>(null)
  const [hireHref, setHireHref] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [capError, setCapError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [pool, setPool] = useState('CORE')
  const [result, setResult] = useState<CatalogReadResult | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const inFlight = useRef(false)
  const readController = useRef<AbortController | null>(null)
  const resultPanel = useRef<HTMLDivElement>(null)
  const problemPanel = useRef<HTMLParagraphElement>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: retry intentionally repeats provider discovery.
  useEffect(() => {
    const controller = new AbortController()
    setAgent(null)
    setCapabilities(null)
    setHireHref(null)
    setLoadError(null)
    setCapError(null)
    catalogApi
      .detail(agentId, controller.signal)
      .then(async (value) => {
        if (controller.signal.aborted) return
        setAgent(value)
        const href = await loadCatalogHireHref(value)
        if (!controller.signal.aborted) setHireHref(href)
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setLoadError(error instanceof Error ? error.message : 'This registration could not load.')
      })
    catalogApi
      .capabilities(agentId, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setCapabilities(value)
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setCapError(
            error instanceof Error ? error.message : 'The connection check could not finish.',
          )
      })
    return () => {
      controller.abort()
      readController.current?.abort()
    }
  }, [agentId, retry])

  useEffect(() => {
    if (result) resultPanel.current?.focus()
  }, [result])
  useEffect(() => {
    if (problem) problemPanel.current?.focus()
  }, [problem])

  const tool = capabilities?.readTools[0]
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!authenticated || !tool || inFlight.current) return
    const controller = new AbortController()
    readController.current = controller
    inFlight.current = true
    setBusy(true)
    setProblem(null)
    setResult(null)
    try {
      const args = readArguments(tool.name, pool, address)
      const response = await catalogApi.read(agentId, tool.name, args, controller.signal)
      if (!controller.signal.aborted) setResult(response)
    } catch (error) {
      if (!controller.signal.aborted)
        setProblem(
          error instanceof Error
            ? error.message
            : 'The provider did not complete this read. Try again shortly.',
        )
    } finally {
      inFlight.current = false
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  const signIn = async () => {
    if (connecting) return
    setConnecting(true)
    setProblem(null)
    try {
      const outcome = await connect()
      if (outcome !== 'injected') setProblem(CONNECT_TOAST[outcome])
    } catch {
      setProblem('The wallet connection did not finish. Try again.')
    } finally {
      setConnecting(false)
    }
  }

  return (
    <PageCard
      title={agent ? briefText(agent.name, 100) : 'Agent'}
      count={`BNB Chain · #${agentId}`}
      tabs={[]}
      tabHint=""
      back={{ href: '/explore', label: 'Explore agents' }}
    >
      {loadError ? (
        <div role="alert" className="rounded-2xl border border-ink-app/15 p-6">
          <h2 className="m-0 text-base font-bold">This registration could not load</h2>
          <p className="text-sm text-body">{loadError}</p>
          <button
            type="button"
            onClick={() => setRetry((value) => value + 1)}
            className={`min-h-11 rounded-xl bg-ink-app px-4 text-sm font-semibold text-surface ${FOCUS}`}
          >
            Try again
          </button>
        </div>
      ) : !agent ? (
        <div
          role="status"
          aria-label="Loading agent"
          className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(280px,380px)]"
        >
          <div className="h-80 rounded-2xl bg-surface-sunk motion-safe:animate-pulse" />
          <div className="h-64 rounded-2xl bg-surface-sunk motion-safe:animate-pulse" />
        </div>
      ) : (
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(280px,380px)]">
          <div className="min-w-0 space-y-5">
            <section className="overflow-hidden rounded-2xl border border-ink-app/10">
              <div className="bg-work-bg p-6">
                <AgentAvatar
                  identity={agent.sourceId}
                  name={agent.name}
                  src={agent.imageUrl}
                  size={96}
                />
                <h2 className="mt-5 mb-2 break-words text-2xl leading-tight font-bold tracking-tight">
                  {briefText(agent.name, 140)}
                </h2>
                <div className="flex flex-wrap gap-2">
                  {agent.declaredProtocols.slice(0, 6).map((protocol) => (
                    <span
                      key={protocol}
                      className="rounded-lg bg-surface px-2 py-1 text-xs font-semibold"
                    >
                      {protocol}
                    </span>
                  ))}
                </div>
              </div>
              <div className="space-y-4 p-6">
                <div>
                  <p className="mt-0 mb-2 text-xs font-semibold text-body">
                    What the publisher says it does
                  </p>
                  <p className="m-0 text-sm leading-relaxed break-words text-body">
                    {briefText(agent.description, 1200) || 'No description was published.'}
                  </p>
                  {agent.description.length > 1200 ? (
                    <details>
                      <summary className={`cursor-pointer py-3 text-sm font-semibold ${FOCUS}`}>
                        Full description
                      </summary>
                      <p className="text-sm leading-relaxed break-words text-body">
                        {agent.description}
                      </p>
                    </details>
                  ) : null}
                </div>
                {agent.declaredCategories.length ? (
                  <div>
                    <p className="mb-2 text-xs font-semibold text-body">Publisher categories</p>
                    <div className="flex flex-wrap gap-2">
                      {agent.declaredCategories.map((category) => (
                        <span
                          key={category}
                          className="rounded-lg bg-surface-sunk px-2 py-1 text-xs"
                        >
                          {category}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
                <a
                  href={agent.source.url}
                  target="_blank"
                  rel="noreferrer"
                  className={`inline-flex min-h-11 items-center gap-2 rounded-xl bg-surface-sunk px-4 text-sm font-semibold ${FOCUS}`}
                >
                  View registration on 8004scan <ArrowUpRight size={16} aria-hidden="true" />
                </a>
              </div>
            </section>
            <div ref={resultPanel} tabIndex={-1} className="focus:outline-none">
              {result ? <ProviderResult result={result} /> : null}
            </div>
            {capabilities?.tools.length ? (
              <details className="rounded-2xl border border-ink-app/10 px-5">
                <summary className={`cursor-pointer py-4 text-sm font-semibold ${FOCUS}`}>
                  Provider tools ({capabilities.tools.length}
                  {capabilities.toolsTruncated ? '+' : ''})
                </summary>
                <p className="mt-0 text-xs leading-relaxed text-body">
                  These schemas came from the provider’s MCP response. Only the read-only action
                  shown here is enabled in AiKi.
                </p>
                <ul className="m-0 list-none divide-y divide-ink-app/10 p-0">
                  {capabilities.tools.map((item) => (
                    <li key={item.name} className="py-3">
                      <div className="flex flex-wrap gap-2">
                        <code className="break-all text-xs font-semibold">{item.name}</code>
                        {item.readAllowed ? (
                          <span className="text-xs text-body">Read enabled</span>
                        ) : null}
                      </div>
                      <p className="mt-1 mb-0 text-xs leading-relaxed text-body">
                        {briefText(item.description, 200)}
                      </p>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
          <aside className="min-w-0 space-y-4 lg:sticky lg:top-0">
            {hireHref ? (
              <section className="rounded-2xl border border-ink-app/10 p-5">
                <h2 className="m-0 text-lg font-bold">Hiring options</h2>
                <p className="mt-2 mb-4 text-sm leading-relaxed text-body">
                  Give this agent a brief, choose a budget and follow its delivery in Work.
                </p>
                <Link
                  href={route(hireHref)}
                  className={`inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-ink-app px-4 text-sm font-bold text-surface ${FOCUS}`}
                >
                  Give this agent a job <ArrowUpRight size={16} aria-hidden="true" />
                </Link>
                <p className="mt-3 mb-0 text-xs leading-relaxed text-body">
                  Review the actual price and fee before sending a request.
                </p>
              </section>
            ) : null}
            {tool || !hireHref ? (
              <>
                <section className="rounded-2xl border border-ink-app/10 p-5">
                  <h2 className="m-0 text-lg font-bold">Use this agent</h2>
                  {!capabilities && !capError ? (
                    <div role="status" className="mt-4 space-y-3">
                      <p className="text-sm text-body">
                        Checking its connection and available actions…
                      </p>
                      <div className="h-11 rounded-xl bg-surface-sunk motion-safe:animate-pulse" />
                    </div>
                  ) : tool && capabilities?.status === 'available' ? (
                    <form onSubmit={submit} className="mt-4 space-y-4">
                      <div>
                        <h3 className="m-0 text-sm font-bold">{tool.label}</h3>
                        <p className="mt-2 mb-0 text-sm leading-relaxed text-body">
                          {tool.description}
                        </p>
                      </div>
                      {tool.name === 'getAccountLiquidity' ? (
                        <>
                          <div>
                            <label htmlFor="venus-pool" className="text-sm font-semibold">
                              Venus pool
                            </label>
                            <select
                              id="venus-pool"
                              value={pool}
                              onChange={(event) => setPool(event.target.value)}
                              disabled={busy}
                              className={FIELD}
                            >
                              <option value="CORE">Core pool</option>
                              <option value="DEFI">DeFi pool</option>
                            </select>
                          </div>
                          <div>
                            <p className="mb-2 text-xs font-semibold text-body">Wallet to read</p>
                            <p className="m-0 break-all rounded-xl bg-surface-sunk p-3 font-mono text-xs leading-relaxed">
                              {authenticated ? address : 'Your signed-in wallet'}
                            </p>
                          </div>
                        </>
                      ) : (
                        <div className="rounded-xl bg-surface-sunk p-3 text-sm">
                          <span className="text-body">Network</span>
                          <span className="float-right font-semibold">BNB Chain</span>
                        </div>
                      )}
                      <div className="flex items-baseline justify-between border-t border-ink-app/10 pt-4">
                        <span className="text-sm text-body">AiKi charge</span>
                        <strong className="text-base">0 points</strong>
                      </div>
                      {authenticated ? (
                        <button
                          type="submit"
                          disabled={busy}
                          aria-busy={busy}
                          className={`flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-ink-app px-4 text-sm font-bold text-surface disabled:opacity-60 ${FOCUS}`}
                        >
                          {busy ? (
                            <RefreshCw
                              size={16}
                              className="motion-safe:animate-spin"
                              aria-hidden="true"
                            />
                          ) : null}
                          {busy ? 'Reading from the provider…' : tool.label}
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={connecting}
                          aria-busy={connecting}
                          onClick={() => void signIn()}
                          className={`min-h-11 w-full rounded-xl bg-ink-app px-4 text-sm font-bold text-surface disabled:opacity-60 ${FOCUS}`}
                        >
                          {connecting ? 'Waiting for your wallet…' : 'Connect and sign in'}
                        </button>
                      )}
                      <p className="m-0 text-xs leading-relaxed text-body">
                        No transaction is signed. Provider payment requests stop here; AiKi will not
                        pay on your behalf.
                      </p>
                    </form>
                  ) : (
                    <div className="mt-4">
                      <p className="text-sm leading-relaxed text-body">
                        {capError ?? capabilities?.message}
                      </p>
                      <a
                        href={agent.source.url}
                        target="_blank"
                        rel="noreferrer"
                        className={`inline-flex min-h-11 items-center gap-2 rounded-xl bg-surface-sunk px-4 text-sm font-semibold ${FOCUS}`}
                      >
                        Provider registration <ArrowUpRight size={16} aria-hidden="true" />
                      </a>
                    </div>
                  )}
                  {problem ? (
                    <p
                      ref={problemPanel}
                      tabIndex={-1}
                      role="alert"
                      className="mt-4 rounded-xl border border-ink-app/15 p-3 text-sm leading-relaxed text-body focus:outline-none"
                    >
                      {problem}
                    </p>
                  ) : null}
                  {capError || capabilities?.status === 'unavailable' ? (
                    <button
                      type="button"
                      onClick={() => setRetry((value) => value + 1)}
                      className={`mt-3 min-h-11 rounded-xl bg-surface-sunk px-4 text-sm font-semibold ${FOCUS}`}
                    >
                      Check again
                    </button>
                  ) : null}
                </section>
                <p className="m-0 px-1 text-xs leading-relaxed text-body">
                  This listing comes from BNB Chain’s public registry. Read-only connections and
                  paid jobs have separate terms.{' '}
                  {agent.declaredPaymentSupport
                    ? 'The publisher declares support for paid requests; a discovery response does not confirm a price.'
                    : 'The publisher has not declared a payment price here.'}
                </p>
              </>
            ) : null}
            <Link
              href="/work"
              className={`inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-semibold ${FOCUS}`}
            >
              Go to your Work <ArrowUpRight size={16} aria-hidden="true" />
            </Link>
          </aside>
        </div>
      )}
    </PageCard>
  )
}
