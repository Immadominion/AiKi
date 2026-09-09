'use client'

import type { ProjectedPassport } from '@aiki/contracts'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { AgentTaskForm } from '@/components/hire/AgentTaskForm'
import { MandateBuilder } from '@/components/hire/MandateBuilder'
import { guardianSubjectFromPassport, isGuardianPassport } from '@/components/hire/subject'
import { PageCard } from '@/components/shell/PageCard'
import { type AgentTaskSupport, api } from '@/lib/api'

export function RegistryHire({ agentId }: { agentId: string }) {
  const [details, setDetails] = useState<{
    passport: ProjectedPassport
    support: AgentTaskSupport
  } | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [repayment, setRepayment] = useState(false)

  // Retrying intentionally repeats the same support request.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is an explicit retry trigger.
  useEffect(() => {
    let cancelled = false
    setDetails(null)
    setRepayment(false)
    setProblem(null)
    Promise.all([api.passport(agentId), api.taskSupport(agentId)])
      .then(([passport, support]) => {
        if (!cancelled) setDetails({ passport, support })
      })
      .catch(() => {
        if (!cancelled)
          setProblem('We could not check whether this agent can take work. Try again in a moment.')
      })
    return () => {
      cancelled = true
    }
  }, [agentId, attempt])

  if (details?.support.available && details.passport.agentId === agentId) {
    const guardian = isGuardianPassport(details.passport)
    return (
      <>
        {guardian ? (
          <section className="mb-5 rounded-2xl border border-black/10 p-5">
            <p className="text-sm">
              A report only reads a position. Automatic repayment requires a separate signed mandate
              and a ready mandate account.
            </p>
            <div className="flex flex-wrap gap-3">
              <button type="button" aria-pressed={!repayment} onClick={() => setRepayment(false)}>
                Request a report
              </button>
              <button type="button" aria-pressed={repayment} onClick={() => setRepayment(true)}>
                Set up automatic repayment
              </button>
            </div>
          </section>
        ) : null}
        {guardian && repayment ? (
          <MandateBuilder subject={guardianSubjectFromPassport(details.passport)} />
        ) : (
          <AgentTaskForm passport={details.passport} support={details.support} />
        )}
      </>
    )
  }

  return (
    <PageCard
      title="Request work"
      count=""
      tabs={[]}
      tabHint=""
      back={{ href: `/registry/${agentId}`, label: details?.passport.name ?? `Agent ${agentId}` }}
    >
      {problem || details ? (
        <section className="max-w-xl rounded-2xl border border-black/10 p-6">
          <h1 className="m-0 text-lg font-bold">
            {problem ? 'Connection check unavailable' : 'This agent cannot take work here yet'}
          </h1>
          <p
            className="text-muted mt-2 text-sm leading-relaxed"
            role={problem ? 'alert' : undefined}
          >
            {problem ??
              details?.support.reason ??
              'AiKi has not confirmed a supported task connection for this agent.'}
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            {problem ? (
              <button
                type="button"
                onClick={() => setAttempt((value) => value + 1)}
                className="bg-ink-app min-h-11 rounded-xl px-4 text-sm font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-600"
              >
                Try again
              </button>
            ) : null}
            <Link
              href={`/registry/${agentId}`}
              className="inline-flex min-h-11 items-center rounded-xl bg-black/5 px-4 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-600"
            >
              Back to agent
            </Link>
          </div>
        </section>
      ) : (
        <div
          role="status"
          aria-label="Checking agent task support"
          className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]"
        >
          <div className="space-y-5 rounded-2xl border border-black/10 p-5">
            <p className="text-muted m-0 text-sm">Checking this agent’s task connection…</p>
            <div
              aria-hidden="true"
              className="h-12 rounded-xl bg-black/5 motion-safe:animate-pulse"
            />
            <div
              aria-hidden="true"
              className="h-40 rounded-xl bg-black/5 motion-safe:animate-pulse"
            />
          </div>
          <div
            aria-hidden="true"
            className="h-64 rounded-2xl bg-black/5 motion-safe:animate-pulse"
          />
        </div>
      )}
    </PageCard>
  )
}
