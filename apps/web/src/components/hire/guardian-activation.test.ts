import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DELEGATION_TYPES,
  delegationDomain,
  delegationMessage,
  ROOT_AUTHORITY,
  type UnsignedDelegation,
} from '@aiki/contracts/delegation'
import { type ExecutionNetwork, guardianFor } from '@aiki/contracts/guardian'
import { privateKeyToAccount } from 'viem/accounts'
import type { Enforcement } from '../../lib/api'
import {
  activateGuardianMandate,
  assertPreparedDelegation,
  createGuardianAttemptStore,
  type GuardianActivationDependencies,
  type GuardianAttempt,
  type PreparedDelegation,
  signPreparedDelegation,
} from './guardian-activation'

// Deterministic local signing fixture only. No injected wallet, RPC or broadcasts.
const signer = privateKeyToAccount(`0x${'01'.repeat(32)}`)
const owner = signer.address.toLowerCase()
const accountAddress = `0x${'22'.repeat(20)}` as `0x${string}`
const manager = `0x${'33'.repeat(20)}` as `0x${string}`
const delegate = `0x${'44'.repeat(20)}` as `0x${string}`
const networkFor = (chainId: number): ExecutionNetwork => {
  const guardian = guardianFor(chainId)
  return {
    configured: true,
    chainId: guardian.chainId,
    network: guardian.network,
    audited: false,
    manager,
    guardian,
  }
}
const input = {
  capCents: 25_000,
  perActionCents: 1234,
  days: 30,
  approval: { mode: 'automatic' as const, thresholdCents: 2000 },
  spends: [],
}
const json = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item)),
  )

function harness(chainId = 56) {
  const network = networkFor(chainId)
  const unsigned: UnsignedDelegation = {
    delegate,
    delegator: accountAddress,
    authority: ROOT_AUTHORITY,
    caveats: [{ enforcer: manager, terms: '0x1234', args: '0x' }],
    salt: '1',
    epoch: '0',
  }
  const prep: PreparedDelegation = {
    domain: delegationDomain(chainId, manager),
    types: DELEGATION_TYPES,
    primaryType: 'Delegation',
    message: json(delegationMessage(unsigned)),
    unsigned: json(unsigned),
    authorization: {
      id: 'auth',
      owner,
      status: 'active',
      policyHash: 'ab'.repeat(32),
      constraints: [],
      delegator: null,
      delegationChainId: null,
      signedAt: null,
    },
  }
  const enforcement: Enforcement = {
    network: network.network,
    audited: false,
    tier: 'T2',
    limits: Object.entries({
      expiry: 'ExpiryEnforcer',
      contract_allowlist: 'AllowedTargetsEnforcer',
      selector_allowlist: 'AllowedSelectorsEnforcer',
      asset_scope: 'AssetScopeEnforcer',
      per_action_cap: 'PerActionCapEnforcer',
      session_total_cap: 'SessionTotalCapEnforcer',
    }).map(([kind, enforcedBy]) => ({
      kind,
      label: kind,
      tier: 'T0',
      enforcedBy,
      why: 'Enforced.',
    })),
  }
  const calls: string[] = []
  const constraints: unknown[][] = []
  let hasAccount = false
  let revision = 1
  const attempts = new Map<string, GuardianAttempt>()
  const keys: string[] = []
  const deps: GuardianActivationDependencies = {
    attempts: {
      read: (key) => attempts.get(key) ?? null,
      write: (key, value) => {
        attempts.set(key, value)
      },
      clear: (key) => {
        attempts.delete(key)
      },
    },
    network: async () => {
      calls.push('network')
      return network
    },
    session: () => ({ revision, address: owner, signal: new AbortController().signal }),
    readWallet: async () => ({ address: owner, chainId }),
    account: async () => {
      calls.push('account')
      return { address: hasAccount ? accountAddress : null, chainId }
    },
    preview: async (values) => {
      calls.push('preview')
      constraints.push(values)
      return enforcement
    },
    createAccount: async () => {
      calls.push('deploy')
      hasAccount = true
      return { address: accountAddress, chainId, created: true }
    },
    authorize: async (values, key) => {
      calls.push('authorize')
      assert.ok(key)
      keys.push(key)
      constraints.push(values)
      if (prep.authorization) prep.authorization.constraints = json(values)
      return {
        id: 'auth',
        owner,
        status: 'active',
        spent: '0',
        policy: { hash: 'hash', weakestTier: 'T2' },
      }
    },
    prepare: async () => {
      calls.push('prepare')
      return prep
    },
    sign: async (_owner, value) => {
      calls.push('sign')
      assert.deepEqual(Object.keys(value).sort(), ['domain', 'message', 'primaryType', 'types'])
      return signer.signTypedData(value as Parameters<typeof signer.signTypedData>[0])
    },
    file: async () => {
      calls.push('file')
      const signedAt = new Date().toISOString()
      if (prep.authorization)
        Object.assign(prep.authorization, {
          delegator: accountAddress,
          delegationChainId: chainId,
          signedAt,
        })
      return {
        id: 'auth',
        delegator: accountAddress,
        delegationChainId: chainId,
        status: 'active',
        signedAt,
      }
    },
    createJob: async (_id, key) => {
      calls.push('job')
      assert.equal(key, 'hire:auth')
      return { id: 'job', status: 'RUNNING' }
    },
  }
  return {
    network,
    prep,
    enforcement,
    calls,
    constraints,
    keys,
    attempts,
    deps,
    setAccount: () => {
      hasAccount = true
    },
    changeSession: () => {
      revision++
    },
  }
}

test('56 and 97 create a signed repayment job with exact fractional USDT caps and no watch', async () => {
  for (const chainId of [56, 97]) {
    const h = harness(chainId)
    const result = await activateGuardianMandate(input, h.network, owner, h.deps)
    assert.equal(result.job.id, 'job')
    assert.equal(h.calls.filter((c) => c === 'deploy').length, 1)
    assert.deepEqual(h.constraints[0], h.constraints[1])
    const constraints = h.constraints[1] as { kind: string; value: unknown }[]
    const value = (kind: string) => constraints.find((c) => c.kind === kind)?.value
    assert.deepEqual(value('selector_allowlist'), ['0x0e752702'])
    assert.deepEqual(value('contract_allowlist'), [h.network.guardian.market])
    assert.deepEqual(value('asset_scope'), [h.network.guardian.asset])
    assert.equal(
      value('per_action_cap'),
      ((1234n * 10n ** BigInt(h.network.guardian.decimals)) / 100n).toString(),
    )
    assert.deepEqual(
      h.calls.filter((c) => ['authorize', 'prepare', 'sign', 'file', 'job'].includes(c)),
      ['authorize', 'prepare', 'sign', 'file', 'prepare', 'job'],
    )
  }
})

test('an existing account is never redeployed', async () => {
  const h = harness()
  h.setAccount()
  await activateGuardianMandate(input, h.network, owner, h.deps)
  assert.equal(h.calls.includes('deploy'), false)
})

test('invalid caps and missing enforcement fail before deployment or authorization', async () => {
  for (const bad of [
    { capCents: 0 },
    { perActionCents: 30_000 },
    { perActionCents: Number.NaN },
    { capCents: 1.5 },
    { days: 0 },
    { days: 366 },
  ]) {
    const h = harness()
    await assert.rejects(activateGuardianMandate({ ...input, ...bad }, h.network, owner, h.deps))
    assert.equal(h.calls.includes('deploy') || h.calls.includes('authorize'), false)
  }
  const h = harness()
  const limit = h.enforcement.limits[0]
  assert.ok(limit)
  limit.tier = 'T2'
  await assert.rejects(
    activateGuardianMandate(input, h.network, owner, h.deps),
    /limits are unavailable/,
  )
  assert.equal(h.calls.includes('deploy') || h.calls.includes('authorize'), false)
})

test('unavailable, unsupported, changed chain or manager prevents any mutation', async () => {
  for (const network of [
    null,
    { ...networkFor(56), chainId: 1 },
    networkFor(97),
    { ...networkFor(56), manager: delegate },
  ]) {
    const h = harness()
    h.deps.network = async () => network as ExecutionNetwork
    await assert.rejects(activateGuardianMandate(input, h.network, owner, h.deps))
    assert.deepEqual(h.calls, [])
  }
  const h = harness()
  h.deps.network = async () => {
    throw new Error('Unavailable')
  }
  await assert.rejects(activateGuardianMandate(input, h.network, owner, h.deps))
  assert.deepEqual(h.calls, [])
})

test('failed or mismatched account prerequisites never authorize or sign', async () => {
  for (const response of [
    { address: null, chainId: 97 },
    { address: 'bad', chainId: 56 },
    { address: `0x${'00'.repeat(20)}`, chainId: 56 },
  ]) {
    const h = harness()
    h.deps.account = async () => response
    await assert.rejects(activateGuardianMandate(input, h.network, owner, h.deps), /account/)
    assert.equal(h.calls.includes('deploy') || h.calls.includes('authorize'), false)
  }
  const h = harness()
  h.deps.account = async () => {
    throw new Error('Account unavailable')
  }
  await assert.rejects(activateGuardianMandate(input, h.network, owner, h.deps))
  assert.equal(h.calls.includes('authorize'), false)
})

test('zero funder and an incorrect deployment response prevent authorization', async () => {
  for (const deploy of [
    async () => {
      throw new Error('The account funder has no BNB')
    },
    async () => ({ address: accountAddress, chainId: 97, created: true }),
  ]) {
    const h = harness()
    h.deps.createAccount = deploy
    await assert.rejects(activateGuardianMandate(input, h.network, owner, h.deps))
    assert.equal(h.calls.includes('authorize'), false)
  }
})

test('wrong connected wallet or chain never deploys, authorizes or prompts', async () => {
  for (const active of [
    null,
    { address: delegate, chainId: 56 },
    { address: owner, chainId: 97 },
  ]) {
    const h = harness()
    h.deps.readWallet = async () => active
    await assert.rejects(
      activateGuardianMandate(input, h.network, owner, h.deps),
      /Connect and sign in/,
    )
    assert.equal(
      h.calls.includes('deploy') || h.calls.includes('authorize') || h.calls.includes('sign'),
      false,
    )
  }
})

test('prepared domain, schema and signed/filed bytes must match before the wallet prompt', async () => {
  const cases: ((prep: PreparedDelegation) => void)[] = [
    (p) => {
      ;(p.domain as Record<string, unknown>).chainId = 97
    },
    (p) => {
      ;(p.domain as Record<string, unknown>).verifyingContract = delegate
    },
    (p) => {
      ;(p.domain as Record<string, unknown>).name = 'Other'
    },
    (p) => {
      p.types = {}
    },
    (p) => {
      p.primaryType = 'Other'
    },
    (p) => {
      ;(p.message as Record<string, unknown>).delegator = delegate
    },
    (p) => {
      p.unsigned.delegator = delegate
    },
    (p) => {
      p.unsigned.delegate = manager
    },
    (p) => {
      p.unsigned.authority = `0x${'00'.repeat(32)}`
    },
    (p) => {
      p.unsigned.caveats = []
    },
  ]
  for (const mutate of cases) {
    const h = harness()
    mutate(h.prep)
    await assert.rejects(
      activateGuardianMandate(input, h.network, owner, h.deps),
      /signing request/,
    )
    assert.equal(
      h.calls.includes('sign') || h.calls.includes('file') || h.calls.includes('job'),
      false,
    )
  }
})

test('real API decimal strings match the canonical bigint signing message', () => {
  const h = harness()
  assert.doesNotThrow(() => assertPreparedDelegation(h.prep, h.network, accountAddress))
})

test('wallet, account or runtime changes during signing never file authority or create a job', async () => {
  for (const mutate of [
    (h: ReturnType<typeof harness>) => h.changeSession(),
    (h: ReturnType<typeof harness>) => {
      h.deps.readWallet = async () => ({ address: delegate, chainId: 56 })
    },
    (h: ReturnType<typeof harness>) => {
      h.deps.network = async () => networkFor(97)
    },
    (h: ReturnType<typeof harness>) => {
      h.deps.account = async () => ({ address: delegate, chainId: 56 })
    },
  ]) {
    const h = harness()
    // Mutate returned state rather than replacing copied dependency functions.
    let changed = false
    const readWallet = h.deps.readWallet
    const readNetwork = h.deps.network
    const readAccount = h.deps.account
    const signedDeps = {
      ...h.deps,
      readWallet: () => (changed ? h.deps.readWallet() : readWallet()),
      network: () => (changed ? h.deps.network() : readNetwork()),
      account: () => (changed ? h.deps.account() : readAccount()),
      sign: async (_owner: string, value: Parameters<typeof h.deps.sign>[1]) => {
        const signature = await h.deps.sign(_owner, value)
        mutate(h)
        changed = true
        return signature
      },
    }
    await assert.rejects(activateGuardianMandate(input, h.network, owner, signedDeps))
    assert.equal(h.calls.includes('file') || h.calls.includes('job'), false)
  }
})

test('declined and wrong-owner signatures never file or create jobs', async () => {
  for (const signature of ['declined', `0x${'00'.repeat(65)}`] as const) {
    const h = harness()
    h.deps.sign = async () => signature
    await assert.rejects(activateGuardianMandate(input, h.network, owner, h.deps))
    assert.equal(h.calls.includes('file') || h.calls.includes('job'), false)
  }
})

test('an unverified filing response never creates a job', async () => {
  const h = harness()
  h.deps.file = async () => ({ id: 'auth', delegator: accountAddress, delegationChainId: 97 })
  await assert.rejects(
    activateGuardianMandate(input, h.network, owner, h.deps),
    /could not be confirmed/,
  )
  assert.equal(h.calls.includes('job'), false)
})

test('the shared signing helper signs existing authority without other mutations', async () => {
  const h = harness()
  h.setAccount()
  const result = await signPreparedDelegation(h.prep, h.network, accountAddress, owner, h.deps)
  assert.match(result.signature, /^0x[0-9a-f]{130}$/i)
  assert.equal(
    h.calls.some((c) => ['deploy', 'authorize', 'file', 'job'].includes(c)),
    false,
  )
})

test('declining a signature retains the same authorization for explicit retry', async () => {
  const h = harness()
  const sign = h.deps.sign
  h.deps.sign = async () => 'declined'
  await assert.rejects(activateGuardianMandate(input, h.network, owner, h.deps), /declined/)
  assert.equal(h.attempts.size, 1)
  h.deps.sign = sign
  await activateGuardianMandate(input, h.network, owner, h.deps)
  assert.equal(h.calls.filter((call) => call === 'authorize').length, 1)
  assert.equal(h.attempts.size, 0)
})

test('lost authorization acknowledgement retries the same key and exact absolute expiry', async () => {
  const h = harness()
  const authorize = h.deps.authorize
  let first = true
  h.deps.authorize = async (...args) => {
    const result = await authorize(...args)
    if (first) {
      first = false
      throw new Error('Acknowledgement lost')
    }
    return result
  }
  await assert.rejects(activateGuardianMandate(input, h.network, owner, h.deps), /lost/)
  await activateGuardianMandate(input, h.network, owner, h.deps)
  assert.equal(h.keys.length, 2)
  assert.equal(h.keys[0], h.keys[1])
  assert.deepEqual(h.constraints[1], h.constraints[3])
  assert.equal(h.calls.filter((call) => call === 'sign').length, 1)
})

test('lost signature acknowledgement resumes the same signed authority without prompting again', async () => {
  const h = harness()
  const file = h.deps.file
  h.deps.file = async (...args) => {
    await file(...args)
    throw new Error('Acknowledgement lost')
  }
  await assert.rejects(activateGuardianMandate(input, h.network, owner, h.deps), /lost/)
  await activateGuardianMandate(input, h.network, owner, h.deps)
  for (const step of ['deploy', 'authorize', 'sign', 'file', 'job'])
    assert.equal(h.calls.filter((call) => call === step).length, 1, step)
})

test('lost job acknowledgement repeats only the same idempotent job creation', async () => {
  const h = harness()
  const createJob = h.deps.createJob
  let first = true
  h.deps.createJob = async (...args) => {
    const result = await createJob(...args)
    if (first) {
      first = false
      throw new Error('Acknowledgement lost')
    }
    return result
  }
  await assert.rejects(activateGuardianMandate(input, h.network, owner, h.deps), /lost/)
  const result = await activateGuardianMandate(input, h.network, owner, h.deps)
  assert.equal(result.job.id, 'job')
  for (const step of ['deploy', 'authorize', 'sign', 'file'])
    assert.equal(h.calls.filter((call) => call === step).length, 1, step)
  assert.equal(h.calls.filter((call) => call === 'job').length, 2)
})

test('changing reviewed limits cannot replace an unresolved authority with another', async () => {
  const h = harness()
  h.deps.sign = async () => 'declined'
  await assert.rejects(activateGuardianMandate(input, h.network, owner, h.deps))
  await assert.rejects(
    activateGuardianMandate({ ...input, capCents: 50_000 }, h.network, owner, h.deps),
    /same limits/,
  )
  assert.equal(h.calls.filter((call) => call === 'authorize').length, 1)
})

test('a changed, revoked or expired stored mandate cannot be signed or resumed', async () => {
  for (const mutate of [
    (p: PreparedDelegation) => {
      if (p.authorization) p.authorization.status = 'revoked'
    },
    (p: PreparedDelegation) => {
      if (p.authorization) p.authorization.status = 'expired'
    },
    (p: PreparedDelegation) => {
      if (p.authorization) p.authorization.owner = delegate
    },
    (p: PreparedDelegation) => {
      if (p.authorization) p.authorization.constraints = []
    },
  ]) {
    const h = harness()
    const prepare = h.deps.prepare
    h.deps.prepare = async (...args) => {
      const prep = await prepare(...args)
      mutate(prep)
      return prep
    }
    await assert.rejects(activateGuardianMandate(input, h.network, owner, h.deps), /stored mandate/)
    assert.equal(
      h.calls.includes('sign') || h.calls.includes('file') || h.calls.includes('job'),
      false,
    )
  }
})

test('concurrent setup calls cannot create two authorities for the same wallet and network', async () => {
  const h = harness()
  const read = h.deps.network
  let release: () => void = () => {}
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  h.deps.network = async () => {
    await blocked
    return read()
  }
  const first = activateGuardianMandate(input, h.network, owner, h.deps)
  await assert.rejects(
    activateGuardianMandate(input, h.network, owner, h.deps),
    /already.*in progress/,
  )
  release()
  await first
  assert.equal(h.calls.filter((call) => call === 'authorize').length, 1)
})

test('unavailable or corrupt pending storage cannot deploy an account or create authority', async () => {
  for (const storage of [
    {
      getItem: () => {
        throw new Error('disabled')
      },
      setItem() {},
      removeItem() {},
    },
    { getItem: () => '{malformed', setItem() {}, removeItem() {} },
    {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota')
      },
      removeItem() {},
    },
  ]) {
    const h = harness()
    h.deps.attempts = createGuardianAttemptStore(() => storage)
    await assert.rejects(
      activateGuardianMandate(input, h.network, owner, h.deps),
      /storage|retry key/,
    )
    assert.equal(h.calls.includes('deploy') || h.calls.includes('authorize'), false)
  }
})

test('a fresh browser attempt store recovers the same id and key without storing a signature', async () => {
  const persisted = new Map<string, string>()
  const storage = {
    getItem: (key: string) => persisted.get(key) ?? null,
    setItem: (key: string, value: string) => {
      persisted.set(key, value)
    },
    removeItem: (key: string) => {
      persisted.delete(key)
    },
  }
  const h = harness()
  h.deps.attempts = createGuardianAttemptStore(() => storage)
  const sign = h.deps.sign
  h.deps.sign = async () => 'declined'
  await assert.rejects(activateGuardianMandate(input, h.network, owner, h.deps))
  const values = [...persisted.values()].map((value) => JSON.parse(value))
  assert.equal(values.length, 1)
  assert.deepEqual(Object.keys(values[0]).sort(), [
    'authorizationId',
    'createdAt',
    'fingerprint',
    'idempotencyKey',
  ])
  assert.equal(values[0].authorizationId, 'auth')
  h.deps.attempts = createGuardianAttemptStore(() => storage)
  h.deps.sign = sign
  await activateGuardianMandate(input, h.network, owner, h.deps)
  assert.equal(h.calls.filter((call) => call === 'authorize').length, 1)
  assert.equal(persisted.size, 0)
})
