import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AikiClient } from '../client.js'
import { text } from '../format.js'
import type { Registrar } from '../register.js'
import type { Session } from '../session.js'

/**
 * Putting an agent to work, and finding out what it did.
 *
 * `watch_position` is the one that matters. Everything else here can be done by
 * asking; a watch is the agent acting while nobody is asking, which is the only
 * reason to hire one rather than do it yourself.
 */

const VENUS = {
  asset: '0xA11c8D9DC9b66E209Ef60F0C8D969D3CD988782c',
  market: '0xb7526572FFE56AB9D7489838Bf2E18e3323b441A',
}

interface Job {
  id: string
  status: string
  events: { type: string; at: string; detail: string }[]
}

interface Watch {
  status: string
  minimumHealthFactor: string
  lastCheckedAt?: string
  lastActedAt?: string
  lastReason?: string
  remaining?: string | null
}

export function registerWorkTools(server: Registrar, client: AikiClient, session: Session) {
  server.registerTool(
    'hire',
    {
      title: 'Hire under a mandate',
      description:
        'Start a job under a mandate you created. Returns a job id, which is what a watch and ' +
        'every recorded verdict hang off.',
      inputSchema: { mandate_id: z.string() },
    },
    async ({ mandate_id }) => {
      await session.require()
      const job = await client.post<{ id: string; status: string }>(
        '/v1/jobs',
        { authorizationId: mandate_id },
        { 'idempotency-key': `mcp-${randomUUID()}` },
      )
      return text(
        `Job ${job.id} is ${job.status} under mandate ${mandate_id}. ` +
          'Nothing has been spent. To have it act on its own, put it on watch.',
      )
    },
  )

  server.registerTool(
    'watch_position',
    {
      title: 'Put an agent on duty',
      description:
        'Have the agent check your Venus position on a timer and repay under the mandate if the ' +
        'health factor falls below your line — without waiting for you. This is the only tool here ' +
        'that causes money to move when nobody is asking, so it refuses a mandate that is unsigned ' +
        'or has no total cap.',
      inputSchema: {
        job_id: z.string(),
        minimum_health_factor: z
          .string()
          .regex(/^\d+(\.\d{1,18})?$/)
          .default('1.25')
          .describe('The line it defends. Higher acts earlier and spends more.'),
      },
    },
    async ({ job_id, minimum_health_factor }) => {
      await session.require()
      const account = await client.get<{ address: string | null }>('/v1/account')
      if (!account.address)
        return text('You have no account for a mandate to spend from yet. Create a mandate first.')

      const watch = await client.post<Watch>(`/v1/jobs/${job_id}/watch`, {
        account: account.address,
        chainId: 97,
        minimumHealthFactor: minimum_health_factor,
        asset: VENUS.asset,
        market: VENUS.market,
      })
      return text(
        `On duty. It will check ${account.address} on its own and repay if the health factor ` +
          `falls below ${watch.minimumHealthFactor}, up to what the mandate allows. ` +
          'Ask for its status any time; a pass where it does nothing is the normal case and is recorded too.',
      )
    },
  )

  server.registerTool(
    'watch_status',
    {
      title: 'Watch status',
      description:
        'When the agent last looked, when it last acted, and what it decided on its last pass.',
      inputSchema: { job_id: z.string() },
    },
    async ({ job_id }) => {
      await session.require()
      try {
        const w = await client.get<Watch>(`/v1/jobs/${job_id}/watch`)
        return text(
          [
            `Watch is ${w.status}, defending a health factor of ${w.minimumHealthFactor}.`,
            `  last looked: ${w.lastCheckedAt ?? 'not yet'}`,
            `  last acted:  ${w.lastActedAt ?? 'has not needed to'}`,
            w.lastReason ? `  last pass:   ${w.lastReason}` : '',
            w.remaining ? `  still allowed to spend: ${Number(w.remaining) / 1e6} USDT` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        )
      } catch {
        return text('Nothing is watching that job. Use watch_position to put an agent on duty.')
      }
    },
  )

  server.registerTool(
    'stop_watching',
    {
      title: 'Stand down',
      description: 'Take the agent off duty. It stops acting on its own; the mandate is untouched.',
      inputSchema: { job_id: z.string() },
    },
    async ({ job_id }) => {
      await session.require()
      await client.post(`/v1/jobs/${job_id}/watch/stop`)
      return text('Stood down. Nothing acts on its own under that job from here.')
    },
  )

  server.registerTool(
    'job_record',
    {
      title: 'What a job did',
      description:
        'Every verdict recorded against a job, refusals included. This is the record AiKi kept, ' +
        'not a summary of it.',
      inputSchema: { job_id: z.string() },
    },
    async ({ job_id }) => {
      await session.require()
      const job = await client.get<Job>(`/v1/jobs/${job_id}`)
      if (!job.events.length) return text(`Job ${job.id} is ${job.status}. Nothing recorded yet.`)
      return text(
        [
          `Job ${job.id} — ${job.status}`,
          ...job.events.map((e) => `  ${e.at} [${e.type}] ${e.detail}`),
        ].join('\n'),
      )
    },
  )
}
