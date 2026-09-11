import { randomUUID } from 'node:crypto'
import { amountUnits, guardianFor, tokenFor } from '@aiki/contracts'
import { encodeFunctionData, formatUnits, parseAbi } from 'viem'
import { z } from 'zod'
import { type AikiClient, AikiError } from '../client.js'
import { executionAccount, executionNetwork } from '../execution.js'
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

interface Job {
  id: string
  status: string
  events: { type: string; at: string; detail: string }[]
}

interface Watch {
  chainId: number
  asset?: string
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
    'send_token',
    {
      title: 'Send a token under a mandate',
      description:
        'Move tokens out of the spending account, to an address the mandate names. This is the ' +
        'one tool here that moves money on chain. Needs a job started from a SIGNED action ' +
        'mandate. AiKi checks the mandate, then the chain checks it again, and a refusal from ' +
        'either is reported as itself. Ask the person before calling it.',
      inputSchema: {
        job_id: z.string(),
        token: z.string().describe('Symbol, for example USDT.'),
        to: z.string().describe('Destination address. Must be one the mandate names.'),
        amount: z.number().positive().describe('Whole tokens, not base units.'),
        why: z.string().max(300).optional().describe('One line, shown to the person and stored.'),
      },
    },
    async ({
      job_id,
      token,
      to,
      amount,
      why,
    }: {
      job_id: string
      token: string
      to: string
      amount: number
      why?: string
    }) => {
      const network = await executionNetwork(client)
      const resolved = tokenFor(network.chainId, token)
      const units = amountUnits(amount, resolved.decimals, resolved.symbol)
      const destination = to.toLowerCase()
      if (!/^0x[0-9a-f]{40}$/.test(destination) || /^0x0+$/.test(destination))
        throw new Error('Give a destination address the mandate names.')
      await session.require(network.chainId)

      /*
       * The calldata is built here from named parts, never taken from the
       * caller. An amount somebody states and calldata somebody supplies are
       * two different numbers, and the chain executes the calldata.
       */
      const callData = encodeFunctionData({
        abi: parseAbi(['function transfer(address to, uint256 amount) returns (bool)']),
        functionName: 'transfer',
        args: [destination as `0x${string}`, BigInt(units)],
      })
      const outcome = await client.post<{
        policy: { allow: boolean; rule: string; reason: string }
        chain?: { status: string; transactionHash?: string; revertReason?: string }
        heldBy?: string
      }>(`/v1/jobs/${encodeURIComponent(job_id)}/actions`, {
        target: resolved.address,
        selector: '0xa9059cbb',
        asset: resolved.address,
        amount: units,
        callData,
        ...(why ? { why } : {}),
      })

      const lines = [`${amount} ${resolved.symbol} to ${destination}, under job ${job_id}.`, '']
      if (!outcome.policy?.allow) {
        lines.push(
          `Refused by AiKi before it reached the chain: ${outcome.policy?.rule} - ${outcome.policy?.reason}`,
          'Nothing was sent and nothing was spent.',
          ...(outcome.policy?.rule === 'unsigned'
            ? ['Sign the mandate, then try this again. Do not create a second mandate.']
            : []),
        )
        return text(lines.join('\n'))
      }
      const chain = outcome.chain
      if (!chain) {
        lines.push(
          'Allowed by the mandate, but this deployment is not configured to reach a chain, so',
          'nothing was submitted and AiKi was the only thing holding the limit.',
          'This is a deployment setting, not something the mandate or the signature can fix.',
        )
        return text(lines.join('\n'))
      }
      if (chain.status === 'landed')
        lines.push(`Landed on BNB ${network.network}: ${chain.transactionHash}`)
      else if (chain.status === 'refused')
        lines.push(
          `The chain would not accept it: ${chain.revertReason ?? 'refused'}`,
          'No transaction exists, so there is no hash to look up. Nothing was spent.',
        )
      else if (chain.status === 'reverted')
        lines.push(
          `The chain rejected it: ${chain.revertReason ?? 'reverted'}`,
          `Transaction ${chain.transactionHash} exists and cost gas. Nothing moved.`,
        )
      else lines.push(`Outcome is ${chain.status}. Do not assume it failed; check the job record.`)
      return text(lines.join('\n'))
    },
  )

  server.registerTool(
    'watch_position',
    {
      title: 'Put an agent on duty',
      description:
        'Have the agent check your Venus position on a timer and repay under the mandate if the ' +
        'health factor falls below your line - without waiting for you. This is the only tool here ' +
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
      const network = await executionNetwork(client)
      await session.require(network.chainId)
      const account = executionAccount(await client.get<unknown>('/v1/account'), network)
      if (!account.address)
        return text('You have no account for a mandate to spend from yet. Create a mandate first.')

      const watch = await client.post<Watch>(`/v1/jobs/${job_id}/watch`, {
        account: account.address,
        chainId: account.chainId,
        minimumHealthFactor: minimum_health_factor,
        asset: network.guardian.asset,
        market: network.guardian.market,
      })
      return text(
        `On duty on BNB ${network.network} (${account.chainId}). It will check ${account.address} on its own and repay if the health factor ` +
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
        const guardian = guardianFor(w.chainId)
        if (w.asset !== undefined && w.asset.toLowerCase() !== guardian.asset.toLowerCase())
          throw new Error(
            'The watch asset does not match the recorded network. Its remaining amount could not be verified.',
          )
        return text(
          [
            `Watch is ${w.status} on BNB ${guardian.network} (${w.chainId}), defending a health factor of ${w.minimumHealthFactor}.`,
            `  last looked: ${w.lastCheckedAt ?? 'not yet'}`,
            `  last acted:  ${w.lastActedAt ?? 'has not needed to'}`,
            w.lastReason ? `  last pass:   ${w.lastReason}` : '',
            w.remaining !== undefined && w.remaining !== null
              ? `  still allowed to spend: ${formatUnits(BigInt(w.remaining), guardian.decimals)} USDT`
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
        )
      } catch (error) {
        if (error instanceof AikiError && error.status === 404)
          return text('Nothing is watching that job. Use watch_position to put an agent on duty.')
        throw error
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
          `Job ${job.id} - ${job.status}`,
          ...job.events.map((e) => `  ${e.at} [${e.type}] ${e.detail}`),
        ].join('\n'),
      )
    },
  )
}
