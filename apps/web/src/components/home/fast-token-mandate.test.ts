import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DELEGATION_TYPES, delegationDomain, ROOT_AUTHORITY } from '@aiki/contracts/delegation'
import { accountTokensFor, guardianFor } from '@aiki/contracts/guardian'
import { actionMandateConstraints } from '@aiki/contracts/mandates'
import { FastMandateController, type FastMandateDependencies } from './fast-mandate'

/**
 * The review screen for a token mandate.
 *
 * The point of these is that the scope actually gates: a mandate is checked
 * against the structure it claims to be and nothing else, so neither shape can
 * be signed by presenting it as the other.
 */

const owner = `0x${'11'.repeat(20)}`
const account = `0x${'22'.repeat(20)}`
const manager = `0x${'33'.repeat(20)}` as const
const id = '12345678-1234-4123-8123-123456789012'
const TO = `0x${'aa'.repeat(20)}`

const ONCHAIN = [
  ['expiry', 'ExpiryEnforcer'],
  ['contract_allowlist', 'AllowedTargetsEnforcer'],
  ['selector_allowlist', 'AllowedSelectorsEnforcer'],
  ['asset_scope', 'AssetScopeEnforcer'],
  ['per_action_cap', 'PerActionCapEnforcer'],
  ['session_total_cap', 'SessionTotalCapEnforcer'],
] as const

type Limit = { kind: string; label: string; tier: 'T0' | 'T2'; enforcedBy: string | null }
type StoredConstraint = { kind: string; value: unknown; label: string; tier: string }

function harness(
  over: {
    scope?: 'venus_repay' | 'token_transfer'
    constraints?: StoredConstraint[]
    limits?: Limit[]
  } = {},
) {
  const chainId = 56 as const
  const network = {
    configured: true as const,
    chainId,
    network: 'mainnet' as const,
    audited: false,
    manager,
    guardian: guardianFor(chainId),
  }
  const constraints =
    over.constraints ??
    actionMandateConstraints({
      chainId,
      symbol: 'USDT',
      recipients: [TO],
      can: ['send'],
      perAction: 0.5,
      total: 1,
      expiresInDays: 7,
    })
  const limits: Limit[] =
    over.limits ??
    ([
      ...ONCHAIN.map(([kind, enforcedBy]) => ({
        kind,
        label: kind,
        tier: 'T0' as const,
        enforcedBy,
      })),
      { kind: 'recipient_allowlist', label: 'only to one address', tier: 'T2', enforcedBy: null },
    ] as Limit[])
  const unsigned = {
    delegate: owner,
    delegator: account,
    authority: ROOT_AUTHORITY,
    caveats: ONCHAIN.map((_entry, index) => ({
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
    limits,
    message: {
      ...unsigned,
      caveats: unsigned.caveats.map(({ enforcer, terms }) => ({ enforcer, terms })),
    },
    authorization: {
      id,
      owner,
      status: 'active' as const,
      policyHash: 'ab'.repeat(32),
      constraints,
      delegator: null as string | null,
      delegationChainId: null as number | null,
      signedAt: null as string | null,
    },
  }
  const deps: FastMandateDependencies = {
    network: async () => structuredClone(network),
    account: async () => ({ address: account, chainId }),
    prepare: async () => structuredClone(prep),
    file: async () => ({
      id,
      delegator: account,
      delegationChainId: chainId,
      signedAt: new Date().toISOString(),
      status: 'active',
    }),
    sign: async () => ({ ...unsigned, signature: '0x1234' }),
    session: () => ({ revision: 1, address: owner, signal: new AbortController().signal }),
    readWallet: async () => ({ address: owner, chainId }),
  }
  return new FastMandateController(
    {
      kind: 'sign_mandate',
      scope: over.scope ?? 'token_transfer',
      authorizationId: id,
      chainId,
      account,
      manager,
    },
    owner,
    deps,
  )
}

test('reviews a token mandate and names what it permits and where', async () => {
  const controller = harness()
  await controller.review()
  const { phase, review, error } = controller.getSnapshot()
  assert.equal(error, undefined)
  assert.equal(phase, 'review')
  assert.equal(review?.token?.symbol, 'USDT')
  assert.deepEqual(review?.token?.recipients, [TO])
  assert.equal(review?.perActionUsdt, '0.5')
  assert.equal(review?.totalUsdt, '1')
})

test('refuses a token mandate that names nowhere to send', async () => {
  const constraints = actionMandateConstraints({
    chainId: 56,
    symbol: 'USDT',
    recipients: [TO],
    can: ['send'],
    perAction: 0.5,
    total: 1,
    expiresInDays: 7,
  }).map((constraint) =>
    constraint.kind === 'recipient_allowlist' ? { ...constraint, value: [] } : constraint,
  )
  const controller = harness({ constraints })
  await controller.review()
  assert.match(String(controller.getSnapshot().error), /does not name where the money may go/)
})

test('refuses a token this network has not reviewed', async () => {
  const constraints = actionMandateConstraints({
    chainId: 56,
    symbol: 'USDT',
    recipients: [TO],
    can: ['send'],
    perAction: 0.5,
    total: 1,
    expiresInDays: 7,
  }).map((constraint) =>
    constraint.kind === 'asset_scope' || constraint.kind === 'contract_allowlist'
      ? { ...constraint, value: [`0x${'cc'.repeat(20)}`] }
      : constraint,
  )
  const controller = harness({ constraints })
  await controller.review()
  assert.match(String(controller.getSnapshot().error), /has not reviewed/)
})

test('refuses a call that is neither a transfer nor an approval', async () => {
  const constraints = actionMandateConstraints({
    chainId: 56,
    symbol: 'USDT',
    recipients: [TO],
    can: ['send'],
    perAction: 0.5,
    total: 1,
    expiresInDays: 7,
  }).map((constraint) =>
    constraint.kind === 'selector_allowlist'
      ? { ...constraint, value: ['0xdeadbeef'] }
      : constraint,
  )
  const controller = harness({ constraints })
  await controller.review()
  assert.match(String(controller.getSnapshot().error), /not a token transfer or approval/)
})

test('refuses a destination rule dressed up as one the chain holds', async () => {
  const limits: Limit[] = [
    ...ONCHAIN.map(([kind, enforcedBy]) => ({
      kind,
      label: kind,
      tier: 'T0' as const,
      enforcedBy,
    })),
    // Claiming an enforcer holds the destination is the specific lie this
    // product must never tell, so it is refused rather than rendered.
    {
      kind: 'recipient_allowlist',
      label: 'only to one address',
      tier: 'T0',
      enforcedBy: 'AllowedTargetsEnforcer',
    },
  ]
  const controller = harness({ limits })
  await controller.review()
  assert.match(String(controller.getSnapshot().error), /misreported/)
})

test('a token mandate cannot be signed by claiming it is the Venus one', async () => {
  const controller = harness({ scope: 'venus_repay' })
  await controller.review()
  // Seven constraints against the six a Venus mandate carries.
  assert.match(String(controller.getSnapshot().error), /could not be verified/)
})

test('the reviewed token uses its own decimals, not the guardian default', async () => {
  const wbnb = accountTokensFor(56).find((token) => token.symbol === 'WBNB')
  assert.ok(wbnb)
  const controller = harness({
    constraints: actionMandateConstraints({
      chainId: 56,
      symbol: 'WBNB',
      recipients: [TO],
      can: ['send', 'approve'],
      perAction: 0.25,
      total: 0.5,
      expiresInDays: 3,
    }),
  })
  await controller.review()
  const { review } = controller.getSnapshot()
  assert.equal(review?.token?.symbol, 'WBNB')
  assert.equal(review?.perActionUsdt, '0.25')
})
