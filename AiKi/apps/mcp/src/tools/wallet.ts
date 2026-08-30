import { z } from 'zod'
import type { AikiClient } from '../client.js'
import { text } from '../format.js'
import { balanceOf, createIdentity, keyLocation, loadIdentity } from '../identity.js'
import type { Registrar } from '../register.js'
import type { Session } from '../session.js'

/**
 * Having a wallet without going and getting one first.
 *
 * The usual answer to "you need a key" is "install an extension, write down
 * twelve words, find a faucet" — which ends most conversations before a person
 * has seen what the thing does. So the model can make a key here, say the
 * address out loud, and ask for some testnet BNB. That is a sentence somebody
 * can act on without having learned anything about delegations first.
 *
 * What is NOT hidden: this is a real key on a real chain, and the person is told
 * where it lives and what it can do. It is defensible because of what sits under
 * it — the key owns an account that holds only what is deliberately sent to it,
 * and everything an agent may do with that account is bounded by caveats a
 * contract enforces. It is not defensible as a place to keep anything else.
 */
export function registerWalletTools(
  server: Registrar,
  client: AikiClient,
  session: Session,
  rpcUrl: string,
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
            'Everything that only reads — searching agents, passports, comparing, previewing limits — works as it is.',
            '',
            `To act: run create_wallet (a key is made and kept at ${keyLocation}), or set AIKI_PRIVATE_KEY.`,
          ].join('\n'),
        )

      const balance = await balanceOf(rpcUrl, identity.account.address).catch(() => null)
      const lines = [
        `Acting as ${identity.account.address}`,
        `  key source: ${identity.source === 'environment' ? 'AIKI_PRIVATE_KEY' : keyLocation}`,
        `  balance: ${balance === null ? 'could not read' : `${balance} tBNB on BNB testnet`}`,
      ]

      try {
        await session.require()
        const account = await client.get<{ address: string | null; network: string | null }>(
          '/v1/account',
        )
        lines.push(
          account.address
            ? `  mandates spend from: ${account.address} (${account.network ?? 'testnet'})`
            : '  no mandate account yet; one is deployed the first time you create a mandate, and AiKi pays that gas',
        )
      } catch (error) {
        lines.push(`  not signed in to AiKi: ${(error as Error).message}`)
      }

      if (balance !== null && Number(balance) === 0)
        lines.push(
          '',
          'This address holds no tBNB. It does not need any to create or sign a mandate — AiKi pays ' +
            'the gas to deploy the account, and the agent pays its own gas to act. It does need USDT ' +
            'in the mandate account before there is anything for an agent to spend.',
        )
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
            'Must be true. Ask the person first — this creates a real key on a real chain.',
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
          `A key already exists — acting as ${existing.account.address}. Nothing was changed.`,
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
          'What it does need is something to spend. Send BNB testnet USDT to the mandate account, ' +
            'which whoami will show once a mandate exists.',
          '',
          'Back it up if you intend to keep using it. Losing this key means losing control of the ' +
            'account it owns — though anything held there can only ever be spent inside a mandate.',
        ].join('\n'),
      )
    },
  )
}
