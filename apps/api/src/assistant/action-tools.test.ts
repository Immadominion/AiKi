import { decodeFunctionData, parseAbi } from 'viem'
import { afterEach, expect, it, vi } from 'vitest'
import { MUTATING, runTool, TOOLS } from './tools.js'

/**
 * The two tools that let an agent move a token, rather than repay one loan.
 *
 * What is checked here is mostly what the model is NOT allowed to decide. It
 * does not write the calldata, it does not choose the token address, and it
 * cannot create a mandate with no destination. Each of those, left to the
 * model, turns a wrong answer into somebody's money.
 */

const owner = `0x${'12'.repeat(20)}`
const accountAddress = `0x${'34'.repeat(20)}`
const manager = `0x${'56'.repeat(20)}`
const authorizationId = '12345678-1234-4123-8123-123456789012'
const jobId = 'abcdef12-1234-4123-8123-1234567890ab'
const USDT = '0x55d398326f99059ff775485246999027b3197955'
const TO = `0x${'aa'.repeat(20)}`
const ctx = { baseUrl: 'https://api.example', cookie: 'local-test-session', sessionAddress: owner }

const ERC20 = parseAbi(['function transfer(address to, uint256 amount) returns (bool)'])

function harness(options: { chainId?: 56 | 97; actionStatus?: number; action?: unknown } = {}) {
  const chainId = options.chainId ?? 56
  const requests: { path: string; method: string; body: Record<string, unknown> | undefined }[] = []
  const metadata = {
    configured: true,
    chainId,
    network: chainId === 56 ? 'mainnet' : 'testnet',
    audited: false,
    manager,
    guardian: {
      chainId,
      network: chainId === 56 ? 'mainnet' : 'testnet',
      asset: chainId === 56 ? USDT : '0xa11c8d9dc9b66e209ef60f0c8d969d3cd988782c',
      market:
        chainId === 56
          ? '0xfd5840cd36d94d7229439859c0112a4185bc0255'
          : '0xb7526572ffe56ab9d7489838bf2e18e3323b441a',
      decimals: chainId === 56 ? 18 : 6,
      repayBorrowSelector: '0x0e752702',
    },
  }
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    const method = init?.method ?? 'GET'
    requests.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
    if (path === '/v1/execution/network') return respond(metadata)
    if (path === '/v1/account') return respond({ address: accountAddress, chainId })
    if (path === '/v1/authorizations' && method === 'POST')
      return respond({
        id: authorizationId,
        owner,
        constraints: requests.at(-1)?.body?.constraints,
      })
    if (path === `/v1/jobs/${jobId}/actions` && method === 'POST')
      return respond(
        options.action ?? { policy: { allow: true, rule: 'policy' }, heldBy: 'chain' },
        options.actionStatus,
      )
    throw new Error(`Unexpected mocked request: ${method} ${path}`)
  })
  vi.stubGlobal('fetch', fetch)
  const posted = (path: string) =>
    requests.find((request) => request.path === path && request.method === 'POST')?.body
  return { requests, posted }
}

afterEach(() => vi.unstubAllGlobals())

const mandateArgs = {
  token: 'USDT',
  to: [TO],
  can: ['send'],
  per_action: 0.5,
  total: 1,
  expires_in_days: 7,
}

it('offers both tools and marks both as changing something', () => {
  const names = TOOLS.map((tool) => tool.name)
  expect(names).toContain('create_action_mandate')
  expect(names).toContain('send_token')
  expect(MUTATING.has('create_action_mandate')).toBe(true)
  expect(MUTATING.has('send_token')).toBe(true)
})

it('creates a token mandate scoped to the destination it was given', async () => {
  const h = harness()
  const result = await runTool(ctx, 'create_action_mandate', mandateArgs)
  expect(result.ok).toBe(true)
  const constraints = h.posted('/v1/authorizations')?.constraints as {
    kind: string
    value: unknown
    tier: string
  }[]
  expect(constraints.map((c) => c.kind)).toContain('recipient_allowlist')
  expect(constraints.find((c) => c.kind === 'recipient_allowlist')?.value).toEqual([TO])
  expect(constraints.find((c) => c.kind === 'asset_scope')?.value).toEqual([USDT])
  expect(constraints.find((c) => c.kind === 'per_action_cap')?.value).toBe('500000000000000000')
  // The destination rule is the one the chain does not hold.
  expect(constraints.find((c) => c.kind === 'recipient_allowlist')?.tier).toBe('T2')
})

it('hands back a signing step the browser can tell apart from the Venus one', async () => {
  harness()
  const result = await runTool(ctx, 'create_action_mandate', mandateArgs)
  expect(result.action).toEqual({
    kind: 'sign_mandate',
    scope: 'token_transfer',
    authorizationId,
    chainId: 56,
    account: accountAddress,
    manager,
  })
})

it('refuses a mandate that names nowhere to send', async () => {
  harness()
  const result = await runTool(ctx, 'create_action_mandate', { ...mandateArgs, to: [] })
  expect(result.ok).toBe(false)
  expect(JSON.stringify(result.body)).toMatch(/at least one address/)
})

it('refuses a token this network has not reviewed, without creating anything', async () => {
  const h = harness()
  const result = await runTool(ctx, 'create_action_mandate', { ...mandateArgs, token: 'SCAM' })
  expect(result.ok).toBe(false)
  expect(h.requests.some((request) => request.path === '/v1/authorizations')).toBe(false)
})

it('builds the transfer calldata itself, from the amount it was given', async () => {
  const h = harness()
  const result = await runTool(ctx, 'send_token', {
    job_id: jobId,
    token: 'USDT',
    to: TO,
    amount: 0.25,
    why: 'paying for the thing',
  })
  expect(result.ok).toBe(true)
  const body = h.posted(`/v1/jobs/${jobId}/actions`)
  expect(body?.target).toBe(USDT)
  expect(body?.asset).toBe(USDT)
  expect(body?.selector).toBe('0xa9059cbb')
  expect(body?.amount).toBe('250000000000000000')
  expect(body?.why).toBe('paying for the thing')
  // The decisive check: what the chain would execute has to carry the same
  // destination and the same number the caller was told about.
  const decoded = decodeFunctionData({ abi: ERC20, data: String(body?.callData) as `0x${string}` })
  expect(decoded.functionName).toBe('transfer')
  expect(String(decoded.args?.[0]).toLowerCase()).toBe(TO)
  expect(decoded.args?.[1]).toBe(250000000000000000n)
})

it('uses the decimals of the chain it is actually on', async () => {
  const h = harness({ chainId: 97 })
  await runTool(ctx, 'send_token', { job_id: jobId, token: 'USDT', to: TO, amount: 1 })
  // Six decimals on testnet. Reusing the mainnet scale would be off by 10^12.
  expect(h.posted(`/v1/jobs/${jobId}/actions`)?.amount).toBe('1000000')
})

it('refuses a destination that is not an address, before calling anything', async () => {
  const h = harness()
  for (const to of ['not-an-address', `0x${'00'.repeat(20)}`, '']) {
    const result = await runTool(ctx, 'send_token', { job_id: jobId, token: 'USDT', to, amount: 1 })
    expect(result.ok).toBe(false)
  }
  expect(h.requests.some((request) => request.path.endsWith('/actions'))).toBe(false)
})

it('refuses a job id that is not one', async () => {
  const h = harness()
  const result = await runTool(ctx, 'send_token', {
    job_id: 'the-job',
    token: 'USDT',
    to: TO,
    amount: 1,
  })
  expect(result.ok).toBe(false)
  expect(h.requests.some((request) => request.path.endsWith('/actions'))).toBe(false)
})

it('relays a refusal rather than dressing it as a success', async () => {
  harness({
    actionStatus: 200,
    action: {
      policy: {
        allow: false,
        rule: 'recipient_allowlist',
        reason: 'Recipient is not allowlisted.',
      },
    },
  })
  const result = await runTool(ctx, 'send_token', {
    job_id: jobId,
    token: 'USDT',
    to: TO,
    amount: 1,
  })
  // The route answered, so the tool call succeeded; the verdict inside is the
  // refusal, and the model is expected to read and report it.
  expect(result.ok).toBe(true)
  expect(JSON.stringify(result.body)).toMatch(/recipient_allowlist/)
})
