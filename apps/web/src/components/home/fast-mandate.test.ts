import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DELEGATION_TYPES, delegationDomain, ROOT_AUTHORITY } from '@aiki/contracts/delegation'
import { guardianConstraints, guardianFor } from '@aiki/contracts/guardian'
import {
  FastMandateController,
  type FastMandateDependencies,
  mandateContinuations,
  parseMandateContinuation,
} from './fast-mandate'

const owner = `0x${'11'.repeat(20)}`
const account = `0x${'22'.repeat(20)}`
const manager = `0x${'33'.repeat(20)}` as const
const id = '12345678-1234-4123-8123-123456789012'
const enforcement = [
  ['expiry', 'ExpiryEnforcer'],
  ['contract_allowlist', 'AllowedTargetsEnforcer'],
  ['selector_allowlist', 'AllowedSelectorsEnforcer'],
  ['asset_scope', 'AssetScopeEnforcer'],
  ['per_action_cap', 'PerActionCapEnforcer'],
  ['session_total_cap', 'SessionTotalCapEnforcer'],
] as const
const action = {
  kind: 'sign_mandate' as const,
  authorizationId: id,
  chainId: 56 as const,
  account,
  manager,
}
function harness(chainId: 56 | 97 = 56) {
  const calls: string[] = []
  const network = {
    configured: true as const,
    chainId,
    network: chainId === 56 ? ('mainnet' as const) : ('testnet' as const),
    audited: false,
    manager,
    guardian: guardianFor(chainId),
  }
  const unsigned = {
    delegate: owner,
    delegator: account,
    authority: ROOT_AUTHORITY,
    caveats: enforcement.map((_, index) => ({
      enforcer: `0x${String(index + 1).repeat(40)}`,
      terms: '0x1234',
      args: '0x',
    })),
    salt: '1',
    epoch: '0',
  }
  const prep = {
    domain: delegationDomain(chainId, manager),
    types: DELEGATION_TYPES,
    primaryType: 'Delegation',
    unsigned,
    limits: enforcement.map(([kind, enforcedBy]) => ({
      kind,
      label: kind,
      tier: 'T0' as 'T0' | 'T2',
      enforcedBy,
    })),
    message: {
      ...unsigned,
      caveats: unsigned.caveats.map(({ enforcer, terms }) => ({ enforcer, terms })),
    },
    authorization: {
      id,
      owner,
      status: 'active' as 'active' | 'revoked' | 'expired' | 'pending',
      policyHash: 'ab'.repeat(32),
      constraints: guardianConstraints({
        chainId,
        perActionUsdt: 1.000001,
        totalUsdt: 10,
        expiresInDays: 30,
      }),
      delegator: null as string | null,
      delegationChainId: null as number | null,
      signedAt: null as string | null,
    },
  }
  let revision = 1
  let walletOwner = owner
  const deps: FastMandateDependencies = {
    network: async () => {
      calls.push('network')
      return structuredClone(network)
    },
    account: async () => {
      calls.push('account')
      return { address: account, chainId }
    },
    prepare: async (authorizationId, delegator) => {
      calls.push('prepare')
      assert.equal(authorizationId, id)
      assert.equal(delegator, account)
      return structuredClone(prep)
    },
    file: async (authorizationId) => {
      calls.push('file')
      assert.equal(authorizationId, id)
      prep.authorization.signedAt = new Date().toISOString()
      prep.authorization.delegator = account
      prep.authorization.delegationChainId = chainId
      return {
        id,
        delegator: account,
        delegationChainId: chainId,
        signedAt: prep.authorization.signedAt,
        status: 'active',
      }
    },
    sign: async () => {
      calls.push('sign')
      return { ...unsigned, signature: '0x1234' }
    },
    session: () => ({ revision, address: owner, signal: new AbortController().signal }),
    readWallet: async () => ({ address: walletOwner, chainId }),
  }
  const controller = new FastMandateController({ ...action, chainId }, owner, deps)
  return {
    controller,
    deps,
    calls,
    prep,
    network,
    switchWallet: () => {
      revision++
      walletOwner = manager
    },
  }
}

test('only validated API step metadata can create a continuation', () => {
  assert.deepEqual(parseMandateContinuation({ ...action, signature: 'discard' }), action)
  for (const invalid of [
    null,
    {},
    { ...action, authorizationId: '../escape' },
    { ...action, chainId: '56' },
    { ...action, manager: '0x0' },
    { ...action, account: `0x${'0'.repeat(40)}` },
  ])
    assert.equal(parseMandateContinuation(invalid), null)
})

test('only successful create steps supply controls; duplicate and model input actions are ignored', () => {
  assert.deepEqual(
    mandateContinuations([
      { tool: 'create_mandate', ok: true, input: { action } },
      { tool: 'create_mandate', ok: false, action },
      { tool: 'search_agents', ok: true, action },
      { tool: 'create_mandate', ok: true, action },
      { tool: 'create_mandate', ok: true, action },
    ]),
    [action],
  )
})
test('constructing/restoring a card and calling sign before review never act', async () => {
  const h = harness()
  assert.equal(h.controller.getSnapshot().phase, 'idle')
  await h.controller.sign()
  assert.deepEqual(h.calls, [])
})
for (const invalid of [
  'missing_limits',
  'missing_limit',
  'offchain_limit',
  'missing_caveat',
  'duplicate_enforcer',
] as const)
  test(`incomplete on-chain enforcement (${invalid}) never offers signing`, async () => {
    const h = harness()
    if (invalid === 'missing_limits') Reflect.deleteProperty(h.prep, 'limits')
    if (invalid === 'missing_limit') h.prep.limits.pop()
    if (invalid === 'offchain_limit') {
      const first = h.prep.limits[0]
      assert.ok(first)
      first.tier = 'T2'
    }
    if (invalid === 'missing_caveat') h.prep.unsigned.caveats.pop()
    if (invalid === 'duplicate_enforcer') {
      const [first, second] = h.prep.unsigned.caveats
      assert.ok(first && second)
      second.enforcer = first.enforcer
    }
    h.prep.message.caveats = h.prep.unsigned.caveats.map(({ enforcer, terms }) => ({
      enforcer,
      terms,
    }))
    await h.controller.review()
    await h.controller.sign()
    assert.equal(h.controller.getSnapshot().phase, 'idle')
    assert.ok(!h.calls.includes('sign'))
    assert.ok(!h.calls.includes('file'))
  })
for (const chainId of [56, 97] as const)
  test(`review then explicit sign files only the existing authorization on ${chainId}`, async () => {
    const h = harness(chainId)
    await h.controller.review()
    assert.equal(h.controller.getSnapshot().phase, 'review')
    assert.equal(h.controller.getSnapshot().review?.perActionUsdt, '1.000001')
    assert.equal(h.controller.getSnapshot().review?.totalUsdt, '10')
    assert.ok(!h.calls.includes('sign'))
    await Promise.all([h.controller.sign(), h.controller.sign()])
    assert.equal(h.controller.getSnapshot().phase, 'signed')
    assert.equal(h.calls.filter((call) => call === 'sign').length, 1)
    assert.equal(h.calls.filter((call) => call === 'file').length, 1)
  })
for (const status of ['revoked', 'expired', 'pending'] as const)
  test(`${status} readback never offers a signature`, async () => {
    const h = harness()
    h.prep.authorization.status = status
    await h.controller.review()
    await h.controller.sign()
    assert.equal(h.controller.getSnapshot().phase, 'blocked')
    assert.ok(!h.calls.includes('sign'))
  })
test('actual stored expiry also blocks a stale active status', async () => {
  const h = harness()
  const expiry = h.prep.authorization.constraints.find((constraint) => constraint.kind === 'expiry')
  assert.ok(expiry)
  expiry.value = '2000-01-01T00:00:00.000Z'
  await h.controller.review()
  assert.equal(h.controller.getSnapshot().phase, 'blocked')
})
test('a signed readback never requests another signature', async () => {
  const h = harness()
  await h.deps.file(id, {})
  await h.controller.review()
  await h.controller.sign()
  assert.equal(h.controller.getSnapshot().phase, 'signed')
  assert.ok(!h.calls.includes('sign'))
})
test('lost filing acknowledgement is recovered by readback without signing again', async () => {
  const h = harness()
  const file = h.deps.file
  h.deps.file = async (...args) => {
    await file(...args)
    throw new Error('lost response')
  }
  await h.controller.review()
  await h.controller.sign()
  assert.equal(h.controller.getSnapshot().phase, 'uncertain')
  await h.controller.review()
  assert.equal(h.controller.getSnapshot().phase, 'signed')
  assert.equal(h.calls.filter((call) => call === 'sign').length, 1)
})
test('a wallet switch after review invalidates the pending signature', async () => {
  const h = harness()
  await h.controller.review()
  h.switchWallet()
  await h.controller.sign()
  assert.ok(!h.calls.includes('sign'))
  assert.ok(!h.calls.includes('file'))
})
test('a wallet switch while the prompt is open prevents filing', async () => {
  const h = harness()
  const sign = h.deps.sign
  h.deps.sign = async (...args) => {
    const value = await sign(...args)
    h.switchWallet()
    return value
  }
  await h.controller.review()
  await h.controller.sign()
  assert.ok(!h.calls.includes('file'))
})
test('declining a signature permits review of the same authorization, with no filing', async () => {
  const h = harness()
  h.deps.sign = async () => {
    h.calls.push('sign')
    throw new Error('The mandate signature was declined.')
  }
  await h.controller.review()
  await h.controller.sign()
  assert.equal(h.controller.getSnapshot().phase, 'idle')
  assert.ok(!h.calls.includes('file'))
  await h.controller.review()
  assert.equal(h.controller.getSnapshot().phase, 'review')
})
test('changed prepared bytes require a new review before the wallet is opened', async () => {
  const h = harness()
  await h.controller.review()
  h.prep.unsigned.salt = '2'
  h.prep.message.salt = '2'
  await h.controller.sign()
  assert.ok(!h.calls.includes('sign'))
})
test('a mismatched action network or mandate account fails closed', async () => {
  for (const patch of [{ chainId: 97 }, { address: manager }]) {
    const h = harness()
    h.deps.account = async () => ({ address: account, chainId: 56, ...patch })
    await h.controller.review()
    assert.ok(!h.calls.includes('prepare'))
    assert.ok(!h.calls.includes('sign'))
  }
})
test('metadata, owner and exact guardian scope must be verified before review', async () => {
  for (const patch of [
    (h: ReturnType<typeof harness>) => {
      h.prep.authorization.owner = manager
    },
    (h: ReturnType<typeof harness>) => {
      h.prep.authorization.policyHash = 'invalid'
    },
    (h: ReturnType<typeof harness>) => {
      const constraint = h.prep.authorization.constraints[1]
      assert.ok(constraint)
      constraint.value = []
    },
  ]) {
    const h = harness()
    patch(h)
    await h.controller.review()
    assert.equal(h.controller.getSnapshot().phase, 'idle')
    assert.ok(!h.calls.includes('sign'))
  }
})
test('unmount during a prompt prevents filing and ignores late UI updates', async () => {
  const h = harness()
  const sign = h.deps.sign
  h.deps.sign = async (...args) => {
    const value = await sign(...args)
    h.controller.dispose()
    return value
  }
  await h.controller.review()
  await h.controller.sign()
  assert.ok(!h.calls.includes('file'))
})

test('closing the card during shared-helper preflight prevents a late wallet prompt', async () => {
  const h = harness()
  h.deps.sign = async (prep, _network, _account, signer, dependencies) => {
    h.controller.dispose()
    assert.ok(dependencies?.sign)
    await assert.rejects(dependencies.sign(signer, prep), /review was closed/)
    return { ...prep.unsigned, signature: '0x1234' }
  }
  await h.controller.review()
  await h.controller.sign()
  assert.ok(!h.calls.includes('file'))
})

test('revocation during the wallet prompt prevents filing', async () => {
  const h = harness()
  const sign = h.deps.sign
  h.deps.sign = async (...args) => {
    const signed = await sign(...args)
    h.prep.authorization.status = 'revoked'
    return signed
  }
  await h.controller.review()
  await h.controller.sign()
  assert.equal(h.controller.getSnapshot().phase, 'blocked')
  assert.ok(!h.calls.includes('file'))
})

test('malformed filing response stays unconfirmed until the same authorization is checked', async () => {
  const h = harness()
  h.deps.file = async () => ({ id, delegator: manager, delegationChainId: 56 })
  await h.controller.review()
  await h.controller.sign()
  assert.equal(h.controller.getSnapshot().phase, 'uncertain')
})
