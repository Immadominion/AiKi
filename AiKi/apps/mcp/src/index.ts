#!/usr/bin/env -S node --import tsx
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { AikiClient } from './client.js'
import type { Registrar } from './register.js'
import { Session } from './session.js'
import { registerDiscovery } from './tools/discover.js'
import { registerMandateTools } from './tools/mandate.js'
import { registerWalletTools } from './tools/wallet.js'
import { registerWorkTools } from './tools/work.js'

/**
 * AiKi, from any language model that speaks MCP.
 *
 * The bet this is making: the reason to look up an agent is to decide whether to
 * let it spend your money, and that decision happens inside a conversation with
 * a model, not on a marketplace listing page. So the evidence and the limits
 * belong where the conversation is.
 *
 * Reading needs nothing — no key, no session, no wallet extension. Acting needs
 * a key, which the model can create on the spot. That split is the whole design:
 * somebody can interrogate every claim AiKi makes before deciding whether it is
 * worth trusting with anything at all.
 */

const API_URL = process.env.AIKI_API_URL ?? 'https://api-production-02ce.up.railway.app'
const RPC_URL = process.env.AIKI_RPC_URL ?? 'https://data-seed-prebsc-1-s1.bnbchain.org:8545'
/*
 * The domain a sign-in message names. It must match what the API expects or the
 * signature is for another site, which is the point of it being in the message.
 */
const AUTH_DOMAIN = process.env.AIKI_AUTH_DOMAIN ?? new URL(API_URL).host

const server = new McpServer(
  { name: 'aiki', version: '0.1.0' },
  {
    instructions: [
      'AiKi is an agent marketplace on BNB Smart Chain. It measures agents rather than listing them,',
      'and it puts limits on what a hired agent may spend.',
      '',
      'Two things to carry into every answer you give from these tools:',
      '',
      '1. The scores are measurements, not endorsements, and most of the registry has never answered',
      '   a probe. Always give the sample size with the score. Never call an agent "best" or',
      '   "recommended" — say what was measured and let the person decide.',
      '2. A limit is only worth what enforces it. Say whether it is held by a contract on chain or',
      '   counted by AiKi, because those fail differently, and never describe an unsigned mandate as',
      '   protected by the chain.',
      '',
      'Reading works with no wallet. Anything that spends needs a key; create_wallet makes one and',
      'tells you the address. Ask before creating a key — it is a real key on a real chain.',
      'Everything here is BNB testnet, against enforcer contracts that have not been audited.',
    ].join('\n'),
  },
)

const client = new AikiClient(API_URL)
const session = new Session(client, AUTH_DOMAIN)
const registrar = server as unknown as Registrar

registerDiscovery(registrar, client)
registerWalletTools(registrar, client, session, RPC_URL)
registerMandateTools(registrar, client, session)
registerWorkTools(registrar, client, session)

await server.connect(new StdioServerTransport())
