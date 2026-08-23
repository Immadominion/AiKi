'use client'

import { useRouter } from 'next/navigation'
import { route } from '@/lib/routes'

export interface Column {
  label: string
  glyph: string
  align?: 'start' | 'end'
  sortable?: boolean
}

export interface Row {
  id: string
  cells: React.ReactNode[]
}

/**
 * The app's table.
 *
 * A CSS grid rather than a `<table>` so cells can hold real components — a spend
 * meter, an evidence strip, a pair of buttons — and still keep column alignment.
 * The grid template comes from the caller because column widths are page-specific
 * and getting them wrong is what makes a table feel generic.
 */
export function DataTable({
  columns,
  cols,
  minWidth,
  rows,
  footnote,
}: {
  columns: Column[]
  cols: string
  minWidth: string
  rows: Row[]
  footnote: string
}) {
  const router = useRouter()

  return (
    <>
      <div className="overflow-x-auto overflow-y-hidden rounded-2xl border border-[rgb(26_26_25_/_0.08)]">
        <div
          className="bg-surface-sunk grid border-b border-[rgb(26_26_25_/_0.08)]"
          style={{ gridTemplateColumns: cols, minWidth }}
        >
          {columns.map((h) => (
            <div
              key={h.label || h.glyph || 'actions'}
              className="flex items-center gap-2 border-r border-[rgb(26_26_25_/_0.06)] px-[14px] py-[11px] last:border-r-0"
              style={{ justifyContent: h.align === 'end' ? 'flex-end' : 'flex-start' }}
            >
              <span className="text-faint flex-none text-[12px]">{h.glyph}</span>
              <span className="text-[13px] font-bold whitespace-nowrap text-[#4A4A46]">
                {h.label}
              </span>
              {h.sortable ? <span className="text-faint flex-none text-[10px]">⇅</span> : null}
            </div>
          ))}
        </div>

        {rows.map((r) => (
          <div
            key={r.id}
            className="hover:bg-surface-hover grid border-b border-[rgb(26_26_25_/_0.06)] transition-colors last:border-b-0"
            style={{ gridTemplateColumns: cols, minWidth }}
          >
            {r.cells.map((cell, i) => (
              <div
                key={columns[i]?.label ?? i}
                className="flex min-w-0 items-center gap-[11px] border-r border-[rgb(26_26_25_/_0.05)] px-[14px] py-[13px] last:border-r-0"
                style={{
                  justifyContent: columns[i]?.align === 'end' ? 'flex-end' : 'flex-start',
                }}
              >
                {cell}
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="mt-[14px] flex items-center gap-2">
        <span className="text-muted max-w-[640px] text-[12.5px] leading-[1.5] text-pretty">
          {footnote}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => router.push(route('/docs/how-we-test'))}
          className="h-8 flex-none rounded-[10px] border-0 bg-[rgb(26_26_25_/_0.055)] px-3 text-[12.5px] font-bold hover:bg-[rgb(26_26_25_/_0.09)]"
        >
          How we test
        </button>
      </div>
    </>
  )
}

/** Row action buttons. The rightmost is primary; everything else is quiet. */
export function RowActions({
  actions,
}: {
  actions: { label: string; primary?: boolean; onClick: () => void }[]
}) {
  return (
    <span className="flex w-full justify-end gap-[6px]">
      {actions.map((a) => (
        <button
          key={a.label}
          type="button"
          onClick={a.onClick}
          className={
            a.primary
              ? 'bg-ink-app hover:bg-orange-app h-8 rounded-[10px] border-0 px-3 text-[12.5px] font-bold text-white transition-colors'
              : 'text-ink-app h-8 rounded-[10px] border-0 bg-[rgb(26_26_25_/_0.055)] px-3 text-[12.5px] font-bold hover:bg-[rgb(26_26_25_/_0.09)]'
          }
        >
          {a.label}
        </button>
      ))}
    </span>
  )
}

/** Plain text cell. Kept as a helper so weights stay consistent across pages. */
export function Cell({
  children,
  weight = 500,
  color = 'var(--color-body-2)',
  size = '13.5px',
}: {
  children: React.ReactNode
  weight?: number
  color?: string
  size?: string
}) {
  return (
    <span
      className="min-w-0 leading-[1.4] text-pretty tabular-nums"
      style={{ fontSize: size, fontWeight: weight, color }}
    >
      {children}
    </span>
  )
}

/** Agent identity cell: mark, name, and what it works on. */
export function AgentCell({
  initial,
  name,
  sub,
  bg,
}: {
  initial: string
  name: string
  sub: string
  bg: string
}) {
  return (
    <>
      <span
        className="flex size-9 flex-none items-center justify-center rounded-xl text-[14px] font-extrabold text-white"
        style={{ background: bg }}
      >
        {initial}
      </span>
      <span className="min-w-0">
        <span className="block text-[14px] font-bold tracking-[-0.01em]">{name}</span>
        <span className="text-muted mt-px block text-[12px]">{sub}</span>
      </span>
    </>
  )
}
