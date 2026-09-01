'use client'

import type { ProjectedPassport } from '@aiki/contracts'
import { useEffect, useState } from 'react'
import { MandateBuilder } from '@/components/hire/MandateBuilder'
import { type HireSubject, hireSubjectFromPassport } from '@/components/hire/subject'
import { PageCard } from '@/components/shell/PageCard'
import { api } from '@/lib/api'

/**
 * Hiring a real agent, on the same screen the examples use.
 *
 * The mandate builder was always real: it previews limits against the API's
 * deployed enforcers, opens an authorization, signs an EIP-712 delegation and
 * creates a job. It simply read the agent's name, price and permissions out of
 * the six-row example table, so the only agents on the marketplace anybody
 * could hire were six that do not exist. It takes a subject now, and this
 * builds one from the passport and the agent's own published price.
 */
export function RegistryHire({ agentId }: { agentId: string }) {
  const [subject, setSubject] = useState<HireSubject | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      api.passport(agentId),
      // A refused quote is an answer, not a failure: an agent with no published
      // price is hireable in principle and unpriceable in practice, and the
      // screen has to say which.
      api.quote(agentId).catch(() => null),
    ])
      .then(([passport, quote]) => {
        if (cancelled) return
        const p = passport as ProjectedPassport
        if (p.liveness !== 'LIVE') {
          setProblem(
            `AiKi has not seen this agent answer. Its last verdict was ${p.liveness
              .replace(/_/g, ' ')
              .toLowerCase()}, so it is listed but not for sale.`,
          )
          return
        }
        setSubject(
          hireSubjectFromPassport(
            p,
            quote
              ? {
                  price: quote.price.amount,
                  asset: quote.price.asset,
                  decimals: quote.price.decimals,
                }
              : null,
            {
              address: (quote?.settlementAsset.address ?? '0x0') as `0x${string}`,
              symbol: quote?.price.asset ?? 'U',
              decimals: quote?.settlementAsset.decimals ?? 18,
            },
          ),
        )
      })
      .catch(() => {
        if (!cancelled)
          setProblem('The registry could not be reached, so there is nothing to hire yet.')
      })
    return () => {
      cancelled = true
    }
  }, [agentId])

  if (problem)
    return (
      <PageCard
        title="Hire"
        count=""
        tabs={[]}
        tabHint=""
        back={{ href: `/registry/${agentId}`, label: `Agent ${agentId}` }}
      >
        <p className="max-w-[620px] text-[13.5px]">{problem}</p>
      </PageCard>
    )

  if (!subject)
    return (
      <PageCard
        title="Hire"
        count=""
        tabs={[]}
        tabHint=""
        back={{ href: `/registry/${agentId}`, label: `Agent ${agentId}` }}
      >
        <p className="text-muted text-[13.5px]">Reading the passport and the price…</p>
      </PageCard>
    )

  return <MandateBuilder subject={subject} />
}
