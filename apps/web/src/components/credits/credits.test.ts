import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canVerifyDeposit,
  creditEntryLabel,
  creditExplorer,
  creditLimitRows,
  creditNetworkLabel,
  creditRail,
  paymentHash,
  points,
} from './credits'

const config = {
  chainId: 97,
  decimals: 6,
  finality: 'confirmations',
  token: `0x${'12'.repeat(20)}`,
  treasury: `0x${'ab'.repeat(20)}`,
  pointsPerUsdt: 10000,
  confirmations: 3,
}

test('only a fully configured rail with matching token units is offered', () => {
  assert.deepEqual(creditRail(config), config)
  for (const invalid of [
    null,
    {},
    [],
    { ...config, available: false },
    { ...config, chainId: 56 },
    { ...config, chainId: '97' },
    { ...config, chainId: 1 },
    { ...config, decimals: undefined },
    { ...config, decimals: 18 },
    { ...config, finality: undefined },
    { ...config, finality: 'finalized' },
    { ...config, token: '' },
    { ...config, treasury: 'https://example.test' },
    { ...config, token: `0x${'0'.repeat(40)}` },
    { ...config, pointsPerUsdt: 0 },
    { ...config, pointsPerUsdt: Number.NaN },
    { ...config, pointsPerUsdt: 100.5 },
    { ...config, confirmations: undefined },
    { ...config, confirmations: 0 },
  ])
    assert.equal(creditRail(invalid), null)
})

test('mainnet USDT requires eighteen decimals and uses mainnet labels and links', () => {
  const mainnet = {
    ...config,
    chainId: 56,
    decimals: 18,
    finality: 'finalized',
    token: '0x55d398326f99059ff775485246999027b3197955',
  }
  const rail = creditRail(mainnet)
  assert.ok(rail)
  assert.deepEqual(rail, mainnet)
  assert.equal(creditNetworkLabel(rail), 'BNB Smart Chain Mainnet')
  assert.equal(creditExplorer(rail), 'https://bscscan.com')
  assert.equal(creditRail({ ...mainnet, decimals: 6 }), null)
  assert.equal(creditRail({ ...mainnet, token: config.token }), null)
  const testnet = creditRail(config)
  assert.ok(testnet)
  assert.equal(creditNetworkLabel(testnet), 'BNB Smart Chain Testnet')
  assert.equal(creditExplorer(testnet), 'https://testnet.bscscan.com')
})

test('disconnected, unconfigured, and treasury self-funding cannot verify purchases', () => {
  const rail = creditRail(config)
  assert.equal(canVerifyDeposit(rail, `0x${'34'.repeat(20)}`), true)
  assert.equal(canVerifyDeposit(rail, ''), false)
  assert.equal(canVerifyDeposit(null, `0x${'34'.repeat(20)}`), false)
  assert.equal(canVerifyDeposit(rail, `0x${'AB'.repeat(20)}`), false)
})

test('payment verification takes only a complete hash, preserved for safe retries', () => {
  const hash = `0x${'AB'.repeat(32)}`
  assert.equal(paymentHash(` ${hash} `), hash.toLowerCase())
  for (const invalid of ['', '0x123', `https://bscscan.com/tx/${hash}`, `0x${'z'.repeat(64)}`])
    assert.throws(() => paymentHash(invalid))
})

test('point counts keep exact integer precision, signs and a safe invalid state', () => {
  assert.equal(points(0), '0')
  assert.equal(points(-0, true), '0')
  assert.equal(points(1234567), '1,234,567')
  assert.equal(points(49, true), '+49')
  assert.equal(points(-49, true), '-49')
  for (const invalid of [undefined, null, Infinity, NaN, 0.1, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(points(invalid), '--')
})

test('limits come from the server, not UI assumptions or unavailable data', () => {
  assert.deepEqual(creditLimitRows(undefined), [])
  const rows = creditLimitRows({
    walletPerMinute: 3,
    walletConcurrent: 1,
    walletDailyPoints: 9000,
    globalDailyPoints: 80000,
    globalConcurrent: 4,
    maximumTurnPoints: 700,
    leaseSeconds: 60,
    welcomePoints: 5000,
    welcomeGrantsPerDay: 200,
  })
  assert.deepEqual(
    rows.map((row) => row.value),
    ['3', '1', '700 points', '9,000 points', '80,000 points', '4'],
  )
})

test('holds and returns are described separately rather than called completed charges', () => {
  assert.equal(creditEntryLabel('fast_mode_hold', -2000), 'Reserved for a Fast turn')
  assert.equal(creditEntryLabel('fast_mode_hold', 1951), 'Unused Fast points returned')
  assert.equal(creditEntryLabel('fast_mode', -49), 'Fast mode usage')
  assert.equal(creditEntryLabel('new_backend_reason', 1), 'Points adjustment')
})
