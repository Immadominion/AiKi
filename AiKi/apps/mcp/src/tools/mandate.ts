import { z } from 'zod'
import type { AikiClient } from '../client.js'
import { text } from '../format.js'
import type { Registrar } from '../register.js'
import type { Session } from '../session.js'

/**
 * Setting the limits, and getting them onto a chain.
 *
 * The order matters and is the product: the limits are chosen, the account that
 * will spend under them is deployed, and only then is anything signed. A mandate
 * that is never signed is still a real mandate — AiKi will honour it — but only
 * a signed one is held by a contract instead of by us, and the difference is
 * stated everywhere it comes up rather than buried in a tier letter.
 */

/** Venus on BSC testnet, the one thing a guardian can currently be pointed at. */
const VENUS = {
  asset: '0xA11c8D9DC9b66E209Ef60F0C8D969D3CD988782c',
  market: '0xb7526572FFE56AB9D7489838Bf2E18e3323b441A',
}
const REPAY_BORROW = '0x0e752702'

/** USDT has six decimals. A cap said in dollars has to arrive in base units. */
const toBaseUnits = (usdt: number) => Math.round(usdt * 1_000_000).toString()

const guardianConstraints = (input: {
  perActionUsdt: number
  totalUsdt: number
  expiresInDays: number
}) => [
  {
    kind: 'expiry',
    value: new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString(),
    tier: 'T0',
    label: `expires in ${input.expiresInDays} days`,
  },
  {
    kind: 'contract_allowlist',
    value: [VENUS.market],
    tier: 'T0',
    label: 'only the Venus USDT market',
  },
  { kind: 'selector_allowlist', value: [REPAY_BORROW], tier: 'T0', label: 'only repaying a loan' },
  { kind: 'asset_scope', value: [VENUS.asset], tier: 'T0', label: 'only USDT' },
  {
    kind: 'per_action_cap',
    value: toBaseUnits(input.perActionUsdt),
    tier: 'T0',
    label: `${input.perActionUsdt} USDT per action`,
  },
  {
    kind: 'session_total_cap',
    value: toBaseUnits(input.totalUsdt),
    tier: 'T0',
    label: `${input.totalUsdt} USDT in total`,
  },
]

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
      const constraints = guardianConstraints({
        perActionUsdt: per_action_usdt,
        totalUsdt: total_usdt,
        expiresInDays: expires_in_days,
      })
      const out = await client.post<Enforcement>('/v1/mandates/preview', { constraints })
      return text(
        [
          `Taken together these limits are ${describeTier(out.tier)}.`,
          '',
          // The API's own sentence for each line. It explains WHY a limit lands
          // where it does — "a cap needs the asset, contracts and functions it
          // applies to before the chain can read an amount out of a call" — and
          // that reason is the part somebody can act on.
          ...out.limits.map(
            (l) =>
              `  ${l.label} — ${l.tier}${l.enforcedBy ? ` via ${l.enforcedBy}` : ''}\n      ${l.why}`,
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
        'account the value is spent from if there is not one already — AiKi pays that gas. ' +
        'Returns a mandate id to hire against.',
      inputSchema: {
        per_action_usdt: z.number().positive(),
        total_usdt: z.number().positive(),
        expires_in_days: z.number().int().min(1).max(365).default(30),
      },
    },
    async ({ per_action_usdt, total_usdt, expires_in_days }) => {
      const identity = await session.require()

      // The account first: a delegation names the account it spends from, so
      // there is nothing to sign until one exists.
      let account = await client.get<{ address: string | null }>('/v1/account')
      let deployed = false
      if (!account.address) {
        const made = await client.post<{ address: string }>('/v1/account')
        account = { address: made.address }
        deployed = true
      }

      const constraints = guardianConstraints({
        perActionUsdt: per_action_usdt,
        totalUsdt: total_usdt,
        expiresInDays: expires_in_days,
      })
      const authorization = await client.post<{ id: string }>('/v1/authorizations', { constraints })

      /*
       * Signing is attempted, never assumed. If it fails the mandate still
       * exists and AiKi still honours it — what changes is who is holding the
       * limit, and saying "signed" when nothing was signed is the one thing
       * this product may not get wrong.
       */
      let signed = false
      let signingError: string | null = null
      try {
        const prep = await client.get<{
          domain: Record<string, unknown>
          types: Record<string, unknown>
          primaryType: string
          message: Record<string, unknown>
          unsigned: Record<string, unknown>
        }>(`/v1/authorizations/${authorization.id}/delegation?delegator=${account.address}`)
        /*
         * The bytes to sign are computed by the side that will verify them and
         * signed here unexamined, which is the only arrangement where a
         * disagreement about what a mandate says is impossible. Cast in one
         * place rather than field by field: viem's typed-data types are far
         * more specific than "whatever the API sent", and spreading `as never`
         * across four fields hides that this is one deliberate boundary.
         */
        const signature = await identity.account.signTypedData({
          domain: prep.domain,
          types: prep.types,
          primaryType: prep.primaryType,
          message: prep.message,
        } as Parameters<typeof identity.account.signTypedData>[0])
        await client.post(`/v1/authorizations/${authorization.id}/delegation`, {
          delegation: { ...prep.unsigned, signature },
        })
        signed = true
      } catch (error) {
        signingError = (error as Error).message
      }

      return text(
        [
          `Mandate ${authorization.id} created.`,
          `  at most ${per_action_usdt} USDT per action, ${total_usdt} USDT in total, for ${expires_in_days} days`,
          `  spending from ${account.address}${deployed ? ' (just deployed for you; AiKi paid the gas)' : ''}`,
          '',
          signed
            ? 'Signed. The limits are now held by a contract on BNB testnet, which will refuse anything outside them whatever AiKi does.'
            : `NOT signed${signingError ? `: ${signingError}` : ''}. The limits are real and AiKi will enforce them, but nothing on chain is holding them, so an agent cannot be put on duty under this mandate until it is signed.`,
          '',
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
        'Stop a mandate. Nothing can act under it afterwards. Free, and takes effect at once.',
      inputSchema: { mandate_id: z.string() },
    },
    async ({ mandate_id }) => {
      await session.require()
      await client.post(`/v1/authorizations/${mandate_id}/revoke`)
      return text(`Mandate ${mandate_id} is revoked. Nothing acts under it from here.`)
    },
  )
}
