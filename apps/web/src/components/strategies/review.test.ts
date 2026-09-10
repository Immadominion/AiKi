// biome-ignore-all lint/style/noNonNullAssertion: fixture creates exactly one action and one asset for negative tests.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ProjectedPassport } from '@aiki/contracts'
import { delegationMessage } from '@aiki/contracts/delegation'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { encodeAbiParameters, encodeFunctionData, hashTypedData, parseAbi } from 'viem'
import { PolicyForm } from './PolicyForm'
import { buildStrategyInput, rawAmount, StrategyFieldError, strategyGasLimitWei } from './policy'
import { assertConfig, assertStrategySigning, assertWalletAction } from './review'
import { strategyForPassport } from './StrategyHireChoice'
import {
  addressAt,
  authorizationFixture,
  config,
  controller,
  filledValues,
  owner,
  setupFixture,
  vault,
} from './test-support'

test('both mainnet tokens use exact 18-decimal amounts, never rounding excess precision', () => {
  assert.equal(rawAmount('0.000000000000000001', 'USDT'), '1')
  assert.equal(rawAmount('123.456789012345678901', 'USDT'), '123456789012345678901')
  for (const value of ['1.0000000000000000001', '1e3', '-1', ' 1', '01', 'NaN', 'Infinity'])
    assert.throws(() => rawAmount(value, 'USDT'))
  const values = filledValues('yield')
  const a = buildStrategyInput('yield', controller, values, [], 2000000000n)
  const b = buildStrategyInput('yield', controller, values, [], 2000000010n, a.common.expiresAt)
  assert.deepEqual(a, b)
  assert.equal(a.kind === 'yield' && a.policy.maxPrincipal, '10250000000000000000')
  assert.throws(() =>
    buildStrategyInput('yield', controller, { ...values, maxLossBps: '10001' }, [], 1n),
  )
  assert.throws(() =>
    buildStrategyInput(
      'yield',
      controller,
      values,
      [],
      BigInt(a.common.expiresAt),
      a.common.expiresAt,
    ),
  )
})
test('gas ceiling accepts exact positive wei through 0.001 BNB and identifies invalid input', () => {
  assert.equal(strategyGasLimitWei('0.000000000000000001'), '1')
  assert.equal(strategyGasLimitWei('0.001'), '1000000000000000')
  for (const value of ['0', '0.001000000000000001', '0.005', '1e-3', ' 0.001', 'NaN']) {
    assert.throws(
      () => strategyGasLimitWei(value),
      (error: unknown) => error instanceof StrategyFieldError && error.field === 'gasLimitBnb',
    )
  }
})
test('all strategy forms disclose the gas ceiling and associate its error with the input', () => {
  for (const kind of ['yield', 'grid', 'lp'] as const) {
    const html = renderToStaticMarkup(
      createElement(PolicyForm, {
        kind,
        values: { ...filledValues(kind), gasLimitBnb: '0.005' },
        rungs: [],
        onValues: () => {},
        onRungs: () => {},
        onSubmit: () => {},
        busy: false,
        blocked: false,
        problem: {
          field: 'gasLimitBnb',
          message: 'Choose a network gas ceiling up to 0.001 BNB.',
        },
      }),
    )
    assert.match(html, /Maximum 0\.001 BNB\./)
    assert.match(html, /<input[^>]*id="strategy-gasLimitBnb"[^>]*aria-invalid="true"/)
    assert.match(html, /aria-describedby="strategy-gasLimitBnb-error"/)
    assert.match(html, /id="strategy-gasLimitBnb-error" role="alert"/)
  }
})
test('grid input preserves token-specific quantities and bounds rung count/integer ticks', () => {
  const rung = { buyTick: '-100', sellTick: '100', lot0: '1.25', lot1: '0.0005', initialSell: true }
  const result = buildStrategyInput('grid', controller, filledValues('grid'), [rung], 1n)
  assert.equal(result.kind, 'grid')
  if (result.kind !== 'grid') return
  assert.equal(result.rungs[0]?.lot0, '1250000000000000000')
  assert.equal(result.rungs[0]?.lot1, '500000000000000')
  assert.throws(() =>
    buildStrategyInput('grid', controller, filledValues('grid'), Array(33).fill(rung), 1n),
  )
  assert.throws(() =>
    buildStrategyInput('grid', controller, filledValues('grid'), [{ ...rung, buyTick: '-0' }], 1n),
  )
})
test('wallet action decode refuses unreviewed native value, target, amount and calldata suffix', () => {
  const setup = setupFixture(),
    action = setup.actions[0]!
  assert.doesNotThrow(() => assertWalletAction(action, setup, config))
  for (const change of [
    { value: '1' },
    { to: owner },
    { from: vault },
    { chainId: 97 },
    { data: `${action.transaction.data}00` },
  ]) {
    assert.throws(() =>
      assertWalletAction(
        { ...action, transaction: { ...action.transaction, ...change } } as typeof action,
        setup,
        config,
      ),
    )
  }
  assert.throws(() =>
    assertWalletAction(
      {
        ...action,
        review: { ...action.review, assets: [{ ...action.review.assets![0]!, amount: '2' }] },
      },
      setup,
      config,
    ),
  )
})
test('exact approval never allows foreign spender or token', () => {
  const setup = setupFixture(),
    base = setup.actions[0]!
  const approve = {
    ...base,
    kind: 'approve' as const,
    transaction: {
      ...base.transaction,
      to: base.review.assets![0]!.token,
      data: encodeFunctionData({
        abi: parseAbi(['function approve(address,uint256)']),
        functionName: 'approve',
        args: [vault, 10n ** 18n],
      }),
    },
  }
  assert.doesNotThrow(() => assertWalletAction(approve, setup, config))
  assert.throws(() =>
    assertWalletAction(
      {
        ...approve,
        transaction: {
          ...approve.transaction,
          data: encodeFunctionData({
            abi: parseAbi(['function approve(address,uint256)']),
            functionName: 'approve',
            args: [owner, 10n ** 18n],
          }),
        },
      },
      setup,
      config,
    ),
  )
  assert.throws(() =>
    assertWalletAction(
      { ...approve, transaction: { ...approve.transaction, to: addressAt('fe') } },
      setup,
      config,
    ),
  )
})
test('configuration and narrow grant must match the exact policy, manager, account and executor', () => {
  const setup = setupFixture(),
    prep = authorizationFixture(setup)
  assert.doesNotThrow(() => assertStrategySigning(prep, setup, config))
  assert.throws(() => assertConfig({ ...config, factories: {} }))
  for (const changed of [
    { ...prep, domain: { ...prep.domain, chainId: 97 } },
    { ...prep, review: { ...prep.review, gasLimitWei: '999' } },
    { ...prep, unsigned: { ...prep.unsigned, delegate: owner } },
    { ...prep, unsigned: { ...prep.unsigned, caveats: [] } },
    {
      ...prep,
      unsigned: { ...prep.unsigned, caveats: [...prep.unsigned.caveats, ...prep.unsigned.caveats] },
    },
    { ...prep, message: { ...prep.message, delegator: owner } },
  ])
    assert.throws(() => assertStrategySigning(changed as typeof prep, setup, config))
})
test('catalogue automation requires configured exact chain/registry/token identity and reciprocal proof', () => {
  const passport = {
    agentId: '315944',
    chainId: 56,
    registry: addressAt('ab'),
    liveness: 'LIVE',
    identity: {
      tokenId: '315944',
      registrationFile: { resolved: true, reciprocalProofVerified: true },
    },
  } as ProjectedPassport
  const mapped = {
    ...config,
    agents: { yield: { agentId: '315944', chainId: 56 as const, registry: addressAt('ab') } },
  }
  assert.equal(strategyForPassport(passport, mapped), 'yield')
  assert.equal(
    strategyForPassport(passport, {
      available: false,
      chainId: 56,
      reason: 'Not deployed',
      agents: mapped.agents,
    }),
    'yield',
  )
  for (const changed of [
    { ...passport, agentId: '999' },
    { ...passport, chainId: 97 },
    { ...passport, registry: owner },
    { ...passport, liveness: 'UNPROBED' },
    { ...passport, identity: { ...passport.identity, tokenId: '999' } },
  ])
    assert.equal(strategyForPassport(changed as ProjectedPassport, mapped), null)
  assert.equal(strategyForPassport(passport, config), null)
})

test('strategy mandate requires the exact ordered expiry and binding caveats, not a broad or altered grant', () => {
  const setup = setupFixture(),
    prep = authorizationFixture(setup)
  const expiry = prep.unsigned.caveats[0]!,
    binding = prep.unsigned.caveats[1]!
  for (const caveats of [
    [binding],
    [binding, expiry],
    [expiry, binding, expiry],
    [{ ...expiry, enforcer: owner }, binding],
    [
      {
        ...expiry,
        terms: encodeAbiParameters(
          [{ type: 'uint256' }],
          [BigInt(setup.input.common.expiresAt) + 1n],
        ),
      },
      binding,
    ],
    [{ ...expiry, args: '0x00' as const }, binding],
    [expiry, { ...binding, args: '0x00' as const }],
  ]) {
    const unsigned = { ...prep.unsigned, caveats },
      message = delegationMessage(unsigned)
    const changed = {
      ...prep,
      unsigned,
      message: { ...message, salt: unsigned.salt, epoch: unsigned.epoch },
      digest: hashTypedData({
        domain: prep.domain,
        types: prep.types,
        primaryType: 'Delegation',
        message,
      }),
    }
    assert.throws(() => assertStrategySigning(changed, setup, config))
  }
})
