'use client'

import type { Measure } from '@aiki/contracts'
import { BadgeCheckIcon, GitCompareArrowsIcon, HeartIcon, ShieldCheckIcon } from 'lucide-react'
import type { AgentRow } from '@/lib/agents'
import { AGENT_BG } from '@/lib/agents'
import type { AgentDetail, EnforcementLine } from '@/lib/detail'
import { formatScore } from '@/lib/format'

const enforcementLabel = (line: EnforcementLine) => {
  if (line.tier === 'T0' && line.verified) return 'On-chain'
  if (line.tier === 'T1') return 'Signer'
  if (line.tier === 'T2') return 'AiKi enforced'
  return 'Observed later'
}

const boundaryLine = (detail: AgentDetail) =>
  detail.enforcement.find((line) => line.caveat?.toLowerCase().includes('renewing cap')) ??
  detail.enforcement.find((line) => line.tier !== 'T0' || !line.verified) ??
  detail.enforcement[0]

const boundaryCopy = (line: EnforcementLine) => {
  const monthlyAmount = line.label.match(/\$[\d,.]+/)?.[0]
  const claim =
    monthlyAmount && line.label.toLowerCase().includes('month')
      ? `${monthlyAmount} monthly cap`
      : line.label.replace(/[.!]$/, '')

  if (line.tier === 'T0' && line.verified) return `${claim}. The chain enforces this.`
  if (line.tier === 'T1') return `${claim}. A signer checks this limit. The chain does not.`
  if (line.tier === 'T2') return `${claim}. AiKi checks this limit. The chain does not.`
  return `${claim}. Nothing stops it before the action.`
}

function AgentArtwork({ row }: { row: AgentRow }) {
  return (
    <svg
      viewBox="0 0 220 130"
      role="img"
      aria-label={`${row.name} identity artwork`}
      className="h-full w-full"
    >
      <path
        d="M18 82C40 38 77 16 123 16c35 0 65 11 86 34"
        fill="none"
        stroke="rgb(255 255 255 / 0.64)"
        strokeWidth="1"
      />
      <circle cx="188" cy="43" r="4" fill="#ff5a00" />
      <circle cx="31" cy="95" r="3" fill="rgb(255 255 255 / 0.8)" />
      <g transform="translate(61 9)">
        <path
          d="M42 63C20 65 10 78 10 103v25h118v-25c0-25-13-38-36-40"
          fill="#f4f1e8"
          stroke="#1a1a19"
          strokeWidth="5"
        />
        <path
          d="M37 20C37 7 47 0 69 0s32 7 32 20v33c0 12-9 19-32 19s-32-7-32-19Z"
          fill="#f4f1e8"
          stroke="#1a1a19"
          strokeWidth="5"
        />
        <rect x="44" y="16" width="50" height="39" rx="16" fill="#20211f" />
        <circle cx="58" cy="35" r="3.5" fill="#ff6a1b" />
        <circle cx="80" cy="35" r="3.5" fill="#ff6a1b" />
        <path d="M59 85h20l8 13-18 14-18-14Z" fill="#ff5a00" stroke="#1a1a19" strokeWidth="3" />
        <path d="M69 89v16M61 97h16" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
      </g>
    </svg>
  )
}

export function AgentCredentialCard({
  row,
  detail,
  overall,
  onHire,
  onSave,
  onCompare,
  saved,
}: {
  row: AgentRow
  detail: AgentDetail
  overall: Measure
  onHire: () => void
  onSave: () => void
  onCompare: () => void
  saved: boolean
}) {
  const score = formatScore(overall)
  const boundary = boundaryLine(detail)
  const access = [
    row.works,
    ...(detail.spends.length ? detail.spends.map((item) => item.symbol) : ['No spend authority']),
  ].join(' · ')
  const checkedAt = new Date(detail.liveness.lastProbeAt).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })

  return (
    <aside
      className="relative h-fit self-start overflow-hidden rounded-[64px_22px_22px_22px] bg-[#f1efe9] px-[18px] pt-6 pb-4 lg:sticky lg:top-0"
      style={{
        backgroundImage:
          'radial-gradient(circle at 8% 6%,rgb(255 90 0 / 0.14),transparent 28%),linear-gradient(rgb(26 26 25 / 0.045) 1px,transparent 1px),linear-gradient(90deg,rgb(26 26 25 / 0.045) 1px,transparent 1px)',
        backgroundSize: 'auto,32px 32px,32px 32px',
      }}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute -top-[100px] -right-[76px] size-[184px] rounded-full border border-[rgb(255_90_0_/_0.22)] shadow-[0_0_0_22px_rgb(255_90_0_/_0.03),0_0_0_44px_rgb(255_90_0_/_0.02)]"
      />

      <div className="relative mx-auto w-full max-w-[244px]">
        <span
          aria-hidden
          className="absolute inset-[7px_-7px_-7px_7px] rotate-[2deg] rounded-[27px_27px_45px_27px] bg-[#cbc5ba]"
        />
        <span
          aria-hidden
          className="absolute inset-[4px_-4px_-4px_4px] rotate-[0.8deg] rounded-[27px_27px_45px_27px]"
          style={{ background: AGENT_BG[detail.key] }}
        />

        <div
          className="relative overflow-hidden rounded-[27px_27px_45px_27px] bg-[#191917] p-[9px] text-white shadow-[0_20px_36px_rgb(43_35_28_/_0.22),0_2px_4px_rgb(26_26_25_/_0.15)]"
          style={{
            backgroundImage:
              'linear-gradient(rgb(255 255 255 / 0.035) 1px,transparent 1px),linear-gradient(90deg,rgb(255 255 255 / 0.035) 1px,transparent 1px)',
            backgroundSize: '24px 24px',
          }}
        >
          <span
            aria-hidden
            className="pointer-events-none absolute inset-[9px] rounded-[20px_20px_37px_20px] border border-[rgb(255_255_255_/_0.12)]"
          />
          <div className="relative z-1 p-[7px]">
            <div className="mx-0.5 mb-2 flex items-center justify-between gap-2 text-[6px] font-bold tracking-[0.15em] text-[rgb(255_255_255_/_0.55)] uppercase">
              <span>AiKi agent passport</span>
              <span>BNB / {detail.tokenId}</span>
            </div>

            <div
              className="relative h-[132px] overflow-hidden rounded-[16px_16px_32px_16px]"
              style={{ background: AGENT_BG[detail.key] }}
            >
              <span
                aria-hidden
                className="absolute -top-14 -right-6 size-[136px] rounded-full border border-[rgb(255_255_255_/_0.5)] shadow-[0_0_0_19px_rgb(255_255_255_/_0.06),0_0_0_38px_rgb(255_255_255_/_0.035)]"
              />
              <AgentArtwork row={row} />
            </div>

            <span className="absolute top-[132px] left-1/2 min-w-[108px] -translate-x-1/2 rounded-b-[15px] border-[5px] border-t-0 border-[#191917] bg-orange-app px-3 py-[6px] text-center text-[7px] font-extrabold tracking-[0.06em] uppercase">
              {row.does}
            </span>

            <div className="mt-[13px] flex items-center gap-[7px]">
              <h2 className="min-w-0 truncate text-[16px] leading-[1.1] font-extrabold tracking-[-0.045em]">
                {row.name}
              </h2>
              <span
                className="grid size-[18px] flex-none place-items-center rounded-full bg-[#ff6a1b] text-[#111]"
                title="Registry identity verified"
              >
                <BadgeCheckIcon aria-hidden size={11} strokeWidth={2.5} />
              </span>
            </div>
            <p className="mt-[5px] mb-[9px] text-[7.5px] leading-[1.45] text-[rgb(255_255_255_/_0.58)]">
              {detail.tagline}
            </p>
            <div className="mb-2 flex items-center gap-1.5 text-[6.8px] font-bold text-[rgb(255_255_255_/_0.68)]">
              <ShieldCheckIcon aria-hidden size={11} className="text-[#ff8a4b]" />
              <span className="truncate">Access · {access || 'No spend authority'}</span>
            </div>

            <div className="grid grid-cols-3 border-y border-[rgb(255_255_255_/_0.11)]">
              <div className="py-[7px] pr-1">
                <small className="block text-[5.5px] font-bold tracking-[0.1em] text-[rgb(255_255_255_/_0.42)] uppercase">
                  Proof
                </small>
                <b className="mt-[3px] block text-[8px]">
                  {score.text}
                  {!score.withheld ? ' / 100' : ''}
                </b>
              </div>
              <div className="border-l border-[rgb(255_255_255_/_0.1)] px-2 py-[7px]">
                <small className="block text-[5.5px] font-bold tracking-[0.1em] text-[rgb(255_255_255_/_0.42)] uppercase">
                  Checks
                </small>
                <b className="mt-[3px] block text-[8px]">{detail.checks[1].toLocaleString()}</b>
              </div>
              <div className="border-l border-[rgb(255_255_255_/_0.1)] py-[7px] pl-2">
                <small className="block text-[5.5px] font-bold tracking-[0.1em] text-[rgb(255_255_255_/_0.42)] uppercase">
                  Price
                </small>
                <b className="mt-[3px] block truncate text-[8px]">{detail.price}</b>
              </div>
            </div>

            {boundary ? (
              <div className="relative grid grid-cols-[19px_minmax(0,1fr)] gap-[7px] pt-2 pb-0.5 after:absolute after:right-0 after:bottom-0 after:size-[10px] after:border-r after:border-b after:border-[#c96b3f]">
                <span className="grid size-[18px] place-items-center rounded-[7px] border border-[rgb(255_138_75_/_0.36)] text-[#ff8a4b]">
                  <ShieldCheckIcon aria-hidden size={10} />
                </span>
                <div>
                  <small className="flex items-center gap-1.5 text-[5.5px] font-bold tracking-[0.09em] text-[#ffb18a] uppercase">
                    Trust boundary
                    <span className="rounded-[4px] border border-[rgb(255_177_138_/_0.26)] px-1 py-0.5 text-[4.8px] tracking-[0.05em] text-[rgb(255_255_255_/_0.64)]">
                      {enforcementLabel(boundary)}
                    </span>
                  </small>
                  <p className="mt-[3px] mb-0 text-[6.8px] leading-[1.4] text-[rgb(255_255_255_/_0.7)]">
                    {boundaryCopy(boundary)}
                  </p>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="relative mx-auto mt-[17px] w-full max-w-[244px]">
        <div className="flex items-end gap-2 px-0.5 pb-2.5">
          <strong className="min-w-0 truncate text-[17px] leading-none tracking-[-0.04em]">
            {detail.price}
          </strong>
          <span className="text-muted truncate text-[8.5px] font-semibold">
            {detail.settlementAsset}
          </span>
          <span className="flex-1" />
          <span
            className={`inline-flex items-center gap-1 text-[8px] font-bold ${detail.ownerVerified ? 'text-good-ink' : 'text-warn-ink'}`}
          >
            <span
              aria-hidden
              className={`size-[5px] rounded-full ${detail.ownerVerified ? 'bg-good' : 'bg-warn'}`}
            />
            {detail.ownerVerified ? 'Verified owner' : 'Owner unverified'}
          </span>
        </div>
        <button
          type="button"
          onClick={onHire}
          className="bg-ink-app hover:bg-orange-app h-11 w-full cursor-pointer rounded-[13px] border-0 text-[11px] font-extrabold text-white shadow-[0_8px_18px_rgb(26_26_25_/_0.12)] transition-colors duration-100 active:translate-y-px"
        >
          Hire with your limits
        </button>
        <div className="mt-[7px] grid grid-cols-2 gap-[7px]">
          <button
            type="button"
            onClick={onSave}
            aria-pressed={saved}
            className="text-body hover:text-ink-app inline-flex h-10 cursor-pointer items-center justify-center gap-1.5 rounded-[10px] border border-[rgb(26_26_25_/_0.08)] bg-[rgb(255_255_255_/_0.62)] text-[9px] font-bold transition-colors duration-100 active:translate-y-px"
          >
            <HeartIcon aria-hidden size={12} fill={saved ? 'currentColor' : 'none'} />
            {saved ? 'Saved' : 'Save'}
          </button>
          <button
            type="button"
            onClick={onCompare}
            className="text-body hover:text-ink-app inline-flex h-10 cursor-pointer items-center justify-center gap-1.5 rounded-[10px] border border-[rgb(26_26_25_/_0.08)] bg-[rgb(255_255_255_/_0.62)] text-[9px] font-bold transition-colors duration-100 active:translate-y-px"
          >
            <GitCompareArrowsIcon aria-hidden size={12} />
            Compare
          </button>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 border-t border-[rgb(26_26_25_/_0.1)] pt-3">
          <span>
            <small className="text-faint block text-[6.5px] font-bold tracking-[0.08em] uppercase">
              Last checked
            </small>
            <b className="text-body mt-[3px] block text-[8px]">{checkedAt}</b>
          </span>
          <span>
            <small className="text-faint block text-[6.5px] font-bold tracking-[0.08em] uppercase">
              Ownership
            </small>
            <b className="text-body mt-[3px] block text-[8px]">
              {detail.ownershipTransfers === 0
                ? 'Never transferred'
                : `${detail.ownershipTransfers} transfer${detail.ownershipTransfers === 1 ? '' : 's'}`}
            </b>
          </span>
        </div>
      </div>
    </aside>
  )
}
