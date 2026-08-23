'use client'

import { AgentCell, Cell, DataTable } from '@/components/shell/DataTable'
import { EmptyState, NoWallet } from '@/components/shell/EmptyState'
import { PageCard } from '@/components/shell/PageCard'
import { PageSkeleton } from '@/components/ui/Skeleton'
import { StatusPill } from '@/components/ui/StatusPill'
import { AGENT_BG } from '@/lib/agents'
import { type EventRow, eventRows } from '@/lib/present'
import { useMock } from '@/mock/store'
import { usd } from '@/mock/types'

/**
 * CSV, not JSON.
 *
 * The person exporting this is reconciling it against a spreadsheet or handing
 * it to an accountant. Quotes are doubled rather than stripped so a description
 * containing one cannot break the row it is in.
 */
function download(rows: EventRow[]) {
  const cell = (v: string) => `"${v.replace(/"/g, '""')}"`
  const head = ['When', 'Agent', 'Protocol', 'What happened', 'Cost', 'Result']
  const csv = [
    head.map(cell).join(','),
    ...rows.map((e) => [e.at, e.name, e.where, e.what, e.cost, e.result].map(cell).join(',')),
  ].join('\n')

  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = 'aiki-activity.csv'
  a.click()
  URL.revokeObjectURL(url)
}

export function ActivityView() {
  const { state, ready } = useMock()
  const rows = eventRows(state.events)
  const moved = rows.filter((e) => e.cost !== '$0.00')
  const blocked = rows.filter((e) => e.result === 'Blocked')
  const spentCents = state.events.reduce((n, e) => n + e.costCents, 0)
  const allowedCents = state.hires.reduce((n, h) => n + h.mandate.capCents, 0)

  const table = (data: EventRow[], footnote: string) => (
    <DataTable
      cols="92px minmax(170px,1.2fr) minmax(220px,1.7fr) 100px 118px"
      minWidth="710px"
      columns={[
        { label: 'When', glyph: '◷', sortable: true },
        { label: 'Agent', glyph: '◍' },
        { label: 'What happened', glyph: '⌬' },
        { label: 'Cost', glyph: '⌁' },
        { label: 'Result', glyph: '◔' },
      ]}
      rows={data.map((e) => ({
        id: e.id,
        cells: [
          <Cell key="a" weight={700} color="var(--color-ink-app)">
            {e.at}
          </Cell>,
          <AgentCell
            key="b"
            initial={e.initial}
            name={e.name}
            sub={e.where}
            bg={AGENT_BG[e.key]}
          />,
          <Cell key="c" color="var(--color-body)">
            {e.what}
          </Cell>,
          <Cell
            key="d"
            weight={700}
            color={e.cost === '$0.00' ? 'var(--color-muted)' : 'var(--color-ink-app)'}
          >
            {e.cost}
          </Cell>,
          <StatusPill key="e" label={e.result} tone={e.tone} />,
        ],
      }))}
      footnote={footnote}
    />
  )

  const empty = (title: string, body: string) => (
    <EmptyState key={title} title={title} body={body} />
  )

  if (!ready) return <PageSkeleton rows={6} />

  return (
    <PageCard
      title="Activity"
      count={rows.length ? `${rows.length} event${rows.length === 1 ? '' : 's'}` : ''}
      primary={rows.length ? 'Export' : undefined}
      onPrimary={() => download(rows)}
      tabs={['Everything', 'Money moved', 'Blocked']}
      tabHint={[
        'Every row is something an agent actually did',
        `${moved.length} of ${rows.length} events cost anything`,
        'Kept on purpose. This is the proof your limits hold',
      ]}
      banner={
        rows.length
          ? {
              title: blocked.length ? 'Your limits did their job.' : 'Nothing needed you.',
              body: `Agents acted ${rows.length} times, spent ${usd(spentCents)} of the ${usd(allowedCents)} you allowed, and were stopped ${blocked.length} time${blocked.length === 1 ? '' : 's'}.`,
              cta: 'Details',
            }
          : undefined
      }
      panels={[
        !state.connected ? (
          <NoWallet key="nw" what="everything your agents did" />
        ) : rows.length ? (
          table(
            rows,
            'Every row is a real event with a transaction behind it. Blocked rows are kept on purpose. They are the proof your limits hold.',
          )
        ) : (
          <EmptyState
            key="e0"
            title="Nothing has happened yet."
            body="Once an agent is working, every check and every action it takes lands here, including the ones your limits refused."
            action="Find an agent"
            href="/explore"
          />
        ),
        moved.length
          ? table(
              moved,
              'Only the events that moved money. Checks that found nothing to do are in Everything.',
            )
          : empty(
              'Nothing was spent.',
              'Your agents checked and found nothing worth acting on. That is a normal week, not a broken one.',
            ),
        blocked.length
          ? table(
              blocked,
              'An agent asked for something outside your limits and was refused. The transaction was never signed.',
            )
          : empty(
              'Nothing was blocked.',
              'No agent has asked for more than you allowed. If one ever does, it appears here and nothing is spent.',
            ),
      ]}
    />
  )
}
