import { z } from 'zod'
import type { AikiClient } from '../client.js'
import { executionAccount, executionNetwork, executionRpc } from '../execution.js'
import { text } from '../format.js'
import { balanceOf, createIdentity, keyLocation, loadIdentity } from '../identity.js'
import type { Registrar } from '../register.js'
import type { Session } from '../session.js'

/**
 * Having a wallet without going and getting one first.
 *
 * The usual answer to "you need a key" is "install an extension, write down
 * twelve words, find a faucet" - which ends most conversations before a person
 * has seen what the thing does. So the model can make a key here, say the
 * address out loud, and verify its network before discussing funding. Somebody
 * can act on without having learned anything about delegations first.
 *
 * What is NOT hidden: this is a real key on a real chain, and the person is told
 * where it lives and what it can do. It is defensible because of what sits under
 * it - the key owns an account that holds only what is deliberately sent to it,
 * and everything an agent may do with that account is bounded by caveats a
 * contract enforces. It is not defensible as a place to keep anything else.
 */
/** Base units to something readable, split on the digits so no balance goes through a float. */
function formatAmount(raw: string, decimals: number): string {
  if (!/^\d+$/.test(raw)) return '0'
  const padded = raw.padStart(decimals + 1, '0')
  const whole = padded.slice(0, padded.length - decimals) || '0'
  const fraction = padded
    .slice(padded.length - decimals)
    .slice(0, 6)
    .replace(/0+$/, '')
  if (fraction) return `${whole}.${fraction}`
  // Too small to show is not the same as nothing there.
  if (whole === '0' && !/^0*$/.test(raw)) return '<0.000001'
  return whole
}

/**
 * What the spending account holds, said carefully.
 *
 * Null is not zero. A balance the chain could not be read for is reported as
 * unknown, because telling somebody who has just funded this address that it
 * holds nothing is by far the worse of the two errors. Native BNB is listed
 * with the reason no mandate can move it, since an account funded only with BNB
 * looks ready and is not.
 */
export function holdings(value: unknown): string[] {
  const account = value as {
    balances?: {
      native?: unknown
      tokens?: { symbol?: unknown; decimals?: unknown; raw?: unknown }[]
    } | null
  } | null
  const balances = account?.balances
  if (!balances || typeof balances.native !== 'string' || !Array.isArray(balances.tokens))
    return ['  holdings: could not be read just now, which is not the same as empty']
  const tokens = balances.tokens.filter(
    (token): token is { symbol: string; decimals: number; raw: string } =>
      typeof token?.symbol === 'string' &&
      typeof token?.decimals === 'number' &&
      typeof token?.raw === 'string',
  )
  const lines = [
    `  holds: ${formatAmount(balances.native, 18)} BNB (no mandate can move this)` +
      tokens.map((t) => `, ${formatAmount(t.raw, t.decimals)} ${t.symbol}`).join(''),
  ]
  if (tokens.every((token) => /^0*$/.test(token.raw)))
    lines.push(
      `  no ${tokens.map((token) => token.symbol).join(' or ')} here, so nothing an agent can spend yet.`,
      '  Send some to the address above. Only reviewed tokens are read, so other holdings are not',
      '  listed, and native BNB is not spendable under any mandate.',
    )
  return lines
}

export function registerWalletTools(
  server: Registrar,
  client: AikiClient,
  session: Session,
  rpcUrl?: string,
) {
  server.registerTool(
    'whoami',
    {
      title: 'Who am I acting as',
      description:
        'The address this server acts as, its balance, and the account mandates spend from. ' +
        'Says plainly when there is no key yet.',
      inputSchema: {},
    },
    async () => {
      const identity = loadIdentity()
      if (!identity)
        return text(
          [
            'No key yet, so nothing can be signed or spent.',
            'Everything that only reads - searching agents, passports, comparing, previewing limits - works as it is.',
            '',
            `To act: run create_wallet (a key is made and kept at ${keyLocation}), or set AIKI_PRIVATE_KEY.`,
          ].join('\n'),
        )

      const lines = [
        `Acting as ${identity.account.address}`,
        `  key source: ${identity.source === 'environment' ? 'AIKI_PRIVATE_KEY' : keyLocation}`,
      ]

      try {
        const network = await executionNetwork(client)
        const balance = await balanceOf(
          rpcUrl ?? executionRpc(network.chainId),
          identity.account.address,
        ).catch(() => null)
        lines.push(
          `  balance: ${balance === null ? 'could not verify the wallet RPC balance' : `${balance.amount} ${balance.symbol} on BNB ${balance.network} (${balance.chainId})`}`,
        )
        if (balance && balance.chainId !== network.chainId)
          lines.push(
            `  mandate execution is on BNB ${network.network} (${network.chainId}); the wallet RPC reports a different network.`,
          )
        await session.require(network.chainId)
        const raw = await client.get<unknown>('/v1/account')
        // Validated first, then read for holdings: the network check is what
        // makes the address safe to print, and it must not be skipped just
        // because we also want the balances off the same response.
        const account = executionAccount(raw, network)
        lines.push(
          account.address
            ? `  mandates spend from: ${account.address} (BNB ${network.network}, chain ${account.chainId})`
            : '  no mandate account yet; one is deployed the first time you create a mandate, and AiKi pays that gas',
        )
        if (account.address) lines.push(...holdings(raw))
      } catch (error) {
        lines.push(`  AiKi account or network could not be verified: ${(error as Error).message}`)
      }
      return text(lines.join('\n'))
    },
  )

  server.registerTool(
    'create_wallet',
    {
      title: 'Create a wallet',
      description:
        'Make a key for this machine so mandates can be signed. Kept at ~/.aiki/key, readable only ' +
        'by you, and never sent anywhere. Returns the address to fund. Does nothing if a key already exists.',
      inputSchema: {
        confirm: z
          .boolean()
          .describe(
            'Must be true. Ask the person first - this creates a real key on a real chain.',
          ),
      },
    },
    async ({ confirm }) => {
      if (!confirm)
        return text(
          'Not created. This makes a real private key on this machine, on a real chain. Ask first, then call again with confirm true.',
        )
      const existing = loadIdentity()
      if (existing)
        return text(
          `A key already exists - acting as ${existing.account.address}. Nothing was changed.`,
        )

      const identity = createIdentity()
      session.reset()
      return text(
        [
          `Created. Acting as ${identity.account.address}.`,
          `The key is at ${keyLocation}, mode 0600, and never leaves this machine.`,
          '',
          'It does not need funding to create or sign a mandate: AiKi pays the gas to deploy the ' +
            'account your mandates spend from, and an agent pays its own gas when it acts.',
          'Use whoami to verify the current execution network and mandate account before funding it. ' +
            'Funding a mandate account and buying internal AiKi points are separate payments.',
          '',
          'Back it up if you intend to keep using it. Losing this key means losing control of the ' +
            'account it owns.',
        ].join('\n'),
      )
    },
  )
}
