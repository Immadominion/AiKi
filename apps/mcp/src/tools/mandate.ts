import {
  actionMandateConstraints,
  DELEGATION_DOMAIN_NAME,
  DELEGATION_DOMAIN_VERSION,
  DELEGATION_TYPES,
  type ExecutionNetwork,
  guardianConstraints,
  tokenFor,
} from '@aiki/contracts'
import { z } from 'zod'
import type { AikiClient } from '../client.js'
import { executionAccount, executionNetwork } from '../execution.js'
import { text } from '../format.js'
import type { Registrar } from '../register.js'
import type { Session } from '../session.js'

/**
 * Setting the limits, and getting them onto a chain.
 *
 * The order matters and is the product: the limits are chosen, the account that
 * will spend under them is deployed, and only then is anything signed. A mandate
 * that is never signed is still a real mandate - AiKi will honour it - but only
 * a signed one is held by a contract instead of by us, and the difference is
 * stated everywhere it comes up rather than buried in a tier letter.
 */

interface Enforcement {
  tier: string
  network: string
  audited: boolean
  limits: { kind: string; label: string; tier: string; enforcedBy: string | null; why: string }[]
}

const describeTier = (tier: string) =>
  tier === 'T0'
    ? 'held by a contract on BNB Smart Chain: the chain refuses anything outside it, whatever AiKi does'
    : tier === 'T1'
      ? 'held by a signer that has to co-sign each action'
      : tier === 'T2'
        ? 'counted by AiKi before each action'
        : 'checked after the fact'

/**
 * Sign a stored mandate with the local key, and say honestly whether it worked.
 *
 * Extracted so both mandate shapes go through one set of checks. Two copies of
 * a signing verifier is two places for one of them to quietly stop checking the
 * manager address, and the whole value of this step is that it refuses to sign
 * anything the deployment did not just tell us to sign.
 *
 * Never throws. A mandate that failed to sign still exists and AiKi still
 * honours it; what changes is who holds the limit, and reporting "signed" when
 * nothing was signed is the one thing this must not get wrong.
 */
async function signStoredMandate(input: {
  client: AikiClient
  identity: { account: { signTypedData: (args: never) => Promise<`0x${string}`> } }
  network: ExecutionNetwork
  account: `0x${string}`
  authorizationId: string
}): Promise<{ signed: boolean; error: string | null }> {
  const path = `/v1/authorizations/${encodeURIComponent(input.authorizationId)}/delegation`
  try {
    const prep = await input.client.get<{
      domain: Record<string, unknown>
      types: Record<string, unknown>
      primaryType: string
      message: Record<string, unknown>
      unsigned: Record<string, unknown>
    }>(`${path}?delegator=${input.account}`)
    /*
     * The API compiles the caveats, but its returned signing domain and account
     * must still match the selected deployment and the account just read.
     */
    if (
      prep.domain?.chainId !== input.network.chainId ||
      typeof prep.domain.verifyingContract !== 'string' ||
      prep.domain.verifyingContract.toLowerCase() !== input.network.manager.toLowerCase() ||
      prep.domain.name !== DELEGATION_DOMAIN_NAME ||
      prep.domain.version !== DELEGATION_DOMAIN_VERSION ||
      prep.primaryType !== 'Delegation' ||
      JSON.stringify(prep.types) !== JSON.stringify(DELEGATION_TYPES) ||
      typeof prep.message?.delegator !== 'string' ||
      prep.message.delegator.toLowerCase() !== input.account.toLowerCase() ||
      typeof prep.unsigned?.delegator !== 'string' ||
      prep.unsigned.delegator.toLowerCase() !== input.account.toLowerCase()
    )
      throw new Error(
        'The signing request does not match the verified execution network, manager and mandate account.',
      )
    const signature = await input.identity.account.signTypedData({
      domain: prep.domain,
      types: prep.types,
      primaryType: prep.primaryType,
      message: prep.message,
    } as never)
    await input.client.post(path, { delegation: { ...prep.unsigned, signature } })
    return { signed: true, error: null }
  } catch (error) {
    return { signed: false, error: (error as Error).message }
  }
}

export function registerMandateTools(server: Registrar, client: AikiClient, session: Session) {
  server.registerTool(
    'preview_limits',
    {
      title: 'Preview limits',
      description:
        'What a set of limits would actually be worth before creating anything: which are held ' +
        'by a contract on chain and which are only counted by AiKi. Needs no wallet and creates nothing.',
      inputSchema: {
        per_action_usdt: z.number().positive().describe('Most it may spend in one action.'),
        total_usdt: z
          .number()
          .positive()
          .describe('Most it may spend in total, for the life of the mandate.'),
        expires_in_days: z.number().int().min(1).max(365).default(30),
      },
    },
    async ({ per_action_usdt, total_usdt, expires_in_days }) => {
      const network = await executionNetwork(client)
      const constraints = guardianConstraints({
        chainId: network.chainId,
        perActionUsdt: per_action_usdt,
        totalUsdt: total_usdt,
        expiresInDays: expires_in_days,
      })
      const out = await client.post<Enforcement>('/v1/mandates/preview', { constraints })
      if (out.network !== network.network || out.audited !== network.audited)
        throw new Error(
          'The preview does not match the verified execution deployment. Retry before creating a mandate.',
        )
      return text(
        [
          `Taken together these limits are ${describeTier(out.tier)}.`,
          '',
          // The API's own sentence for each line. It explains WHY a limit lands
          // where it does - "a cap needs the asset, contracts and functions it
          // applies to before the chain can read an amount out of a call" - and
          // that reason is the part somebody can act on.
          ...out.limits.map(
            (l) =>
              `  ${l.label} - ${l.tier}${l.enforcedBy ? ` via ${l.enforcedBy}` : ''}\n      ${l.why}`,
          ),
          '',
          'The total cap does not refill. When it is spent the agent stops until you raise it.',
          `On BNB ${out.network}${out.audited ? '' : ', against enforcer contracts that have not been audited'}.`,
        ].join('\n'),
      )
    },
  )

  server.registerTool(
    'create_mandate',
    {
      title: 'Create a mandate',
      description:
        'Create the limits an agent will work under, and sign them onto the chain. Deploys the ' +
        'account the value is spent from if there is not one already - AiKi pays that gas. ' +
        'Returns a mandate id to hire against.',
      inputSchema: {
        per_action_usdt: z.number().positive(),
        total_usdt: z.number().positive(),
        expires_in_days: z.number().int().min(1).max(365).default(30),
      },
    },
    async ({ per_action_usdt, total_usdt, expires_in_days }) => {
      const network = await executionNetwork(client)
      // Reject caps that cannot be represented on this token before deploying
      // an account or asking the local identity to sign anything.
      const constraints = guardianConstraints({
        chainId: network.chainId,
        perActionUsdt: per_action_usdt,
        totalUsdt: total_usdt,
        expiresInDays: expires_in_days,
      })
      const identity = await session.require(network.chainId)

      // The account first: a delegation names the account it spends from, so
      // there is nothing to sign until one exists.
      let account = executionAccount(await client.get<unknown>('/v1/account'), network)
      let deployed = false
      if (!account.address) {
        account = executionAccount(await client.post<unknown>('/v1/account'), network, true)
        deployed = true
      }

      const authorization = await client.post<{ id: string }>('/v1/authorizations', { constraints })
      if (typeof authorization.id !== 'string' || !authorization.id)
        throw new Error(
          'AiKi did not return a valid mandate identifier. No signature was submitted.',
        )
      // Signing is attempted, never assumed: see signStoredMandate.
      const outcome = await signStoredMandate({
        client,
        identity,
        network,
        account: account.address as `0x${string}`,
        authorizationId: authorization.id,
      })
      const signed = outcome.signed
      const signingError = outcome.error

      return text(
        [
          `Mandate ${authorization.id} created.`,
          `  at most ${per_action_usdt} USDT per action, ${total_usdt} USDT in total, for ${expires_in_days} days`,
          `  spending from ${account.address}${deployed ? ' (just deployed for you; AiKi paid the gas)' : ''}`,
          '',
          signed
            ? `Signed for BNB ${network.network} (${network.chainId}). AiKi accepted the delegation for this account${network.audited ? '.' : '; the enforcer deployment is not audited.'}`
            : `NOT signed${signingError ? `: ${signingError}` : ''}. The limits are real and AiKi will enforce them, but nothing on chain is holding them, so an agent cannot be put on duty under this mandate until it is signed.`,
          '',
          'The total cap does not refill.',
        ].join('\n'),
      )
    },
  )

  server.registerTool(
    'create_action_mandate',
    {
      title: 'Create a mandate for moving a token',
      description:
        'Limits that let an agent move ONE token to addresses you name, and sign them onto the ' +
        'chain. Different from create_mandate, which only ever permits repaying a Venus loan. ' +
        'Deploys the spending account if there is not one; AiKi pays that gas. The token, the ' +
        'contract, the function and both caps end up held by contracts. The destination list is ' +
        'held by AiKi alone. Naming no destination is refused.',
      inputSchema: {
        token: z.string().describe('Symbol, for example USDT.'),
        to: z
          .array(z.string())
          .min(1)
          .max(32)
          .describe('Addresses the agent may send to. Required: a list of none is unbounded.'),
        can: z
          .array(z.enum(['send', 'approve']))
          .min(1)
          .default(['send'])
          .describe('send permits transfer. approve permits letting a contract take the token.'),
        per_action: z
          .number()
          .positive()
          .describe('Most it may move in one action, in whole tokens.'),
        total: z.number().positive().describe('Most it may move in total, in whole tokens.'),
        expires_in_days: z.number().int().min(1).max(365).default(30),
      },
    },
    /*
     * Annotated because `Registrar` types every handler argument as `never`,
     * which is fine while a tool only passes its arguments along and stops
     * compiling the moment one calls a method on them.
     */
    async ({
      token,
      to,
      can,
      per_action,
      total,
      expires_in_days,
    }: {
      token: string
      to: string[]
      can: ('send' | 'approve')[]
      per_action: number
      total: number
      expires_in_days: number
    }) => {
      const network = await executionNetwork(client)
      // Validate the whole shape before deploying an account or signing.
      const constraints = actionMandateConstraints({
        chainId: network.chainId,
        symbol: token,
        recipients: to,
        can,
        perAction: per_action,
        total,
        expiresInDays: expires_in_days,
      })
      const resolved = tokenFor(network.chainId, token)
      const identity = await session.require(network.chainId)

      let account = executionAccount(await client.get<unknown>('/v1/account'), network)
      let deployed = false
      if (!account.address) {
        account = executionAccount(await client.post<unknown>('/v1/account'), network, true)
        deployed = true
      }

      const authorization = await client.post<{ id: string }>('/v1/authorizations', { constraints })
      if (typeof authorization.id !== 'string' || !authorization.id)
        throw new Error(
          'AiKi did not return a valid mandate identifier. No signature was submitted.',
        )
      const outcome = await signStoredMandate({
        client,
        identity,
        network,
        account: account.address as `0x${string}`,
        authorizationId: authorization.id,
      })

      return text(
        [
          `Mandate ${authorization.id} created.`,
          `  at most ${per_action} ${resolved.symbol} per action, ${total} ${resolved.symbol} in total, for ${expires_in_days} days`,
          `  may ${can.join(' and ')} only ${resolved.symbol}`,
          `  only to ${to.map((entry) => entry.toLowerCase()).join(', ')}`,
          `  spending from ${account.address}${deployed ? ' (just deployed for you; AiKi paid the gas)' : ''}`,
          '',
          outcome.signed
            ? `Signed for BNB ${network.network} (${network.chainId}). AiKi accepted the delegation for this account${network.audited ? '.' : '; the enforcer deployment is not audited.'}`
            : `NOT signed${outcome.error ? `: ${outcome.error}` : ''}. The limits are real and AiKi will enforce them, but nothing on chain is holding them, so send_token will be refused until it is signed.`,
          '',
          'The token, the contract, the function and both caps are held by contracts on chain.',
          'The destination list is NOT. AiKi reads the destination out of each call and refuses to',
          'relay anything else, which holds against a confused agent and not against a compromised AiKi.',
          'The total cap does not refill.',
        ].join('\n'),
      )
    },
  )

  server.registerTool(
    'revoke_mandate',
    {
      title: 'Revoke a mandate',
      description:
        'Stop a mandate inside AiKi. A signed on-chain delegation requires separate on-chain revocation.',
      inputSchema: { mandate_id: z.string() },
    },
    async ({ mandate_id }) => {
      await session.require()
      await client.post(`/v1/authorizations/${mandate_id}/revoke`)
      return text(
        `Mandate ${mandate_id} is stopped inside AiKi. If it was signed, revoking the on-chain delegation requires a separate on-chain action.`,
      )
    },
  )
}
