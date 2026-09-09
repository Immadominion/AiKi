import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { MANDATE_ACCOUNT_BYTECODE } from './bytecode.js'
import { ACCOUNT_MANAGER_OFFSETS, ACCOUNT_RUNTIME_OFFSET } from './runtime.js'

/**
 * A committed copy of compiled bytecode is a constant that can go stale, and the
 * failure mode is not a broken build: it is a fleet of accounts running code
 * nobody reviewed, deployed by an API that believed it was deploying something
 * else. So the copy is compared against the artifact whenever forge has run.
 *
 * Skips where `onchain/out` is absent, which is every container this ships in,
 * and never skips in CI, where forge test runs first.
 */
it('is the bytecode the contract actually compiles to', () => {
  const path = new URL(
    '../../../../onchain/out/AiKiMandateAccount.sol/AiKiMandateAccount.json',
    import.meta.url,
  )
  let artifact: {
    bytecode: { object: string }
    deployedBytecode: {
      object: string
      immutableReferences: Record<string, { start: number; length: number }[]>
    }
  }
  try {
    artifact = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return
  }
  const compiled = artifact.bytecode.object.startsWith('0x')
    ? artifact.bytecode.object
    : `0x${artifact.bytecode.object}`
  expect(MANDATE_ACCOUNT_BYTECODE).toBe(compiled)
  const runtime = artifact.deployedBytecode.object.replace(/^0x/, '')
  expect(MANDATE_ACCOUNT_BYTECODE.slice(2 + ACCOUNT_RUNTIME_OFFSET * 2)).toBe(runtime)
  expect(Object.values(artifact.deployedBytecode.immutableReferences).flat()).toEqual(
    ACCOUNT_MANAGER_OFFSETS.map((start) => ({ start, length: 32 })),
  )
})

it('is creation bytecode, not runtime', () => {
  // Deploying runtime bytecode produces a contract with no constructor run, so
  // `owner` would be the zero address and the account would belong to nobody.
  // Creation bytecode ends in the constructor's argument handling, and is longer
  // than the runtime it returns.
  expect(MANDATE_ACCOUNT_BYTECODE.startsWith('0x')).toBe(true)
  expect(MANDATE_ACCOUNT_BYTECODE.length).toBeGreaterThan(1000)
})
