import { describe, expect, it } from 'vitest'
import { decodeRegistered } from './registry.js'

function encodedString(value: string): string {
  const content = Buffer.from(value, 'utf8').toString('hex')
  return `0x${(32n).toString(16).padStart(64, '0')}${BigInt(value.length).toString(16).padStart(64, '0')}${content.padEnd(Math.ceil(content.length / 64) * 64, '0')}`
}

describe('decodeRegistered', () => {
  it('preserves the chain log identity and decodes the registration URI', () => {
    const decoded = decodeRegistered({
      topics: [
        '0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a',
        `0x${(42n).toString(16).padStart(64, '0')}`,
        '0x0000000000000000000000001234567890123456789012345678901234567890',
      ],
      data: encodedString('https://agent.example/registration.json'),
      blockNumber: '0x4b',
      logIndex: '0x2',
      transactionHash: `0x${'ab'.repeat(32)}`,
    })
    expect(decoded).toEqual({
      agentId: '42',
      owner: '0x1234567890123456789012345678901234567890',
      agentURI: 'https://agent.example/registration.json',
      blockNumber: 75,
      logIndex: 2,
      txHash: `0x${'ab'.repeat(32)}`,
    })
  })
})
