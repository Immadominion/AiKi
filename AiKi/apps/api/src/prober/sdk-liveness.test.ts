import { createHash } from 'node:crypto'
import type { Server } from 'node:http'
import { type AgentDefinition, handle, registrationDocument, serve } from '@aiki/sdk'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { classify, d8_reciprocalProof, type ProbeSample } from './detect.js'
import { d1Variants } from './probe.js'

/**
 * The marketplace claim, graded by the thing that grades everyone else.
 *
 * AiKi says eleven of 1,143 registry agents answer like agents. That number is
 * only worth something if a stranger can build one that clears the same bar,
 * using nothing but the published SDK. So this test builds an agent out of
 * @aiki/sdk, serves it, probes it exactly as the sweep would, and puts the
 * result through the same `classify` the sweep uses. Nothing here is a mock: the
 * grading code is the production code, and it does not know who wrote the agent.
 */
const REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'
const CAIP = `eip155:56:${REGISTRY.toLowerCase()}`
const md5 = (s: string) => createHash('md5').update(s).digest('hex')

const honest: AgentDefinition = {
  agentId: '777001',
  chainId: 56,
  registry: REGISTRY,
  name: 'Venus Watcher',
  description: 'Reports the health factor of a Venus position.',
  skills: [{ id: 'assess_health_factor', name: 'Assess health factor', description: 'x' }],
  assess: ({ params }) => ({ account: params.account ?? 'none', healthFactor: '1.47' }),
}

let server: Server
let port = 0

beforeAll(async () => {
  server = await serve([honest], { port: 0, host: '127.0.0.1' })
  const address = server.address()
  port = typeof address === 'object' && address ? address.port : 0
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** Probe an endpoint the way the sweep does: the real id, a nonsense id, a non-numeric one. */
async function probe(endpoint: string) {
  const samples: ProbeSample[] = []
  let primaryBody = ''
  for (const variant of d1Variants(endpoint)) {
    const started = Date.now()
    const response = await fetch(variant.url)
    const body = await response.text()
    if (variant.label === 'valid') primaryBody = body
    samples.push({
      label: variant.label,
      url: variant.url,
      status: response.status,
      bodyHash: md5(body),
      bodyLength: body.length,
      contentType: response.headers.get('content-type'),
      latencyMs: Date.now() - started,
    })
  }
  return { samples, primaryBody }
}

it('an agent built from the published SDK is graded LIVE on its own merits', async () => {
  const endpoint = `http://127.0.0.1:${port}/agents/${honest.agentId}`
  const { samples, primaryBody } = await probe(endpoint)

  // Agent-specificity is the bar a third of the registry fails: three inputs
  // must not produce one answer.
  expect(new Set(samples.map((s) => s.bodyHash)).size).toBe(3)

  const verdict = classify({
    services: [{ name: 'aiki-agent', endpoint }],
    samples,
    primaryBody,
  })
  expect(verdict.state).toBe('LIVE')
  expect(verdict.rule).toBe('D5')
})

it('serves a reciprocal proof the prober accepts', async () => {
  const document = await (
    await fetch(`http://127.0.0.1:${port}/.well-known/agent-registration.json`)
  ).json()
  expect(document).toEqual(registrationDocument([honest]))
  expect(
    d8_reciprocalProof(document, { agentId: honest.agentId, agentRegistry: CAIP }).verified,
  ).toBe(true)
})

it('does not speak for an agent id it was not given', async () => {
  const mine = await handle([honest], { method: 'GET', url: `/agents/${honest.agentId}` })
  const other = await handle([honest], { method: 'GET', url: '/agents/999999999' })
  expect(mine.status).toBe(200)
  expect(other.status).toBe(404)
  expect(JSON.parse(other.body).requestedAgentId).toBe('999999999')
})

it('still refuses an impostor, so the LIVE verdict above is not a formality', async () => {
  // The failure mode the SDK is built to avoid, written out by hand: one body,
  // whatever you ask. A third of the BSC registry does exactly this.
  const identical = JSON.stringify({ status: 'ok', agent: 'always the same' })
  const endpoint = 'https://impostor.test/agents/777001'
  const samples: ProbeSample[] = d1Variants(endpoint).map((variant) => ({
    label: variant.label,
    url: variant.url,
    status: 200,
    bodyHash: md5(identical),
    bodyLength: identical.length,
    contentType: 'application/json',
    latencyMs: 12,
  }))

  const verdict = classify({
    services: [{ name: 'aiki-agent', endpoint }],
    samples,
    primaryBody: identical,
  })
  expect(verdict.state).toBe('IMPOSTOR_STATIC')
})
