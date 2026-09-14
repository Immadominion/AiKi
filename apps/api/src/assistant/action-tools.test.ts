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

function harness(
  options: {
    chainId?: 56 | 97
    actionStatus?: number
    action?: unknown
    account?: { address: string | null; chainId: number }
    balances?: unknown
  } = {},
) {
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
    if (path === '/v1/account')
      return respond({
        ...(options.account ?? { address: accountAddress, chainId }),
        ...(options.balances === undefined ? {} : { balances: options.balances }),
      })
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
  ask: 'every',
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

it('carries the ask level the person chose into the stored mandate', async () => {
  const h = harness()
  await runTool(ctx, 'create_action_mandate', { ...mandateArgs, ask: 'over', ask_over: 0.25 })
  const constraints = h.posted('/v1/authorizations')?.constraints as {
    kind: string
    value: unknown
    tier: string
  }[]
  const approval = constraints.find((constraint) => constraint.kind === 'approval')
  expect(approval?.value).toEqual({
    mode: 'approve_above_threshold',
    threshold: '250000000000000000',
  })
  // No contract can wait for a person, so this may never arrive as T0.
  expect(approval?.tier).toBe('T2')
})

it('asks every time when the model leaves the level out', async () => {
  /*
   * The schema requires it and a model can still omit a required field. The
   * fallback is the strict end: an agent spending without being asked has to be
   * something somebody chose, never something a missing field produced.
   */
  const h = harness()
  const { ask, ...without } = mandateArgs
  expect(ask).toBe('every')
  await runTool(ctx, 'create_action_mandate', without)
  const constraints = h.posted('/v1/authorizations')?.constraints as {
    kind: string
    value: unknown
  }[]
  expect(constraints.find((constraint) => constraint.kind === 'approval')?.value).toEqual({
    mode: 'approve_every',
    threshold: '0',
  })
})

it('refuses a threshold the per-action cap already puts out of reach', async () => {
  harness()
  const result = await runTool(ctx, 'create_action_mandate', {
    ...mandateArgs,
    ask: 'over',
    ask_over: 0.5,
  })
  expect(result.ok).toBe(false)
  expect(JSON.stringify(result.body)).toMatch(/would never ask/)
})

it('hands back an answerable step when a send stops to ask', async () => {
  const approvalId = 'fedcba98-4321-4321-8321-ba0987654321'
  harness({
    action: {
      policy: {
        allow: false,
        rule: 'approval_required',
        reason: 'This mandate says to ask you first, and nobody has answered yet.',
        approvalId,
      },
      heldBy: 'aiki',
    },
  })
  const result = await runTool(ctx, 'send_token', {
    job_id: jobId,
    token: 'USDT',
    to: TO,
    amount: 0.25,
  })
  // A pause is a 200: the request was understood, and it is waiting.
  expect(result.ok).toBe(true)
  expect(result.action).toEqual({
    kind: 'answer_approval',
    jobId,
    approvalId,
    chainId: 56,
  })
})

it('hands back no answerable step for a send that simply went through', async () => {
  harness()
  const result = await runTool(ctx, 'send_token', {
    job_id: jobId,
    token: 'USDT',
    to: TO,
    amount: 0.25,
  })
  expect(result.action).toBeUndefined()
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

/*
 * The address, handed over as a control rather than typed into a paragraph.
 *
 * Somebody asked an agent to trade a dollar, was correctly told native BNB
 * cannot be spent and the account needed funding, and did not find the address
 * in the reply. They opened a different screen and made a second wallet.
 */
it('hands back a funding control when the account holds nothing an agent can spend', async () => {
  harness()
  const result = await runTool(ctx, 'my_account', {})
  expect(result.ok).toBe(true)
  expect(result.action).toEqual({
    kind: 'fund_account',
    address: accountAddress.toLowerCase(),
    chainId: 56,
    symbols: ['USDT', 'WBNB'],
  })
})

it('offers no funding control once there is something to spend', async () => {
  // Nothing to fix, so nothing on screen. This is the whole reason it is not a
  // permanent widget.
  harness({
    balances: { native: '0', tokens: [{ symbol: 'USDT', amount: '2500000000000000000' }] },
  })
  expect((await runTool(ctx, 'my_account', {})).action).toBeUndefined()
})

it('offers no funding control for an account that does not exist yet', async () => {
  harness({ account: { address: null, chainId: 56 } })
  expect((await runTool(ctx, 'my_account', {})).action).toBeUndefined()
})

it('treats a balance of zero tokens as nothing to spend, not as unknown', async () => {
  harness({
    balances: { native: '9000000000000000000', tokens: [{ symbol: 'USDT', amount: '0' }] },
  })
  // Native BNB is not spendable by any mandate, so an account holding only BNB
  // still needs funding, which is exactly the case that prompted this.
  expect((await runTool(ctx, 'my_account', {})).action).toMatchObject({ kind: 'fund_account' })
})

/*
 * The composer's setting beats the model's.
 *
 * "I can't control the amount of control the agent had from the text field."
 * A default the model is free to talk itself out of would not answer that, so
 * the person's choice is applied by the server and the model's argument is the
 * fallback, not the other way round.
 */
it('applies the power the person set, over whatever the model passed', async () => {
  const h = harness()
  await runTool({ ...ctx, agentPower: 'never' }, 'create_action_mandate', {
    ...mandateArgs,
    ask: 'every',
  })
  const constraints = h.posted('/v1/authorizations')?.constraints as {
    kind: string
    value: unknown
  }[]
  expect(constraints.find((constraint) => constraint.kind === 'approval')?.value).toEqual({
    mode: 'automatic',
    threshold: '0',
  })
})

it('falls back to the model, then to asking, when nothing was set', async () => {
  const h = harness()
  await runTool(ctx, 'create_action_mandate', { ...mandateArgs, ask: 'never' })
  const constraints = h.posted('/v1/authorizations')?.constraints as {
    kind: string
    value: unknown
  }[]
  expect(constraints.find((constraint) => constraint.kind === 'approval')?.value).toEqual({
    mode: 'automatic',
    threshold: '0',
  })
})

it('applies it to the guardian mandate too, which is the one that acts unattended', async () => {
  const h = harness()
  await runTool({ ...ctx, agentPower: 'every' }, 'create_mandate', {
    per_action_usdt: 1,
    total_usdt: 10,
    ask: 'never',
  })
  const constraints = h.posted('/v1/authorizations')?.constraints as {
    kind: string
    value: unknown
  }[]
  expect(constraints.find((constraint) => constraint.kind === 'approval')?.value).toEqual({
    mode: 'approve_every',
    threshold: '0',
  })
})
