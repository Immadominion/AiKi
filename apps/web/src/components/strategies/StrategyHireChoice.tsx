'use client'

import type { ProjectedPassport } from '@aiki/contracts'
import type { StrategyKind, StrategyPublicConfig } from '@aiki/contracts/strategies'
import type { Route } from 'next'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { strategyApi } from './api'
import { PANEL, SECONDARY } from './PolicyForm'
import { STRATEGY_COPY } from './policy'

/** Identity comes from the server's reviewed registry mapping, never a name/category. */
export function strategyForPassport(
  passport: ProjectedPassport,
  config: StrategyPublicConfig,
): StrategyKind | null {
  if (
    passport.chainId !== 56 ||
    config.chainId !== 56 ||
    passport.liveness !== 'LIVE' ||
    passport.identity?.tokenId !== passport.agentId ||
    !passport.identity.registrationFile.resolved ||
    !passport.identity.registrationFile.reciprocalProofVerified
  )
    return null
  const matches = (['yield', 'grid', 'lp'] as const).filter((kind) => {
    const identity = config.agents?.[kind]
    return (
      identity?.chainId === 56 &&
      identity.agentId === passport.agentId &&
      identity.registry.toLowerCase() === passport.registry?.toLowerCase()
    )
  })
  return matches.length === 1 ? (matches[0] ?? null) : null
}

export function StrategyHireChoice({ passport }: { passport: ProjectedPassport }) {
  const [resolved, setResolved] = useState<{
    agentId: string
    config: StrategyPublicConfig
  } | null>(null)
  useEffect(() => {
    let active = true
    void strategyApi
      .config()
      .then((config) => {
        if (active) setResolved({ agentId: passport.agentId, config })
      })
      .catch(() => {
        if (active) setResolved(null)
      })
    return () => {
      active = false
    }
  }, [passport.agentId])
  const config = resolved?.agentId === passport.agentId ? resolved.config : null
  const kind = config ? strategyForPassport(passport, config) : null
  if (!kind || !config) return null
  return (
    <section className={`${PANEL} mb-5`} aria-label="Report or automation">
      <h2 className="m-0 text-base font-bold">Report or a separately signed strategy</h2>
      <p className="text-body mt-2 text-sm leading-relaxed">
        The report form below only requests analysis. {STRATEGY_COPY[kind].name} uses a separate
        owner-controlled vault, explicit funding and a narrow mandate.
      </p>
      {!config.available ? (
        <p className="text-muted text-sm">
          Automation deployment is not ready yet. You can inspect the setup requirements without
          sending funds.
        </p>
      ) : null}
      <Link
        className={`inline-flex items-center justify-center ${SECONDARY}`}
        href={`/strategy/${kind}` as Route}
      >
        Review {STRATEGY_COPY[kind].name.toLowerCase()} setup
      </Link>
    </section>
  )
}
