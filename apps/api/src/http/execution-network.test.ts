import { guardianConstraints, guardianFor, parseExecutionNetwork } from '@aiki/contracts'
import { afterEach, expect, it } from 'vitest'
import { AIKI_ENFORCERS_BSC_TESTNET, type EnforcerDeployment } from '../config/enforcers.js'
import { createApiServer } from './server.js'

const apps: ReturnType<typeof createApiServer>[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})
const metadata = (chainId: 56 | 97) => ({
  configured: true as const,
  chainId,
  network: chainId === 56 ? 'mainnet' : 'testnet',
  audited: false,
  manager: `0x${'11'.repeat(20)}`,
  guardian: guardianFor(chainId),
})
const deployment = (chainId: 56 | 97): EnforcerDeployment => ({
  ...AIKI_ENFORCERS_BSC_TESTNET,
  chainId,
  network: chainId === 56 ? 'mainnet' : 'testnet',
})

it.each([56, 97] as const)(
  'publishes chain%s configuration without requiring a wallet or claiming readiness',
  async (chainId) => {
    const app = createApiServer({ observations: async () => [], enforcers: deployment(chainId) })
    apps.push(app)
    const response = await app.inject('/v1/execution/network')
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    const body = parseExecutionNetwork(response.json())
    expect(body.chainId).toBe(chainId)
    expect(body.guardian).toEqual(guardianFor(chainId))
    expect(body.audited).toBe(false)
    expect(body).not.toHaveProperty('ready')
    expect(body).not.toHaveProperty('rpcUrl')
  },
)

it.each([
  undefined,
  { ...deployment(56), chainId: 1 },
  { ...deployment(56), network: 'testnet' as const },
  { ...deployment(56), manager: `0x${'0'.repeat(40)}` },
])('rejects missing or unsupported execution configuration without fallback', async (enforcers) => {
  const app = createApiServer({ observations: async () => [], ...(enforcers ? { enforcers } : {}) })
  apps.push(app)
  const response = await app.inject('/v1/execution/network')
  expect(response.statusCode).toBe(503)
  expect(response.headers['cache-control']).toBe('no-store')
  expect(response.json()).toMatchObject({ error: { code: 'EXECUTION_NETWORK_UNAVAILABLE' } })
  expect(response.json()).not.toHaveProperty('guardian')
  expect(response.json()).not.toHaveProperty('manager')
})

it('parses only canonical execution metadata, not a model-selected token or chain', () => {
  expect(parseExecutionNetwork(metadata(56)).guardian.decimals).toBe(18)
  expect(parseExecutionNetwork(metadata(97)).guardian.decimals).toBe(6)
  for (const invalid of [
    null,
    [],
    {},
    { ...metadata(56), configured: false },
    { ...metadata(56), chainId: '56' },
    { ...metadata(56), network: 'testnet' },
    { ...metadata(56), audited: 'true' },
    { ...metadata(56), guardian: guardianFor(97) },
    { ...metadata(56), guardian: { ...guardianFor(56), market: metadata(56).manager } },
    { ...metadata(56), guardian: { ...guardianFor(56), asset: metadata(56).manager } },
    { ...metadata(56), guardian: { ...guardianFor(56), decimals: 6 } },
    { ...metadata(56), guardian: { ...guardianFor(56), repayBorrowSelector: '0x12345678' } },
  ])
    expect(() => parseExecutionNetwork(invalid)).toThrow()
})

it.each([
  [56, 1.000001, '1000001000000000000'],
  [97, 1.000001, '1000001'],
  [56, 1e-18, '1'],
  [97, 1e-6, '1'],
] as const)(
  'constructs exact caps on chain%s without six-decimal assumptions',
  (chainId, amount, expected) => {
    const constraints = guardianConstraints({
      chainId,
      perActionUsdt: amount,
      totalUsdt: 10,
      expiresInDays: 30,
    })
    expect(constraints.find((c) => c.kind === 'per_action_cap')?.value).toBe(expected)
    expect(constraints.find((c) => c.kind === 'contract_allowlist')?.value).toEqual([
      guardianFor(chainId).market,
    ])
    expect(constraints.find((c) => c.kind === 'asset_scope')?.value).toEqual([
      guardianFor(chainId).asset,
    ])
  },
)

it('rejects invalid or rounded caps before any account or authorization can be created', () => {
  const input = { chainId: 56, perActionUsdt: 1, totalUsdt: 10, expiresInDays: 30 }
  for (const invalid of [
    { ...input, chainId: 1 },
    { ...input, perActionUsdt: 0 },
    { ...input, perActionUsdt: -1 },
    { ...input, perActionUsdt: Number.NaN },
    { ...input, totalUsdt: Infinity },
    { ...input, totalUsdt: Number.MAX_SAFE_INTEGER + 1 },
    { ...input, perActionUsdt: 11 },
    { ...input, perActionUsdt: 1e-19 },
    { ...input, chainId: 97, perActionUsdt: 1e-7 },
    { ...input, expiresInDays: 0 },
    { ...input, expiresInDays: 366 },
    { ...input, expiresInDays: 1.1 },
  ])
    expect(() => guardianConstraints(invalid)).toThrow()
})
