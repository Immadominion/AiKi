import assert from 'node:assert/strict'
import { test } from 'node:test'
import { guardianFor } from '@aiki/contracts/guardian'
import { venusGuardianFor } from './venus'

test('mainnet watches select the mainnet Venus USDT market and underlying token', () => {
  const config = venusGuardianFor(56)
  assert.equal(config.chainId, 56)
  assert.equal(config.decimals, 18)
  assert.equal(config.asset.toLowerCase(), '0x55d398326f99059ff775485246999027b3197955')
  assert.equal(config.market.toLowerCase(), '0xfd5840cd36d94d7229439859c0112a4185bc0255')
})

test('testnet watches remain separate and unknown networks never fall back to testnet', () => {
  assert.equal(venusGuardianFor(97).chainId, 97)
  assert.notEqual(venusGuardianFor(56).asset, venusGuardianFor(97).asset)
  assert.notEqual(venusGuardianFor(56).market, venusGuardianFor(97).market)
  assert.throws(() => venusGuardianFor(1), /not supported/)
  for (const chainId of [56, 97]) {
    const web = venusGuardianFor(chainId)
    const shared = guardianFor(chainId)
    assert.equal(web.asset, shared.asset)
    assert.equal(web.market, shared.market)
    assert.equal(web.decimals, shared.decimals)
  }
})
