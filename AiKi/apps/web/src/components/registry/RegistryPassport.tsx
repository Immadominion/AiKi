'use client'

import type { ProjectedPassport } from '@aiki/contracts'
import { useEffect, useState } from 'react'
import { PageCard } from '@/components/shell/PageCard'
import { LIVENESS_DETAIL, LivenessBadge } from '@/components/ui/LivenessBadge'
import { api } from '@/lib/api'

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; passport: ProjectedPassport }
  | { kind: 'missing' }
  | { kind: 'unreachable' }

const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })

const SEVERITY_BG: Record<string, string> = {
  critical: 'rgb(220 38 38 / 0.09)',
  warn: 'rgb(255 170 0 / 0.14)',
  info: 'rgb(26 26 25 / 0.05)',
}

/** A measured fact, or the honest admission that it was not measured. */
function Fact({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-[rgb(26_26_25_/_0.05)] py-[9px] last:border-0">
      <span className="text-muted flex-none text-[12.5px] font-semibold">{label}</span>
      <span
        className={`min-w-0 truncate text-right text-[13px] font-semibold ${
          value === null ? 'text-muted-3 font-medium italic' : ''
        }`}
      >
        {value ?? 'not measured'}
      </span>
    </div>
  )
}

/**
 * The evidence page for one registry agent: only what AiKi measured, with
 * every unmeasured field saying so. This page is the product's thesis in
 * miniature — if a field cannot be traced to an observation, it does not
 * render a value here.
 */
export function RegistryPassport({ agentId }: { agentId: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' })

  useEffect(() => {
    let alive = true
    api
      .passport(agentId)
      .then((passport) => {
        if (!alive) return
        setState(passport.updatedAt === null ? { kind: 'missing' } : { kind: 'ready', passport })
      })
      .catch(() => alive && setState({ kind: 'unreachable' }))
    return () => {
      alive = false
    }
  }, [agentId])

  if (state.kind !== 'ready') {
    return (
      <PageCard
        title={`Agent #${agentId}`}
        count="registry evidence"
        tabs={[]}
        tabHint=""
        back={{ href: '/registry', label: 'Registry' }}
      >
        <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)] px-[18px] py-5">
          <div className="text-[14.5px] font-bold">
            {state.kind === 'loading'
              ? 'Reading the evidence store…'
              : state.kind === 'missing'
                ? 'We hold no evidence for this agent id.'
                : 'The evidence API is not answering.'}
          </div>
          {state.kind === 'missing' ? (
            <p className="text-muted mt-[5px] mb-0 max-w-[620px] text-[13px] leading-[1.55] text-pretty">
              No probe has ever touched it. That is a fact about our coverage, not about the agent.
            </p>
          ) : null}
        </div>
      </PageCard>
    )
  }

  const p = state.passport
  const [floor, ceil] = p.proofScore.interval

  return (
    <PageCard
      title={p.name ?? `Agent #${p.agentId}`}
      count={`token ${p.identity.tokenId}${p.chainId === 56 ? ' · BNB Chain' : ''}`}
      tabs={[]}
      tabHint=""
      back={{ href: '/registry', label: 'Registry' }}
    >
      <div className="grid gap-[14px] md:grid-cols-2">
        <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)] px-[18px] py-[15px]">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[14px] font-bold">What we measured</span>
            <LivenessBadge state={p.liveness} />
          </div>
          <p className="text-muted mt-[8px] mb-0 text-[12.5px] leading-[1.55] text-pretty">
            {p.livenessDetail ?? LIVENESS_DETAIL[p.liveness]}
          </p>
          <div className="mt-[12px]">
            <Fact label="Probes answered" value={`${p.checks.successes} of ${p.checks.trials}`} />
            <Fact
              label="Score floor"
              value={`${(floor * 100).toFixed(0)}% · interval ${(floor * 100).toFixed(0)}–${(ceil * 100).toFixed(0)}%`}
            />
            <Fact
              label="p95 latency"
              value={p.p95LatencyMs === null ? null : `${(p.p95LatencyMs / 1000).toFixed(1)}s`}
            />
            <Fact label="Last probed" value={p.lastProbeAt ? day(p.lastProbeAt) : null} />
          </div>
          {p.insufficientEvidence ? (
            <p className="text-muted mt-[10px] mb-0 rounded-[12px] bg-[rgb(26_26_25_/_0.04)] px-[12px] py-[9px] text-[12px] leading-[1.5] text-pretty">
              Fewer than 5 probes so far. The interval is wide because the evidence is thin, not
              because the agent is bad.
            </p>
          ) : null}
        </div>

        <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)] px-[18px] py-[15px]">
          <span className="text-[14px] font-bold">Identity on the registry</span>
          <div className="mt-[6px]">
            <Fact label="Owner" value={p.identity.owner} />
            <Fact
              label="Registered"
              value={p.identity.createdAt ? day(p.identity.createdAt) : null}
            />
            <Fact
              label="Registration file"
              value={
                p.identity.registrationFile.resolved === null
                  ? null
                  : p.identity.registrationFile.resolved
                    ? `resolved · ${p.identity.registrationFile.uriScheme ?? 'unknown scheme'}`
                    : 'did not resolve'
              }
            />
            <Fact
              label="Points back at this token"
              value={
                p.identity.registrationFile.reciprocalProofVerified === null
                  ? null
                  : p.identity.registrationFile.reciprocalProofVerified
                    ? 'proven'
                    : 'no proof found'
              }
            />
            <Fact
              label="Registration cost"
              value={
                p.identity.registrationFile.zeroCost === null
                  ? null
                  : p.identity.registrationFile.zeroCost
                    ? 'nothing (data: URI)'
                    : 'paid'
              }
            />
          </div>
        </div>
      </div>

      {p.risks.length ? (
        <div className="mt-[14px] rounded-[18px] border border-[rgb(26_26_25_/_0.08)] px-[18px] py-[15px]">
          <span className="text-[14px] font-bold">What this evidence says to watch</span>
          <div className="mt-[10px] flex flex-col gap-[8px]">
            {p.risks.map((r) => (
              <div
                key={r.code}
                className="rounded-[13px] px-[13px] py-[10px]"
                style={{ background: SEVERITY_BG[r.severity] ?? SEVERITY_BG.info }}
              >
                <div className="text-[13px] font-bold">{r.label}</div>
                <p className="text-muted mt-[3px] mb-0 text-[12.5px] leading-[1.5] text-pretty">
                  {r.detail}
                </p>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-[14px] rounded-[18px] border border-[rgb(26_26_25_/_0.08)] px-[18px] py-[15px]">
        <span className="text-[14px] font-bold">Every observation behind this page</span>
        <div className="mt-[6px]">
          {p.evidence.map((e) => (
            <Fact
              key={e.predicate}
              label={e.predicate}
              value={`${e.count} · latest ${day(e.latestAt)}`}
            />
          ))}
        </div>
        <p className="text-muted-3 mt-[10px] mb-0 text-[11.5px] leading-[1.45]">
          Updated {p.updatedAt ? day(p.updatedAt) : 'never'} · score method {p.proofScore.method}
        </p>
      </div>
    </PageCard>
  )
}
