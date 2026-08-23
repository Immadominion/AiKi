'use client'

import { useRouter } from 'next/navigation'
import { AgentCell, Cell, DataTable, RowActions } from '@/components/shell/DataTable'
import { EmptyState, NoWallet } from '@/components/shell/EmptyState'
import { PageCard } from '@/components/shell/PageCard'
import { PageSkeleton } from '@/components/ui/Skeleton'
import { SpendMeter } from '@/components/ui/SpendMeter'
import { StatusPill } from '@/components/ui/StatusPill'
import { useToast } from '@/components/ui/Toast'
import { AGENT_BG } from '@/lib/agents'
import { type HiredRow, hiredRows } from '@/lib/present'
import { jobHref, route } from '@/lib/routes'
import { useMock } from '@/mock/store'

export function AgentsView() {
  const say = useToast()
  const router = useRouter()
  const { state, ready, pause, resume } = useMock()

  const rows = hiredRows(state.hires, state.jobs)
  const working = rows.filter((r) => r.tone !== 'idle')
  const paused = rows.filter((r) => r.tone === 'idle')
  const blocked = state.jobs.filter((j) => j.blockedOnce).length

  const table = (data: HiredRow[]) => (
    <DataTable
      cols="minmax(200px,1.4fr) 132px minmax(160px,1.2fr) minmax(130px,1fr) 146px"
      minWidth="780px"
      columns={[
        { label: 'Agent', glyph: '◍' },
        { label: 'Status', glyph: '◔' },
        { label: 'Spent of your cap', glyph: '⌁', sortable: true },
        { label: 'Position', glyph: '⊞' },
        { label: '', glyph: '', align: 'end' },
      ]}
      rows={data.map((h) => ({
        id: h.key,
        cells: [
          <AgentCell key="a" initial={h.initial} name={h.name} sub={h.sub} bg={AGENT_BG[h.key]} />,
          <StatusPill key="b" label={h.status} tone={h.tone} />,
          <SpendMeter key="c" value={h.spent} cap={h.cap} pct={h.pct} hot={h.hot} />,
          <Cell
            key="d"
            weight={h.positionStrong ? 700 : 500}
            color={
              h.tone === 'idle'
                ? 'var(--color-muted)'
                : h.positionStrong
                  ? 'var(--color-ink-app)'
                  : 'var(--color-body)'
            }
          >
            {h.position}
          </Cell>,
          <RowActions
            key="e"
            actions={[
              {
                label: h.action,
                onClick: () => {
                  if (h.action === 'Pause') {
                    pause(h.key)
                    say(`${h.name} paused. It stops within seconds and it costs nothing.`)
                  } else {
                    resume(h.key)
                    say(`${h.name} resumed under the same limits.`)
                  }
                },
              },
              { label: 'Open', primary: true, onClick: () => router.push(jobHref(h.jobId)) },
            ]}
          />,
        ],
      }))}
      footnote="Caps are yours: an agent cannot exceed them, and pausing never costs gas. Where a contract holds the limit rather than AiKi, the agent page says so."
    />
  )

  const nothing = !state.connected ? (
    <NoWallet what="anything working for you" />
  ) : (
    <EmptyState
      title="Nothing is working for you yet."
      body="Hiring an agent takes one signature and the limits are yours to set. Nothing runs until you do, and pausing afterwards is instant and free."
      action="Find an agent"
      href="/explore"
    />
  )

  if (!ready) return <PageSkeleton rows={3} />

  return (
    <PageCard
      title="My agents"
      count={rows.length ? `${working.length} working · ${paused.length} paused` : ''}
      primary="Hire agent"
      onPrimary={() => router.push(route('/explore'))}
      tabs={['Working', 'Paused', 'All']}
      tabHint={[
        'Caps reset at the start of each period',
        'Paused agents cannot act and cannot spend',
        `${rows.length} authorised in total`,
      ]}
      banner={
        blocked
          ? {
              title: `${blocked === 1 ? 'An action was' : `${blocked} actions were`} blocked.`,
              body: 'An agent asked for more than you allowed and the mandate refused it. Nothing was signed and nothing was spent.',
              cta: 'See it',
              onAction: () => router.push(route('/activity')),
            }
          : undefined
      }
      panels={[
        working.length ? table(working) : nothing,
        paused.length ? (
          table(paused)
        ) : rows.length ? (
          <EmptyState
            key="np"
            title="Nothing is paused."
            body="Everything you have hired is currently allowed to act, inside the limits you set."
          />
        ) : (
          nothing
        ),
        rows.length ? table(rows) : nothing,
      ]}
    />
  )
}
