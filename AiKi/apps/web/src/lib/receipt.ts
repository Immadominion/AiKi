import type { Receipt } from '@aiki/contracts'

const usdt = (whole: string, usd: string) => ({
  amount: whole,
  asset: 'USDT',
  decimals: 18,
  displayUsd: usd,
})

/**
 * A signed record of what happened.
 *
 * Profiled on SCITT (RFC 9943) and COSE Receipts (RFC 9942) rather than a format
 * of our own, so anyone can verify it with off-the-shelf tooling and never has to
 * trust AiKi to check AiKi. `mandateHash` binds the work to the authority it was
 * done under, which is the part a screenshot of a transaction can never show.
 */
export const RECEIPT: Receipt = {
  receiptId: 'rcp_01J8',
  jobId: 'job_01J8',
  agent: {
    id: 'agt_guardian',
    chainId: 56,
    registry: '0x8004A169Ed1B9D2c6b0d6e9F65b09Ee2f5a71C43',
    agentId: '50285',
    name: 'Guardian',
  },
  agentVersion: '2.4.1',
  mandateHash: '0x41c7e0b93a6d2f58e17b04c9d3a825f6017be94c2d5a3806f19e47b0c8d251af',
  authorizationId: 'aut_01J8',
  actions: [
    {
      type: 'Repaid 72 USDT to Venus',
      txHash: '0x8f2c41a7d93b06e5c8147ab29f0d63e5b41c907a2ed85f36b10c47592a8ef3d1',
      policyDecision: 'allow',
      at: '2026-08-22T02:39:02Z',
      gas: { amount: '211000000000000', asset: 'BNB', decimals: 18, displayUsd: '0.06' },
    },
    {
      // Kept on purpose. A receipt that only lists what succeeded is a brochure.
      type: 'Refused: repay 91.20 USDT — over the $80 per-action limit',
      policyDecision: 'deny',
      at: '2026-08-22T02:41:12Z',
    },
    {
      type: 'Repaid 45.60 USDT to Venus',
      txHash: '0x2d90ba47f6e138c05a72e94db63f810c5ae27309f4b16d8a05c3e71b924fd680',
      policyDecision: 'allow',
      at: '2026-08-22T02:41:31Z',
      gas: { amount: '208000000000000', asset: 'BNB', decimals: 18, displayUsd: '0.06' },
    },
  ],
  cost: {
    provider: usdt('2000000000000000000', '2.00'),
    platform: usdt('100000000000000000', '0.10'),
    network: { amount: '419000000000000', asset: 'BNB', decimals: 18, displayUsd: '0.12' },
    total: usdt('2220000000000000000', '2.22'),
  },
  output: {
    artifactHash: '0x7be0134a9c25d8f60e3b17a4926cd05f8134be27a90e6df15c48b302719ea5cd',
    summary:
      'Health factor moved from 1.19 to 1.51 and stayed above your 1.25 floor for the rest of the day.',
  },
  evaluation: {
    status: 'accepted',
    evaluator: 'aiki:outcome-evaluator',
    evaluatorVersion: '1.2.0',
  },
  settlement: {
    status: 'settled',
    txHash: '0xb15e7d4a03c96f28e5710bd4a862c3f09e17d5b840a29c6e3fb075192dc84a67',
    amount: usdt('2220000000000000000', '2.22'),
  },
  signature: {
    alg: 'ES256',
    value:
      'MEUCIQD4kq2mXbA9tR0nZ7cV1sPjLw6hE8vYuK3fN2aQoW5xTgIgS9dR7yBmC0eH4iJ1kL6nO8pQ3rU5vW7xY9zA2bD4cF8',
    verifyUrl: 'https://useaiki.xyz/verify/rcp_01J8',
  },
  startedAt: '2026-08-22T02:36:00Z',
  completedAt: '2026-08-22T02:41:44Z',
}
