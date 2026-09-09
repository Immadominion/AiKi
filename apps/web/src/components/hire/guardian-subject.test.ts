import assert from 'node:assert/strict'
import { test } from 'node:test'
import { guardianFor } from '@aiki/contracts/guardian'
import { mandateConstraints } from './mandate'
import { hireSubjectFromFixture } from './subject'

test('Manual Guardian signs the configured Venus repayment scope, not token transfers', () => {
  for (const chainId of [56, 97]) {
    const guardian = guardianFor(chainId)
    const network = {
      configured: true as const,
      chainId: guardian.chainId,
      network: guardian.network,
      audited: false,
      manager: `0x${'11'.repeat(20)}` as `0x${string}`,
      guardian,
    }
    const subject = hireSubjectFromFixture('guardian', network)
    const constraints = mandateConstraints({
      capCents: 25_000,
      perActionCents: 8_000,
      days: 90,
      approval: { mode: 'automatic', thresholdCents: 2_000 },
      spends: subject.spends,
      callScope: subject.callScope,
    })
    const value = (kind: string) => constraints.find((c) => c.kind === kind)?.value
    assert.deepEqual(value('selector_allowlist'), [guardian.repayBorrowSelector])
    assert.deepEqual(value('contract_allowlist'), [guardian.market])
    assert.deepEqual(value('asset_scope'), [guardian.asset])
    assert.equal(value('session_total_cap'), (250n * 10n ** BigInt(guardian.decimals)).toString())
  }
})
