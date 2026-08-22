'use client'

import { AgentCell, Cell, DataTable, RowActions } from '@/components/shell/DataTable'
import { PageCard } from '@/components/shell/PageCard'
import { EvidenceBars } from '@/components/ui/EvidenceBars'
import { useToast } from '@/components/ui/Toast'
import { AGENT_BG, AGENTS } from '@/lib/agents'

export default function ExplorePage() {
  const say = useToast()

  return (
    <PageCard
      title="Explore"
      count="12 agents · 4 kinds of work"
      primary="Compare"
      tabs={['Suggested', 'All', 'Tested most']}
      tabHint="Ranked by evidence AiKi collected itself"
      banner={{
        title: 'Suggested for your positions.',
        body: 'You hold a Venus loan and a BNB / USDT pool — these four agents claim exactly that work.',
        cta: 'Why these',
      }}
    >
      <DataTable
        cols="minmax(200px,1.5fr) minmax(150px,1.1fr) minmax(180px,1.3fr) 100px 152px"
        minWidth="790px"
        columns={[
          { label: 'Agent', glyph: '◍' },
          { label: 'What it does', glyph: '⌬' },
          { label: 'Evidence AiKi collected', glyph: '⊞', sortable: true },
          { label: 'Price', glyph: '⌁', sortable: true },
          { label: '', glyph: '', align: 'end' },
        ]}
        rows={AGENTS.map((a) => ({
          id: a.key,
          cells: [
            <AgentCell
              key="a"
              initial={a.initial}
              name={a.name}
              sub={a.works}
              bg={AGENT_BG[a.key]}
            />,
            <Cell key="b" color="var(--color-body)">
              {a.does}
            </Cell>,
            <EvidenceBars key="c" filled={a.bars} label={a.evidence} tone={a.evidenceTone} />,
            <Cell key="d" weight={700} color="var(--color-ink-app)">
              {a.price}
            </Cell>,
            <RowActions
              key="e"
              actions={[
                { label: 'Save', onClick: () => say(`${a.name} saved.`) },
                {
                  label: 'View',
                  primary: true,
                  onClick: () =>
                    say(`${a.name}'s page and the hiring flow come next in the journey.`),
                },
              ]}
            />,
          ],
        }))}
        footnote="Each bar is one batch of checks AiKi ran itself, not a rating and not self-reported uptime. Empty bars mean missing evidence — a new agent is not a bad agent."
      />
    </PageCard>
  )
}
