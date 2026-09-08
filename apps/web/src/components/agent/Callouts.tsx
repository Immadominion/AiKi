import type { EvidenceClass } from '@aiki/contracts'

type Severity = 'info' | 'warn' | 'critical'

const SEVERITY: Record<Severity, { bg: string; chip: string; ink: string; word: string }> = {
  info: {
    bg: 'rgb(26 26 25 / 0.035)',
    chip: 'var(--color-muted)',
    ink: 'var(--color-body)',
    word: 'Worth knowing',
  },
  warn: { bg: 'var(--color-warn-bg)', chip: 'var(--color-warn)', ink: '#6B5A34', word: 'Careful' },
  critical: {
    bg: 'var(--color-work-bg)',
    chip: 'var(--color-work)',
    ink: 'var(--color-work-ink)',
    word: 'Read this',
  },
}

/**
 * Risks, stated as what could actually go wrong rather than as a rating.
 *
 * Ordered worst first, because a list that opens with "worth knowing" trains
 * people to stop reading before the line that mattered.
 */
export function RiskList({
  risks,
}: {
  risks: { label: string; severity: Severity; detail: string }[]
}) {
  const order: Severity[] = ['critical', 'warn', 'info']
  const sorted = [...risks].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity))

  return (
    <div className="flex flex-col gap-[10px]">
      {sorted.map((r) => {
        const s = SEVERITY[r.severity]
        return (
          <div
            key={r.label}
            className="rounded-[16px] px-[15px] py-[13px]"
            style={{ background: s.bg }}
          >
            <div className="flex items-center gap-[9px]">
              <span className="size-[7px] flex-none rounded-full" style={{ background: s.chip }} />
              <span className="text-[13.5px] font-bold">{r.label}</span>
              <span className="text-faint text-[11.5px] font-semibold">{s.word}</span>
            </div>
            <p
              className="mt-[6px] mb-0 pl-4 text-[12.5px] leading-[1.55] text-pretty"
              style={{ color: s.ink }}
            >
              {r.detail}
            </p>
          </div>
        )
      })}
    </div>
  )
}

const CLASS_NOTE: Record<EvidenceClass, string> = {
  A: 'On-chain, cryptographic',
  B: 'AiKi observed it directly',
  C: 'Independent attestation',
  D: 'Claimed, unverified',
}

/** What we have, and how much each kind is worth. */
export function EvidenceList({
  items,
}: {
  items: { cls: EvidenceClass; count: number; summary: string }[]
}) {
  return (
    <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)]">
      {items.map((e, i) => (
        <div
          key={e.cls}
          className={`flex items-start gap-[13px] px-4 py-[13px] ${i > 0 ? 'border-t border-[rgb(26_26_25_/_0.06)]' : ''}`}
        >
          <span className="flex size-[30px] flex-none items-center justify-center rounded-[10px] bg-[rgb(26_26_25_/_0.05)] text-[13px] font-extrabold">
            {e.cls}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13.5px] font-semibold">
              {e.count.toLocaleString()} · {CLASS_NOTE[e.cls]}
            </span>
            <span className="text-muted mt-[3px] block text-[12px] leading-[1.5] text-pretty">
              {e.summary}
            </span>
          </span>
        </div>
      ))}
    </div>
  )
}

/** A labelled fact. Used wherever a page states something rather than measures it. */
export function Fact({
  label,
  children,
  tone,
}: {
  label: string
  children: React.ReactNode
  tone?: 'plain' | 'warn'
}) {
  return (
    <div className="flex flex-col items-start gap-1 border-t border-[rgb(26_26_25_/_0.06)] px-4 py-[12px] first:border-t-0 sm:flex-row sm:gap-3">
      <span className="text-muted w-full flex-none text-[12.5px] font-semibold sm:w-[186px]">
        {label}
      </span>
      <span
        className="min-w-0 flex-1 text-[13.5px] leading-[1.45] font-medium text-pretty"
        style={{ color: tone === 'warn' ? 'var(--color-warn-ink)' : 'var(--color-ink-app)' }}
      >
        {children}
      </span>
    </div>
  )
}
