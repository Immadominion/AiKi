'use client'

import { AgentCell, Cell, DataTable } from '@/components/shell/DataTable'
import { EmptyState, NoWallet } from '@/components/shell/EmptyState'
import { PageCard } from '@/components/shell/PageCard'
import { useAccount } from '@/components/shell/prefs'
import { PageSkeleton } from '@/components/ui/Skeleton'
import { StatusPill, type Tone } from '@/components/ui/StatusPill'
import { AGENT_BG, type AgentKey } from '@/lib/agents'

interface Event {
  at: string
  key: AgentKey
  initial: string
  name: string
  where: string
  what: string
  cost: string
  result: string
  tone: Tone
}

const EVENTS: Event[] = [
  {
    at: '02:39',
    key: 'guardian',
    initial: 'G',
    name: 'Guardian',
    where: 'Venus',
    what: 'Repaid 72 USDT — health factor 1.22 → 1.47',
    cost: '$0.06',
    result: 'Done',
    tone: 'good',
  },
  {
    at: '02:41',
    key: 'guardian',
    initial: 'G',
    name: 'Guardian',
    where: 'Venus',
    what: 'Tried to spend $91.20 — over your $80 per-action limit',
    cost: '$0.00',
    result: 'Blocked',
    tone: 'warn',
  },
  {
    at: '05:12',
    key: 'gridly',
    initial: 'G',
    name: 'Gridly',
    where: 'PancakeSwap',
    what: 'Rebalanced BNB / USDT back into range',
    cost: '$0.12',
    result: 'Done',
    tone: 'good',
  },
  {
    at: '06:41',
    key: 'guardian',
    initial: 'G',
    name: 'Guardian',
    where: 'Venus',
    what: 'Checked your position — no action needed',
    cost: '$0.00',
    result: 'Checked',
    tone: 'idle',
  },
  {
    at: '09:03',
    key: 'yieldmax',
    initial: 'Y',
    name: 'YieldMax',
    where: 'Radiant',
    what: 'Found 11.8% APY and asked for your approval',
    cost: '$0.00',
    result: 'Waiting',
    tone: 'work',
  },
  {
    at: '11:20',
    key: 'gridly',
    initial: 'G',
    name: 'Gridly',
    where: 'PancakeSwap',
    what: 'Placed 4 grid orders between $580 and $640',
    cost: '$0.09',
    result: 'Done',
    tone: 'good',
  },
]

/**
 * CSV, not JSON.
 *
 * The person exporting this is reconciling it against a spreadsheet or handing
 * it to an accountant. Quotes are doubled rather than stripped so a description
 * containing one cannot break the row it is in.
 */
function toCsv(rows: Event[]): string {
  const cell = (v: string) => `"${v.replace(/"/g, '""')}"`
  const head = ['When', 'Agent', 'Protocol', 'What happened', 'Cost', 'Result']
  const body = rows.map((e) =>
    [e.at, e.name, e.where, e.what, e.cost, e.result].map(cell).join(','),
  )
  return [head.map(cell).join(','), ...body].join('\n')
}

function download(rows: Event[]) {
  const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'aiki-activity.csv'
  a.click()
  URL.revokeObjectURL(url)
}

export function ActivityView() {
  const { connected, ready } = useAccount()
  const table = (rows: Event[], footnote: string) => (
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
      rows={rows.map((e, i) => ({
        id: `${e.at}-${i}`,
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

  const events = connected ? EVENTS : []
  const moved = events.filter((e) => e.cost !== '$0.00')
  const blocked = events.filter((e) => e.tone === 'warn')

  const empty = (title: string, body: string) => (
    <div className="rounded-[18px] border border-[rgb(26_26_25_/_0.08)] px-[18px] py-[22px]">
      <div className="text-[14.5px] font-bold">{title}</div>
      <p className="text-muted mt-[5px] mb-0 max-w-[560px] text-[13px] leading-[1.55] text-pretty">
        {body}
      </p>
    </div>
  )

  if (!ready) return <PageSkeleton rows={6} />

  return (
    <PageCard
      title="Activity"
      count={events.length ? `Last 7 days · ${events.length} events` : ''}
      primary="Export"
      onPrimary={() => download(EVENTS)}
      tabs={['Everything', 'Money moved', 'Blocked']}
      tabHint={[
        'Every row links to its transaction',
        `${moved.length} of ${events.length} events cost anything`,
        'Kept on purpose — this is the proof your limits hold',
      ]}
      banner={
        events.length
          ? {
              title: 'Nothing needed you this week.',
              body: `Agents acted ${events.length} times, spent $46.00 of the $370 you allowed, and were stopped once.`,
              cta: 'Details',
            }
          : undefined
      }
      panels={[
        !connected ? (
          <NoWallet key="nw" what="everything your agents did" />
        ) : !events.length ? (
          <EmptyState
            key="e0"
            title="Nothing has happened yet."
            body="Once an agent is working, every check and every action it takes lands here — including the ones your limits refused."
            action="Find an agent"
            href="/explore"
          />
        ) : (
          table(
            events,
            'Every row is a real event with a transaction behind it. Blocked rows are kept on purpose — they are the proof your limits hold.',
          )
        ),
        moved.length
          ? table(
              moved,
              'Only the events that moved money. Checks that found nothing to do are in Everything.',
            )
          : empty(
              'Nothing was spent this week.',
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
