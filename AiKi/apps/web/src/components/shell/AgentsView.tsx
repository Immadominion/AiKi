'use client'

import { useRouter } from 'next/navigation'
import { AgentCell, Cell, DataTable, RowActions } from '@/components/shell/DataTable'
import { PageCard } from '@/components/shell/PageCard'
import { SpendMeter } from '@/components/ui/SpendMeter'
import { StatusPill, type Tone } from '@/components/ui/StatusPill'
import { useToast } from '@/components/ui/Toast'
import { AGENT_BG, type AgentKey } from '@/lib/agents'
import { agentHref, jobHref, route } from '@/lib/routes'

interface Hired {
  key: AgentKey
  initial: string
  name: string
  sub: string
  status: string
  tone: Tone
  spent: string
  cap: string
  pct: string
  hot?: boolean
  position: string
  positionStrong?: boolean
  action: string
  actionMsg: string
  /** Present while the agent is actually working, so Open lands on the live job. */
  jobId?: string
}

const HIRED: Hired[] = [
  {
    key: 'guardian',
    initial: 'G',
    name: 'Guardian',
    sub: 'Protecting your Venus loan',
    status: 'All good',
    tone: 'good',
    spent: '$14.20',
    cap: '$250',
    pct: '5.7%',
    position: 'Health factor 1.82',
    positionStrong: true,
    action: 'Pause',
    actionMsg: 'Pause is instant and free — Guardian stops within seconds.',
  },
  {
    key: 'gridly',
    initial: 'G',
    name: 'Gridly',
    sub: 'Managing BNB / USDT',
    status: 'Rebalancing',
    tone: 'work',
    spent: '$31.80',
    cap: '$120',
    pct: '26.5%',
    hot: true,
    position: 'In range · acted 18m ago',
    action: 'Pause',
    actionMsg: 'Pause is instant and free — Gridly stops within seconds.',
  },
  {
    key: 'sentinel',
    initial: 'S',
    name: 'Sentinel',
    sub: 'Alerts only, no spending',
    status: 'Paused by you',
    tone: 'idle',
    spent: '$0.00',
    cap: '$40',
    pct: '0%',
    position: 'Paused 3 days ago',
    action: 'Resume',
    actionMsg: 'Resuming asks you to confirm the limits again first.',
  },
]

export function AgentsView() {
  const say = useToast()
  const router = useRouter()

  const table = (rows: Hired[]) => (
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
      rows={rows.map((h) => ({
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
              { label: h.action, onClick: () => say(h.actionMsg) },
              {
                label: 'Open',
                primary: true,
                onClick: () => router.push(h.jobId ? jobHref(h.jobId) : agentHref(h.key)),
              },
            ]}
          />,
        ],
      }))}
      footnote="Caps are yours: an agent cannot exceed them, and pausing never costs gas. Where a contract holds the limit rather than AiKi, the agent page says so."
    />
  )

  const working = HIRED.filter((h) => h.tone !== 'idle')
  const paused = HIRED.filter((h) => h.tone === 'idle')

  return (
    <PageCard
      title="My agents"
      count={`${working.length} working · ${paused.length} paused`}
      primary="Hire agent"
      onPrimary={() => router.push(route('/explore'))}
      tabs={['Working', 'Paused', 'All']}
      tabHint={[
        'Spend resets on the 1st',
        'Paused agents cannot act and cannot spend',
        `${HIRED.length} authorised in total`,
      ]}
      banner={{
        title: 'One action was blocked overnight.',
        body: 'Guardian tried to spend $91.20 against your $80 per-action limit. Nothing was spent.',
        cta: 'See it',
        onAction: () => router.push(route('/activity')),
      }}
      panels={[table(working), table(paused), table(HIRED)]}
    />
  )
}
