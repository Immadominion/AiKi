/**
 * A third-party agent, written the way a stranger would write one.
 *
 * It imports `@aiki/sdk` and nothing else from this repository: no internal
 * helpers, no prober knowledge, no access to how AiKi grades it. That
 * separation is the point. If AiKi's own prober classifies this LIVE, it is
 * because the SDK is enough on its own to build an agent that answers honestly.
 */
import { type AgentDefinition, serve, serviceEndpoint } from '@aiki/sdk'

const watcher: AgentDefinition = {
  agentId: process.env.AGENT_ID ?? '777001',
  chainId: 56,
  registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  name: 'Venus Watcher',
  description: 'Reports the health factor of a Venus position and how close it is to liquidation.',
  skills: [
    {
      id: 'assess_health_factor',
      name: 'Assess health factor',
      description:
        'Given an account, report its Venus health factor and the distance to liquidation.',
      category: 'health_factor',
    },
  ],
  async assess({ skillId, params }) {
    const account = params.account ?? '0x0000000000000000000000000000000000000000'
    // A real agent would read Venus here. What matters for the probe is that the
    // answer depends on what was asked, and that an answer it cannot give is
    // reported as one it cannot give.
    if (!/^0x[0-9a-fA-F]{40}$/.test(account))
      throw new Error(`"${account}" is not an address, so there is no position to assess.`)
    return {
      skillId,
      account,
      healthFactor: '1.47',
      liquidationAt: '1.00',
      source: 'venus:comptroller',
      caveat: 'Example agent. The figures are fixed, and it says so rather than implying a read.',
    }
  },
}

const port = Number(process.env.PORT ?? '8791')
await serve([watcher], { port, host: '127.0.0.1' })
console.log(
  JSON.stringify(
    { listening: port, service: serviceEndpoint(`http://127.0.0.1:${port}`, watcher) },
    null,
    2,
  ),
)
