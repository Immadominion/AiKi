'use client'

import type { Measure } from '@aiki/contracts'
import {
  BadgeCheckIcon,
  BarChart3Icon,
  CalendarDaysIcon,
  ChevronRightIcon,
  CircleDollarSignIcon,
  Clock3Icon,
  DatabaseIcon,
  FileTextIcon,
  GaugeIcon,
  Globe2Icon,
  IdCardIcon,
  Layers3Icon,
  Link2Icon,
  Repeat2Icon,
  ShieldCheckIcon,
  TriangleAlertIcon,
  UserRoundIcon,
  WalletCardsIcon,
} from 'lucide-react'
import { type KeyboardEvent, useRef, useState } from 'react'
import type { AgentRow } from '@/lib/agents'
import type { AgentDetail, EnforcementLine } from '@/lib/detail'
import { formatScore, shortAddress } from '@/lib/format'

type WorkbenchTab = 'mandate' | 'proof' | 'identity'

const TIER_COPY: Record<EnforcementLine['tier'], string> = {
  T0: 'The chain rejects a call outside this rule.',
  T1: 'A signer refuses a call outside this rule.',
  T2: 'AiKi checks this before relaying the call.',
  T3: 'This is detected only after the action.',
}

const sourceLabel = (line: EnforcementLine) => {
  if (!line.verified) return line.tier === 'T1' ? 'Signer unverified' : `${line.tier} unverified`
  if (line.tier === 'T0' && line.verified) return 'On-chain'
  if (line.tier === 'T1') return 'Signer'
  if (line.tier === 'T2') return 'AiKi'
  return 'Afterwards'
}

function TabIcon({ tab }: { tab: WorkbenchTab }) {
  if (tab === 'mandate') return <ShieldCheckIcon aria-hidden size={14} />
  if (tab === 'proof') return <BarChart3Icon aria-hidden size={14} />
  return <IdCardIcon aria-hidden size={14} />
}

function MandatePanel({ row, detail }: { row: AgentRow; detail: AgentDetail }) {
  const spendTargets = detail.spends.length
    ? detail.spends.map((item) => item.symbol)
    : ['No spend authority']

  return (
    <div className="flex flex-col p-3 sm:p-4">
      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <b className="text-[10px]">Where every rule is actually held</b>
        <span className="text-muted text-[8px]">
          The enforcement source matters more than the promise.
        </span>
        <span className="flex-1" />
        <span className="text-orange-app text-[8px] font-bold">All limits shown</span>
      </div>

      <div className="border-t border-[rgb(26_26_25_/_0.08)]">
        {detail.enforcement.map((line, index) => (
          <div
            key={line.label}
            className="grid grid-cols-[24px_minmax(0,1fr)] items-center gap-x-2 border-b border-[rgb(26_26_25_/_0.07)] px-0.5 py-2 sm:grid-cols-[24px_minmax(160px,0.9fr)_minmax(180px,1.25fr)_auto]"
          >
            <span className="text-body grid size-6 place-items-center">
              {index === 0 ? (
                <Layers3Icon aria-hidden size={13} />
              ) : line.label.toLowerCase().includes('stop') ? (
                <Clock3Icon aria-hidden size={13} />
              ) : (
                <CircleDollarSignIcon aria-hidden size={13} />
              )}
            </span>
            <strong className="text-[9px] leading-[1.35]">{line.label}</strong>
            <p className="text-muted col-start-2 row-start-3 mt-1 mb-0 text-[7.5px] leading-[1.4] [overflow-wrap:anywhere] sm:col-start-auto sm:row-start-auto sm:mt-0">
              {line.verified ? TIER_COPY[line.tier] : 'This enforcement claim is not verified.'}{' '}
              {line.caveat}
              <span className="text-faint"> · {line.enforcedBy}</span>
            </p>
            <span
              className={`col-start-2 row-start-2 mt-1 w-fit min-w-[66px] rounded-[7px] border px-2 py-1 text-center text-[6px] font-extrabold tracking-[0.05em] uppercase sm:col-start-auto sm:row-start-auto sm:mt-0 ${
                line.tier === 'T0' && line.verified
                  ? 'text-body border-[rgb(26_26_25_/_0.13)]'
                  : 'text-work-ink border-[rgb(255_90_0_/_0.24)] bg-orange-wash'
              }`}
            >
              {sourceLabel(line)}
            </span>
          </div>
        ))}
      </div>

      <div className="relative mt-2.5 grid gap-2 overflow-hidden rounded-[18px_18px_38px_18px] bg-[#f6f5f1] px-3 py-3 sm:grid-cols-[minmax(100px,118px)_minmax(44px,1fr)_minmax(110px,132px)_minmax(44px,1fr)_minmax(150px,188px)] sm:items-center sm:gap-0">
        <span
          aria-hidden
          className="pointer-events-none absolute -right-20 -bottom-[108px] size-[140px] rounded-full border border-[rgb(255_90_0_/_0.2)] shadow-[0_0_0_18px_rgb(255_90_0_/_0.025)]"
        />
        <span className="relative z-1 grid min-w-0 grid-cols-[26px_minmax(0,1fr)] items-center gap-2">
          <span className="grid size-[26px] place-items-center rounded-[9px] border border-[rgb(26_26_25_/_0.11)] bg-[rgb(255_255_255_/_0.8)]">
            <WalletCardsIcon aria-hidden size={12} />
          </span>
          <span className="min-w-0">
            <small className="text-faint block text-[5.5px] font-bold tracking-[0.07em] uppercase">
              Authority starts at
            </small>
            <b className="mt-0.5 block truncate text-[7.5px]">Your smart account</b>
          </span>
        </span>
        <span className="text-faint relative z-1 hidden items-center sm:flex" aria-hidden>
          <span className="h-px flex-1 bg-[rgb(26_26_25_/_0.2)]" />
          <ChevronRightIcon size={11} className="-ml-1" />
        </span>
        <span className="relative z-1 grid min-w-0 grid-cols-[26px_minmax(0,1fr)] items-center gap-2">
          <span className="grid size-[26px] place-items-center rounded-[9px] border border-[rgb(26_26_25_/_0.11)] bg-[rgb(255_255_255_/_0.8)]">
            <ShieldCheckIcon aria-hidden size={12} />
          </span>
          <span className="min-w-0">
            <small className="text-faint block text-[5.5px] font-bold tracking-[0.07em] uppercase">
              Constrained by
            </small>
            <b className="mt-0.5 block truncate text-[7.5px]">AiKi mandate</b>
          </span>
        </span>
        <span className="text-faint relative z-1 hidden items-center sm:flex" aria-hidden>
          <span className="h-px flex-1 bg-[rgb(26_26_25_/_0.2)]" />
          <ChevronRightIcon size={11} className="-ml-1" />
        </span>
        <span className="relative z-1 grid grid-cols-2 gap-1.5">
          <span className="min-w-0 rounded-[10px_10px_15px_10px] border border-[rgb(26_26_25_/_0.09)] bg-[rgb(255_255_255_/_0.78)] px-2 py-1.5">
            <small className="text-faint block text-[5px] font-bold uppercase">Protocol</small>
            <b className="mt-0.5 block truncate text-[6.8px]">{row.works}</b>
          </span>
          <span className="min-w-0 rounded-[10px_10px_15px_10px] border border-[rgb(26_26_25_/_0.09)] bg-[rgb(255_255_255_/_0.78)] px-2 py-1.5">
            <small className="text-faint block text-[5px] font-bold uppercase">Can move</small>
            <b className="mt-0.5 block truncate text-[6.8px]">{spendTargets.join(', ')}</b>
          </span>
        </span>
      </div>

      {detail.risks.length > 0 ? (
        <div className="mt-2.5 flex flex-col gap-1.5">
          {detail.risks.map((risk) => (
            <div
              key={risk.label}
              className="grid grid-cols-[14px_minmax(0,1fr)] items-start gap-2 text-[7.5px] leading-[1.4]"
            >
              <TriangleAlertIcon
                aria-hidden
                size={12}
                className={`mt-px flex-none ${risk.severity === 'critical' ? 'text-work' : 'text-orange-app'}`}
              />
              <span className="min-w-0">
                <b className="block">{risk.label}</b>
                <span className="text-muted mt-0.5 block">{risk.detail}</span>
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function ProofPanel({
  detail,
  overall,
  components,
}: {
  detail: AgentDetail
  overall: Measure
  components: { label: string; measure: Measure }[]
}) {
  const total = formatScore(overall)
  const interval = overall.interval ?? [overall.value, overall.value]
  const checkedAt = new Date(detail.liveness.lastProbeAt).toLocaleString('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
  })

  return (
    <div className="flex flex-col p-3 sm:p-4">
      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <b className="text-[10px]">What the score is made of</b>
        <span className="text-muted text-[8px]">
          Every part keeps its own evidence and uncertainty.
        </span>
        <span className="flex-1" />
        <span className="text-orange-app text-[8px] font-bold">All evidence shown</span>
      </div>

      <div className="mb-3 grid border-y border-[rgb(26_26_25_/_0.08)] sm:grid-cols-4">
        <span className="px-2 py-2 sm:first:pl-0">
          <small className="text-faint block text-[6px] font-bold tracking-[0.07em] uppercase">
            Last checked
          </small>
          <b className="mt-0.5 block text-[7.5px]">{checkedAt}</b>
        </span>
        <span className="border-t border-[rgb(26_26_25_/_0.07)] px-2 py-2 sm:border-t-0 sm:border-l">
          <small className="text-faint block text-[6px] font-bold tracking-[0.07em] uppercase">
            Probe result
          </small>
          <b className="mt-0.5 block text-[7.5px]">{detail.liveness.detail}</b>
        </span>
        <span className="border-t border-[rgb(26_26_25_/_0.07)] px-2 py-2 sm:border-t-0 sm:border-l">
          <small className="text-faint block text-[6px] font-bold tracking-[0.07em] uppercase">
            Reply time
          </small>
          <b className="mt-0.5 block text-[7.5px]">
            {detail.liveness.p95LatencyMs
              ? `${(detail.liveness.p95LatencyMs / 1000).toFixed(1)} sec p95`
              : 'Not measured'}
          </b>
        </span>
        <span className="border-t border-[rgb(26_26_25_/_0.07)] px-2 py-2 sm:border-t-0 sm:border-l">
          <small className="text-faint block text-[6px] font-bold tracking-[0.07em] uppercase">
            Probe origin
          </small>
          <b className="mt-0.5 block text-[7.5px]">One location, so outages may be ours</b>
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-[150px_minmax(0,1fr)] sm:gap-4">
        <div className="flex flex-col justify-center border-b border-[rgb(26_26_25_/_0.08)] pb-3 sm:border-r sm:border-b-0 sm:pr-4 sm:pb-0">
          <small className="text-muted text-[7px] font-bold">Proof score</small>
          <div className="mt-0.5 text-[42px] leading-none font-extrabold tracking-[-0.07em] tabular-nums">
            {total.text}{' '}
            {!total.withheld ? (
              <span className="text-muted text-[10px] tracking-normal">/ 100</span>
            ) : null}
          </div>
          <p className="text-muted mt-2 mb-0 text-[7px] leading-[1.45]">
            Supported interval {interval[0].toFixed(0)} to {interval[1].toFixed(0)} from{' '}
            {overall.sampleSize.toLocaleString()} direct checks.
          </p>
        </div>

        <div className="min-w-0">
          {components.map(({ label, measure }) => {
            const score = formatScore(measure)
            return (
              <div
                key={label}
                className="grid grid-cols-[112px_minmax(50px,1fr)_34px] items-center gap-2 border-b border-[rgb(26_26_25_/_0.07)] py-1.5 last:border-b-0 sm:grid-cols-[130px_minmax(70px,1fr)_34px_62px]"
              >
                <b className="text-[7.5px]">{label}</b>
                <span className="h-[5px] overflow-hidden rounded-full bg-[rgb(26_26_25_/_0.07)]">
                  {measure.sampleSize > 0 ? (
                    <span
                      className="block h-full rounded-full bg-[linear-gradient(90deg,#FF5A00,#FFAD80)]"
                      style={{ width: `${Math.max(2, Math.min(100, measure.value))}%` }}
                    />
                  ) : null}
                </span>
                <strong className="text-right text-[7.5px] tabular-nums">{score.text}</strong>
                <small className="text-faint hidden text-right text-[6px] tabular-nums sm:block">
                  {measure.sampleSize > 0
                    ? `${measure.sampleSize.toLocaleString()} checks`
                    : 'not observed'}
                </small>
              </div>
            )
          })}
        </div>
      </div>

      <div
        className="mt-3 grid gap-2"
        style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))' }}
      >
        {detail.evidence.map((item) => (
          <div
            key={item.cls}
            className="flex items-start gap-2 border-t border-[rgb(26_26_25_/_0.08)] pt-2"
          >
            <span className="bg-ink-app grid size-[22px] flex-none place-items-center rounded-[7px] text-[7px] font-extrabold text-white">
              {item.cls}
            </span>
            <span>
              <b className="block text-[7px]">
                {item.count.toLocaleString()}{' '}
                {item.cls === 'A'
                  ? 'finalized actions'
                  : item.cls === 'B'
                    ? 'direct probes'
                    : 'registry reports'}
              </b>
              <span className="text-muted mt-0.5 block text-[6px] leading-[1.35]">
                {item.summary}
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function IdentityFact({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode
  label: string
  value: string
  detail: string
}) {
  return (
    <div className="grid min-w-0 grid-cols-[26px_minmax(0,1fr)] items-center gap-2 border-r border-b border-[rgb(26_26_25_/_0.07)] px-2.5 py-2.5">
      <span className="text-muted">{icon}</span>
      <span className="min-w-0">
        <small className="text-faint block text-[6px] font-bold tracking-[0.07em] uppercase">
          {label}
        </small>
        <b className="mt-0.5 block text-[7.5px] leading-[1.3]">{value}</b>
        <span className="text-muted mt-0.5 block text-[6px] leading-[1.35]">{detail}</span>
      </span>
    </div>
  )
}

function IdentityPanel({ detail }: { detail: AgentDetail }) {
  const registered = new Date(detail.registeredAt).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
  const registrationDetail =
    detail.uriScheme === 'data'
      ? 'Stored inline. It costs no network call and proves nothing by itself.'
      : `Served over ${detail.uriScheme.toUpperCase()} and resolved when AiKi checked.`

  return (
    <div className="flex flex-col p-3 sm:p-4">
      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <b className="text-[10px]">Registry identity and provenance</b>
        <span className="text-muted text-[8px]">
          Proven facts stay separate from declared metadata.
        </span>
        <span className="flex-1" />
        <span className="text-orange-app text-[8px] font-bold">Registry facts shown</span>
      </div>

      <div className="grid border-t border-l border-[rgb(26_26_25_/_0.07)] sm:grid-cols-2">
        <IdentityFact
          icon={<DatabaseIcon aria-hidden size={14} />}
          label="Registry"
          value={`ERC-8004 · token ${detail.tokenId}`}
          detail="IdentityRegistry on BNB Chain"
        />
        <IdentityFact
          icon={<UserRoundIcon aria-hidden size={14} />}
          label="Owner"
          value={shortAddress(detail.owner)}
          detail={
            detail.ownerVerified
              ? 'Registry owner marked verified'
              : 'Nobody has verified the registry owner'
          }
        />
        <IdentityFact
          icon={<BadgeCheckIcon aria-hidden size={14} />}
          label="Agent wallet"
          value={detail.agentWalletProven ? 'Wallet control proven' : 'Wallet control not proven'}
          detail={
            detail.agentWalletProven
              ? 'Signed and checked by AiKi'
              : 'The registry names it, but no signature proves control'
          }
        />
        <IdentityFact
          icon={<Link2Icon aria-hidden size={14} />}
          label="Domain proof"
          value={
            detail.reciprocalProofVerified ? 'Reciprocal link verified' : 'No reciprocal proof'
          }
          detail={
            detail.reciprocalProofVerified
              ? 'A matching well-known file resolved'
              : 'The declared endpoint does not link back to the registry'
          }
        />
        <IdentityFact
          icon={<FileTextIcon aria-hidden size={14} />}
          label="Registration file"
          value={detail.uriScheme.toUpperCase()}
          detail={registrationDetail}
        />
        <IdentityFact
          icon={<Globe2Icon aria-hidden size={14} />}
          label="Trust models"
          value={detail.supportedTrust.length ? detail.supportedTrust.join(', ') : 'None declared'}
          detail={
            detail.supportedTrust.length
              ? 'Declared by the registry entry'
              : 'The registry entry makes no trust claim'
          }
        />
        <IdentityFact
          icon={<Repeat2Icon aria-hidden size={14} />}
          label="Ownership"
          value={
            detail.ownershipTransfers === 0
              ? 'Never transferred'
              : `${detail.ownershipTransfers} transfer${detail.ownershipTransfers === 1 ? '' : 's'}`
          }
          detail={
            detail.ownershipTransfers === 0
              ? 'One continuous evidence history'
              : 'Evidence before a transfer is held separately'
          }
        />
        <IdentityFact
          icon={<CalendarDaysIcon aria-hidden size={14} />}
          label="Registered"
          value={registered}
          detail="Registration date reported by the registry"
        />
        <IdentityFact
          icon={<TriangleAlertIcon aria-hidden size={14} />}
          label="Transfer policy"
          value="Confidence resets on transfer"
          detail="The user is told before the next action"
        />
        <IdentityFact
          icon={<GaugeIcon aria-hidden size={14} />}
          label="Payment"
          value={detail.priceModel}
          detail={`${detail.settlementAsset} settlement · x402 ${detail.supportsX402 ? 'supported' : 'not supported'}`}
        />
      </div>
    </div>
  )
}

export function AgentInspectionWorkbench({
  row,
  detail,
  overall,
  components,
}: {
  row: AgentRow
  detail: AgentDetail
  overall: Measure
  components: { label: string; measure: Measure }[]
}) {
  const [active, setActive] = useState<WorkbenchTab>('mandate')
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const proof = formatScore(overall)
  const tabs: { id: WorkbenchTab; label: string; summary: string }[] = [
    { id: 'mandate', label: 'Mandate', summary: `${detail.enforcement.length} enforceable limits` },
    {
      id: 'proof',
      label: 'Proof',
      summary: `${proof.text}${proof.withheld ? '' : ' / 100'} · ${overall.sampleSize.toLocaleString()} checks`,
    },
    {
      id: 'identity',
      label: 'Identity',
      summary:
        detail.agentWalletProven && detail.reciprocalProofVerified
          ? 'Owner and domain verified'
          : 'Read the verification gaps',
    },
  ]

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const direction = event.key === 'ArrowRight' ? 1 : -1
    const next = (index + direction + tabs.length) % tabs.length
    const nextTab = tabs[next]
    if (!nextTab) return
    setActive(nextTab.id)
    refs.current[next]?.focus()
  }

  return (
    <section className="overflow-hidden rounded-[24px_24px_52px_24px] border border-[rgb(26_26_25_/_0.14)] bg-white">
      <div
        role="tablist"
        aria-label="Agent inspection details"
        className="grid grid-cols-3 border-b border-[rgb(26_26_25_/_0.07)] bg-[#fafaf8] px-1.5 sm:px-3"
      >
        {tabs.map((tab, index) => {
          const selected = active === tab.id
          return (
            <button
              key={tab.id}
              ref={(node) => {
                refs.current[index] = node
              }}
              id={`${detail.key}-${tab.id}-tab`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`${detail.key}-${tab.id}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(tab.id)}
              onKeyDown={(event) => onTabKey(event, index)}
              className={`relative flex min-w-0 cursor-pointer items-center gap-2 border-0 bg-transparent px-1.5 py-3 text-left transition-colors duration-100 after:absolute after:right-1.5 after:-bottom-px after:left-1.5 after:h-0.5 sm:px-3 sm:after:right-3 sm:after:left-3 ${
                selected
                  ? 'text-ink-app after:bg-orange-app'
                  : 'text-muted hover:text-ink-app after:bg-transparent'
              }`}
            >
              <span
                className={`grid size-7 flex-none place-items-center rounded-[9px] ${
                  selected ? 'bg-ink-app text-white' : 'bg-[rgb(26_26_25_/_0.05)] text-muted'
                }`}
              >
                <TabIcon tab={tab.id} />
              </span>
              <span className="min-w-0">
                <b className="block truncate text-[9.5px]">{tab.label}</b>
                <span className="text-faint mt-0.5 hidden truncate text-[6.8px] font-semibold min-[480px]:block">
                  {tab.summary}
                </span>
              </span>
            </button>
          )
        })}
      </div>

      <div
        id={`${detail.key}-mandate-panel`}
        role="tabpanel"
        aria-labelledby={`${detail.key}-mandate-tab`}
        hidden={active !== 'mandate'}
      >
        <MandatePanel row={row} detail={detail} />
      </div>
      <div
        id={`${detail.key}-proof-panel`}
        role="tabpanel"
        aria-labelledby={`${detail.key}-proof-tab`}
        hidden={active !== 'proof'}
      >
        <ProofPanel detail={detail} overall={overall} components={components} />
      </div>
      <div
        id={`${detail.key}-identity-panel`}
        role="tabpanel"
        aria-labelledby={`${detail.key}-identity-tab`}
        hidden={active !== 'identity'}
      >
        <IdentityPanel detail={detail} />
      </div>
    </section>
  )
}
