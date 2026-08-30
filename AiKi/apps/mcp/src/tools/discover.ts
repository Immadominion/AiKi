import type { ProjectedPassport, ProjectedSearchResponse } from '@aiki/contracts'
import { z } from 'zod'
import type { AikiClient } from '../client.js'
import { EVIDENCE_CAVEAT, passportDetail, passportLine, text } from '../format.js'
import type { Registrar } from '../register.js'

/**
 * Finding out what is out there, and what is actually known about it.
 *
 * Every tool here works with no key and no session. That is deliberate: the
 * evidence is the product, and putting a wallet in front of reading it would
 * make AiKi one more thing you have to sign into before you can judge whether
 * it is worth signing into.
 */
export function registerDiscovery(server: Registrar, client: AikiClient) {
  server.registerTool(
    'search_agents',
    {
      title: 'Search agents',
      description:
        'Find agents on the ERC-8004 registry, with what AiKi has measured about each. ' +
        'By default only agents that answered a probe are returned; pass include_unverified ' +
        'to see the rest, which is most of the registry.',
      inputSchema: {
        query: z.string().optional().describe('What you need done, in plain words.'),
        limit: z.number().int().min(1).max(25).optional(),
        include_unverified: z
          .boolean()
          .optional()
          .describe('Include agents AiKi could not reach or has never probed.'),
      },
    },
    async ({ query, limit, include_unverified }) => {
      const body: Record<string, unknown> = { limit: limit ?? 8 }
      if (query) body.query = query
      if (include_unverified)
        body.filters = {
          liveness: [
            'LIVE',
            'DEGRADED',
            'DECLARED_ONLY',
            'UNREACHABLE',
            'PLACEHOLDER_URL',
            'IMPOSTOR_STATIC',
          ],
        }
      const found = await client.post<ProjectedSearchResponse>('/v1/search', body)

      /*
       * A query that matches nothing is the common case, and answering "no
       * results" would be misleading about why.
       *
       * AiKi's search is a substring match over the NAME an agent registered,
       * and names in this registry do not describe capabilities — the verified
       * ones are called things like "Q402 Agent" and "SAT 578". So a sensible
       * question like "an agent that can protect my Venus loan" matches nothing,
       * and the honest answer is not "there are none" but "nothing is named
       * that; here is everything AiKi has actually verified, judge it yourself".
       */
      if (!found.results.length && query) {
        const { query: _dropped, ...rest } = body
        const all = await client.post<ProjectedSearchResponse>('/v1/search', rest)
        return text(
          [
            `No agent is NAMED anything like "${query}".`,
            '',
            'AiKi searches the name an agent registered, and names in this registry rarely say what ' +
              'an agent does, so this is usually a fact about the naming rather than about what is available. ' +
              `Here is what AiKi has verified instead — ${all.results.length} of ${all.total}:`,
            '',
            ...all.results.map((r) => `  ${passportLine(r)}`),
            '',
            'Use agent_passport on any of these to see what was actually measured.',
            '',
            EVIDENCE_CAVEAT,
          ].join('\n'),
        )
      }

      if (!found.results.length)
        return text(
          `AiKi holds no agents matching that. It has evidence on ${found.total} in total; ` +
            'try include_unverified to see the rest of the registry.',
        )

      return text(
        [
          `${found.results.length} of ${found.total} agents:`,
          '',
          ...found.results.map((r) => `  ${passportLine(r)}`),
          '',
          EVIDENCE_CAVEAT,
        ].join('\n'),
      )
    },
  )

  server.registerTool(
    'agent_passport',
    {
      title: 'Agent passport',
      description:
        'Everything AiKi has measured about one agent: liveness, proof score with its sample ' +
        'size and confidence interval, registration checks, and any risks found.',
      inputSchema: { agent_id: z.string().describe('The agent id from search_agents.') },
    },
    async ({ agent_id }) => {
      const p = await client.get<ProjectedPassport>(
        `/v1/agents/${encodeURIComponent(agent_id)}/passport`,
      )
      return text(`${passportDetail(p)}\n\n${EVIDENCE_CAVEAT}`)
    },
  )

  server.registerTool(
    'compare_agents',
    {
      title: 'Compare agents',
      description: 'Put several agents side by side on what AiKi actually measured.',
      inputSchema: { agent_ids: z.array(z.string()).min(2).max(6) },
    },
    async ({ agent_ids }) => {
      const out = await client.post<{ agents: ProjectedPassport[] }>('/v1/compare', {
        agentIds: agent_ids,
      })
      return text([...out.agents.map((a) => passportDetail(a)), '', EVIDENCE_CAVEAT].join('\n\n'))
    },
  )

  server.registerTool(
    'ecosystem_stats',
    {
      title: 'Ecosystem stats',
      description:
        'How much of the registry AiKi has indexed and probed, and how those probes came out. ' +
        'Useful for judging how much any single score is worth.',
      inputSchema: {},
    },
    async () => {
      const s = await client.get<{
        indexed: { totalAgents: number; lastIndexedBlock: number; complete: boolean }
        probed: { agentsProbed: number; byState: Record<string, number>; lastProbeSweepAt: string }
      }>('/v1/stats')
      const states = Object.entries(s.probed.byState)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `  ${k}: ${v}`)
      return text(
        [
          `Indexed ${s.indexed.totalAgents} agents up to block ${s.indexed.lastIndexedBlock}` +
            `${s.indexed.complete ? '' : ' (still catching up on the registry)'}.`,
          `Probed ${s.probed.agentsProbed} of them, last sweep ${s.probed.lastProbeSweepAt}:`,
          ...states,
          '',
          'Most of the registry has never answered a probe. That is a fact about the registry, ' +
            'not about AiKi, and it is the reason the scores here carry their sample sizes.',
        ].join('\n'),
      )
    },
  )
}
